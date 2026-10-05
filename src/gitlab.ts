// Our thin GitLab REST client for one issue.
import { OPT_IN_LABEL, STATE_LABELS, toComment, withMarker, type ChainForge, type Tracker } from "./tracker.ts";
import { gitlabMemberTrust, type Trust } from "./trust.ts";

// A runaway-loop guard, not a thread-size limit: 1000 pages of 100 is far past any real issue.
const MAX_PAGES = 1000;

// `project` is a numeric id or a `group/project` path.
type Project = { token: string; apiUrl: string; project: string };

// `okStatus` are statuses that aren't errors to this caller; the response comes back either way.
function projectApi(o: Project) {
  async function request(path: string, init: RequestInit = {}, okStatus: number[] = []) {
    const res = await fetch(`${o.apiUrl}/projects/${encodeURIComponent(o.project)}${path}`, {
      ...init,
      headers: { "PRIVATE-TOKEN": o.token, "Content-Type": "application/json" },
    });
    if (!res.ok && !okStatus.includes(res.status)) throw new Error(`GitLab ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res;
  }
  const gl = async (path: string, init: RequestInit = {}) => (await request(path, init)).json();
  return { request, gl };
}

// `code` is the project the code-host calls act on (see Tracker#retarget); the issue's own by default.
export function gitlabTracker(o: Project & { issue: number; code?: string }): Tracker {
  const issue = `/issues/${o.issue}`;
  const { request, gl } = projectApi(o);
  const codeApi = o.code === undefined ? { request, gl } : projectApi({ ...o, project: o.code });

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
      const p = await codeApi.gl("");
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
    // A queued one gets `agent/queued` instead, which dispatch ignores.
    async createSubIssue({ title, body, runnable, parent, blockedBy }) {
      const labels = runnable ? OPT_IN_LABEL : STATE_LABELS.queued;
      const created = await gl("/issues", { method: "POST", body: JSON.stringify({ title, description: body, labels }) });
      // Native links are a nicety on top of the chain header (src/chain.ts): logged, not fatal.
      const link = async (from: number, type: string) => {
        try {
          await gl(`/issues/${from}/links`, {
            method: "POST",
            body: JSON.stringify({ target_project_id: created.project_id, target_issue_iid: created.iid, link_type: type }),
          });
        } catch (err) {
          console.error(`[gitlab] couldn't link #${from} to #${created.iid} (the issue body still records it):`, err instanceof Error ? err.message : err);
        }
      };
      await link(parent, "relates_to");
      if (blockedBy) await link(blockedBy, "blocks");
      return { number: created.iid, url: created.web_url };
    },

    async ensureBranch(branch, from) {
      const res = await codeApi.request(`/repository/branches/${encodeURIComponent(branch)}`, {}, [404]);
      if (res.ok) return false;
      await codeApi.gl(`/repository/branches?branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(from)}`, { method: "POST" });
      return true;
    },

    // Pushing the branch already updated an open MR; only open one if there isn't one yet.
    async openReview({ branch, base, title, body }) {
      const open = await codeApi.gl(`/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`);
      if (Array.isArray(open) && open.length) return { url: open[0].web_url, created: false };
      const mr = await codeApi.gl("/merge_requests", {
        method: "POST",
        body: JSON.stringify({ source_branch: branch, target_branch: base, title, description: body }),
      });
      return { url: mr.web_url, created: true };
    },

    // A pipeline on the default branch with ISSUE and AGENT_TRIGGER=relay set, which
    // .gitlab/ci/agent.yml's rules hand to bin/dispatch-gitlab.ts like a manual run.
    async dispatchRelay() {
      const p = await gl("");
      await gl("/pipeline", {
        method: "POST",
        body: JSON.stringify({
          ref: p.default_branch,
          variables: [{ key: "ISSUE", value: String(o.issue) }, { key: "AGENT_TRIGGER", value: "relay" }],
        }),
      });
    },

    retarget: (path) => gitlabTracker({ ...o, code: path }),
  };
}

export function gitlabChain(o: Project): ChainForge {
  const { request, gl } = projectApi(o);
  const membership = new Map<number, Promise<Trust>>();
  const trustOf = (userId: number) => {
    if (!membership.has(userId)) membership.set(userId, gitlabMemberTrust({ ...o, userId }));
    return membership.get(userId)!;
  };
  return {
    tracker: (issue) => gitlabTracker({ ...o, issue }),

    async listQueued() {
      const issues: any[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = await gl(`/issues?state=opened&labels=${encodeURIComponent(STATE_LABELS.queued)}&per_page=100&page=${page}`);
        issues.push(...batch);
        if (batch.length < 100) break;
      }
      return Promise.all(issues.map(async (i) => ({ number: i.iid, url: i.web_url, body: i.description ?? "", trust: await trustOf(i.author.id) })));
    },

    // One call: dispatch-gitlab.ts sees `agent` arrive in the update's label changes.
    async release(issue) {
      await gl(`/issues/${issue}`, { method: "PUT", body: JSON.stringify({ add_labels: OPT_IN_LABEL, remove_labels: STATE_LABELS.queued }) });
    },

    async close(issue) {
      await gl(`/issues/${issue}`, { method: "PUT", body: JSON.stringify({ state_event: "close" }) });
    },

    async getReview(number) {
      const mr = await gl(`/merge_requests/${number}`);
      return {
        number,
        open: mr.state === "opened",
        merged: mr.state === "merged",
        head: mr.source_branch,
        base: mr.target_branch,
        sha: mr.sha,
        sameRepo: mr.source_project_id === mr.target_project_id,
      };
    },

    async findReview(branch, sha) {
      const mrs = await gl(`/merge_requests?state=all&source_branch=${encodeURIComponent(branch)}&order_by=updated_at&per_page=30`);
      return mrs.find((mr: any) => mr.sha === sha)?.iid;
    },

    async mergeReview(number, sha) {
      await request(`/merge_requests/${number}/merge`, { method: "PUT", body: JSON.stringify({ sha }) });
    },
  };
}
