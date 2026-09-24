// Our thin GitLab REST client for one issue.
import { STATE_LABELS, toComment, withMarker, type Tracker } from "./tracker.ts";

// `project` is a numeric id or a `group/project` path.
export function gitlabTracker(o: { token: string; apiUrl: string; project: string; issue: number }): Tracker {
  const issue = `/issues/${o.issue}`;

  async function gl(path: string, init: RequestInit = {}) {
    const res = await fetch(`${o.apiUrl}/projects/${encodeURIComponent(o.project)}${path}`, {
      ...init,
      headers: { "PRIVATE-TOKEN": o.token, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`GitLab ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  return {
    platform: "gitlab",

    async repo() {
      const p = await gl("");
      return { cloneUrl: p.http_url_to_repo, webUrl: p.web_url, defaultBranch: p.default_branch };
    },

    async getTicket() {
      const [i, notes] = await Promise.all([gl(issue), gl(`${issue}/notes?sort=asc&order_by=created_at&per_page=100`)]);
      return {
        number: i.iid,
        url: i.web_url,
        title: i.title,
        body: i.description ?? "",
        labels: i.labels,
        // System notes are GitLab's own "added label X" lines, not conversation.
        comments: notes.filter((n: any) => !n.system).map((n: any) => toComment(n.author.username, n.body, n.created_at)),
      };
    },

    async comment(text) {
      await gl(`${issue}/notes`, { method: "POST", body: JSON.stringify({ body: withMarker(text) }) });
    },

    async setState(state) {
      const others = Object.values(STATE_LABELS).filter((l) => l !== STATE_LABELS[state]);
      await gl(issue, { method: "PUT", body: JSON.stringify({ add_labels: STATE_LABELS[state], remove_labels: others.join(",") }) });
    },
  };
}
