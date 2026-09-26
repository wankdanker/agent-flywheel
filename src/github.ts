// Our thin GitHub REST client for one issue.
import { OPT_IN_LABEL, STATE_LABELS, toComment, withMarker, type Tracker } from "./tracker.ts";
import { trustFromGithubAssociation } from "./trust.ts";

// A runaway-loop guard, not a thread-size limit: 1000 pages of 100 is far past any real issue.
const MAX_PAGES = 1000;

// The `rel="next"` URL from a GitHub `Link` header, if any.
export function nextLink(link: string | null): string | undefined {
  for (const part of link?.split(",") ?? []) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return undefined;
}

export function githubTracker(o: { token: string; repo: string; issue: number; apiUrl?: string }): Tracker {
  const apiUrl = o.apiUrl ?? "https://api.github.com";
  const issue = `/issues/${o.issue}`;

  async function request(url: string, init: RequestInit, label: string) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${o.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${label}: ${res.status} ${await res.text()}`);
    return res;
  }

  async function gh(path: string, init: RequestInit = {}) {
    return (await request(`${apiUrl}/repos/${o.repo}${path}`, init, path)).json();
  }

  // Every page of a list endpoint, in the API's order, following `Link: <…>; rel="next"`
  // until there is none. Any failed page throws: a partial thread is worse than no run.
  async function ghAll(path: string): Promise<any[]> {
    const items: any[] = [];
    let url: string | undefined = `${apiUrl}/repos/${o.repo}${path}`;
    for (let page = 1; url; page++) {
      if (page > MAX_PAGES) throw new Error(`GitHub GET ${path}: more than ${MAX_PAGES} pages, refusing to continue`);
      // The token goes wherever `next` points, so it has to stay on our API host.
      if (!url.startsWith(`${apiUrl}/`)) throw new Error(`GitHub GET ${path}: next page ${url} is outside ${apiUrl}`);
      const res = await request(url, {}, `${path} (page ${page})`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error(`GitHub GET ${path} (page ${page}): expected an array`);
      items.push(...body);
      url = nextLink(res.headers.get("link"));
    }
    return items;
  }

  return {
    platform: "github",

    async repo() {
      const r = await gh("");
      return { cloneUrl: r.clone_url, webUrl: r.html_url, defaultBranch: r.default_branch };
    },

    async getTicket() {
      const [i, comments] = await Promise.all([gh(issue), ghAll(`${issue}/comments?per_page=100`)]);
      return {
        number: i.number,
        url: i.html_url,
        title: i.title,
        body: i.body ?? "",
        author: i.user.login,
        trust: trustFromGithubAssociation(i.author_association),
        labels: i.labels.map((l: any) => l.name),
        comments: comments.map((c: any) =>
          toComment(c.user.login, c.body ?? "", c.created_at, trustFromGithubAssociation(c.author_association), c.user?.type === "Bot"),
        ),
      };
    },

    async comment(text) {
      await gh(`${issue}/comments`, { method: "POST", body: JSON.stringify({ body: withMarker(text) }) });
    },

    // Exactly one state label at a time; everything else on the issue is left alone.
    async setState(state) {
      const i = await gh(issue);
      const states: string[] = Object.values(STATE_LABELS);
      const labels = i.labels.map((l: any) => l.name).filter((n: string) => !states.includes(n));
      await gh(issue, { method: "PATCH", body: JSON.stringify({ labels: [...labels, STATE_LABELS[state]] }) });
    },

    // Two calls, not one create-with-labels: GitHub doesn't fire a `labeled` webhook event
    // for labels included in the creation payload, only `opened` — and agent.yml only
    // triggers on `labeled`. Adding the label as a follow-up guarantees the new run starts.
    async createSubIssue({ title, body }) {
      const created = await gh("/issues", { method: "POST", body: JSON.stringify({ title, body }) });
      await gh(`/issues/${created.number}/labels`, { method: "POST", body: JSON.stringify({ labels: [OPT_IN_LABEL] }) });
      return { number: created.number, url: created.html_url };
    },
  };
}
