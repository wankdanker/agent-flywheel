// Our thin GitHub REST client for one issue.
import { STATE_LABELS, toComment, withMarker, type Tracker } from "./tracker.ts";
import { trustFromGithubAssociation } from "./trust.ts";

export function githubTracker(o: { token: string; repo: string; issue: number; apiUrl?: string }): Tracker {
  const apiUrl = o.apiUrl ?? "https://api.github.com";
  const issue = `/issues/${o.issue}`;

  async function gh(path: string, init: RequestInit = {}) {
    const res = await fetch(`${apiUrl}/repos/${o.repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${o.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  return {
    platform: "github",

    async repo() {
      const r = await gh("");
      return { cloneUrl: r.clone_url, webUrl: r.html_url, defaultBranch: r.default_branch };
    },

    async getTicket() {
      const [i, comments] = await Promise.all([gh(issue), gh(`${issue}/comments?per_page=100`)]);
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
  };
}
