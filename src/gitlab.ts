// Our thin GitLab REST client for one issue.
import { OPT_IN_LABEL, STATE_LABELS, toComment, withMarker, type Tracker } from "./tracker.ts";
import { gitlabMemberTrust, type Trust } from "./trust.ts";

// A runaway-loop guard, not a thread-size limit: 1000 pages of 100 is far past any real issue.
const MAX_PAGES = 1000;

// `project` is a numeric id or a `group/project` path.
export function gitlabTracker(o: { token: string; apiUrl: string; project: string; issue: number }): Tracker {
  const issue = `/issues/${o.issue}`;

  async function request(path: string, init: RequestInit = {}) {
    const res = await fetch(`${o.apiUrl}/projects/${encodeURIComponent(o.project)}${path}`, {
      ...init,
      headers: { "PRIVATE-TOKEN": o.token, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`GitLab ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res;
  }

  async function gl(path: string, init: RequestInit = {}) {
    return (await request(path, init)).json();
  }

  // Every page of a list endpoint, in the API's order, following `x-next-page` (blank on
  // the last page). `path` keeps its own query (sort, per_page); only `page` is added.
  // Any failed page throws: a partial thread is worse than no run.
  async function glAll(path: string): Promise<any[]> {
    const items: any[] = [];
    const sep = path.includes("?") ? "&" : "?";
    let page: string | null = "1";
    for (let n = 1; page; n++) {
      if (n > MAX_PAGES) throw new Error(`GitLab GET ${path}: more than ${MAX_PAGES} pages, refusing to continue`);
      const res = await request(`${path}${sep}page=${encodeURIComponent(page)}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error(`GitLab GET ${path} (page ${page}): expected an array`);
      items.push(...body);
      // Absent (not just blank) means we can't tell whether more pages exist; fail loudly
      // rather than silently treat page 1 as the whole thread.
      const next = res.headers.get("x-next-page");
      if (next === null) throw new Error(`GitLab GET ${path} (page ${page}): response has no x-next-page header`);
      page = next.trim() || null;
    }
    return items;
  }

  // GitLab notes/issues carry an author id, not a ready-made trust level like GitHub's
  // `author_association`; resolving it means a members-API call per author. Cache by user
  // id so one ticket fetch with N comments from the same person costs one lookup, not N.
  const membership = new Map<number, Promise<Trust>>();
  function trustOf(userId: number): Promise<Trust> {
    if (!membership.has(userId)) {
      membership.set(userId, gitlabMemberTrust({ apiUrl: o.apiUrl, project: o.project, token: o.token, userId }));
    }
    return membership.get(userId)!;
  }

  return {
    platform: "gitlab",

    async repo() {
      const p = await gl("");
      return { cloneUrl: p.http_url_to_repo, webUrl: p.web_url, defaultBranch: p.default_branch };
    },

    async getTicket() {
      const [i, notes] = await Promise.all([gl(issue), glAll(`${issue}/notes?sort=asc&order_by=created_at&per_page=100`)]);
      // System notes are GitLab's own "added label X" lines, not conversation.
      const humanNotes = notes.filter((n: any) => !n.system);
      const [authorTrust, noteTrusts] = await Promise.all([
        trustOf(i.author.id),
        Promise.all(humanNotes.map((n: any) => trustOf(n.author.id))),
      ]);
      return {
        number: i.iid,
        url: i.web_url,
        title: i.title,
        body: i.description ?? "",
        author: i.author.username,
        trust: authorTrust,
        labels: i.labels,
        comments: humanNotes.map((n: any, idx: number) => toComment(n.author.username, n.body, n.created_at, noteTrusts[idx])),
      };
    },

    async comment(text) {
      await gl(`${issue}/notes`, { method: "POST", body: JSON.stringify({ body: withMarker(text) }) });
    },

    async setState(state) {
      const others = Object.values(STATE_LABELS).filter((l) => l !== STATE_LABELS[state]);
      await gl(issue, { method: "PUT", body: JSON.stringify({ add_labels: STATE_LABELS[state], remove_labels: others.join(",") }) });
    },

    // Unlike GitHub, dispatch-gitlab.ts treats any newly-opened issue that already carries
    // `agent` as actionable, so one create call (label included) is enough to start a run.
    async createSubIssue({ title, body }) {
      const created = await gl("/issues", { method: "POST", body: JSON.stringify({ title, description: body, labels: OPT_IN_LABEL }) });
      return { number: created.iid, url: created.web_url };
    },
  };
}
