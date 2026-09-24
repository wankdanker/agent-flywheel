// Our thin GitLab REST client for one issue.
import { STATE_LABELS, toComment, withMarker, type Tracker } from "./tracker.ts";
import { gitlabMemberTrust, type Trust } from "./trust.ts";

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
      const [i, notes] = await Promise.all([gl(issue), gl(`${issue}/notes?sort=asc&order_by=created_at&per_page=100`)]);
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
  };
}
