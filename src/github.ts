// Our thin GitHub REST client for one issue.
import { OPT_IN_LABEL, STATE_LABELS, toComment, withMarker, type ChainForge, type Tracker } from "./tracker.ts";
import { trustFromGithubAssociation, type Trust } from "./trust.ts";

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

// The workflow a relay dispatches (see dispatchRelay); its `trigger` input becomes AGENT_TRIGGER.
export const AGENT_WORKFLOW = "agent.yml";

// The account our own comments are posted as. `id` is GitHub's immutable numeric user id and
// wins when known; `login` alone is only a fallback, since a login can be renamed.
export type BotIdentity = { id?: number; login?: string };

// Does this comment's `user` object belong to the worker's own identity? Never true without one.
export const isWorker = (user: { id?: unknown; login?: unknown } | undefined, self: BotIdentity | undefined): boolean => {
  if (!user || !self) return false;
  if (self.id !== undefined) return user.id === self.id;
  return self.login !== undefined && typeof user.login === "string" && user.login.toLowerCase() === self.login.toLowerCase();
};

// An issue author's trust: a trusted association, or the worker's own identity. A sub-issue
// the worker opened with a GitHub App installation token (or GITHUB_TOKEN) is authored by that
// app's bot, whose association is NONE; it's still ours, and so is its chain header. Any other
// bot, or any other NONE author, stays untrusted.
export const githubAuthorTrust = (user: { id?: unknown; login?: unknown } | undefined, association: string | null | undefined, self: BotIdentity | undefined): Trust =>
  trustFromGithubAssociation(association) === "trusted" || isWorker(user, self) ? "trusted" : "untrusted";

// AGENT_BOT_ID (the numeric user id, preferred) and/or AGENT_BOT_LOGIN (e.g. `my-app[bot]`),
// or undefined to discover it from the token. Throws on a malformed id.
export function botIdentityFromEnv(env: Record<string, string | undefined>): BotIdentity | undefined {
  const rawId = env.AGENT_BOT_ID?.trim(), login = env.AGENT_BOT_LOGIN?.trim();
  if (rawId && !(/^\d+$/.test(rawId) && Number.isSafeInteger(Number(rawId)) && Number(rawId) > 0)) {
    throw new Error(`AGENT_BOT_ID must be a GitHub user id (a positive integer), got ${JSON.stringify(env.AGENT_BOT_ID)}`);
  }
  if (!rawId && !login) return undefined;
  return { ...(rawId ? { id: Number(rawId) } : {}), ...(login ? { login } : {}) };
}

// GitHub.com serves GraphQL at `<api>/graphql`; GitHub Enterprise Server at `/api/graphql`
// next to its `/api/v3` REST root.
export const graphqlUrl = (apiUrl: string) => (/\/api\/v3\/?$/.test(apiUrl) ? apiUrl.replace(/\/v3\/?$/, "/graphql") : `${apiUrl}/graphql`);

// The worker's own identity, resolved at most once per call of this factory: `self` if pinned
// (AGENT_BOT_ID / AGENT_BOT_LOGIN), else asked of GitHub (GraphQL `viewer`, which answers for
// PATs and for app installation tokens such as GITHUB_TOKEN alike, unlike REST `/user`). If
// GitHub won't say who we are, fail closed: nothing is recognized as ours by identity (a trusted
// association still counts), so at worst our own comments and sub-issues read as untrusted,
// never someone else's as ours. The one resolver both issue authors and comment authors use.
export function workerIdentity(o: { token: string; apiUrl?: string; self?: BotIdentity }): () => Promise<BotIdentity | undefined> {
  const apiUrl = o.apiUrl ?? "https://api.github.com";
  let resolved: Promise<BotIdentity | undefined> | undefined;
  return () => {
    if (o.self && (o.self.id !== undefined || o.self.login)) return Promise.resolve(o.self);
    resolved ??= (async () => {
      try {
        const res = await fetch(graphqlUrl(apiUrl), {
          method: "POST",
          headers: { Authorization: `Bearer ${o.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
          body: JSON.stringify({ query: "query { viewer { login databaseId } }" }),
        });
        if (!res.ok) throw new Error(`graphql viewer: ${res.status} ${await res.text()}`);
        const viewer = (await res.json())?.data?.viewer;
        if (typeof viewer?.login !== "string" || !viewer.login) throw new Error("no viewer in the response");
        return { login: viewer.login, ...(Number.isSafeInteger(viewer.databaseId) ? { id: viewer.databaseId as number } : {}) };
      } catch (err) {
        console.error("[github] couldn't resolve the worker's own identity; nothing will count as ours by identity (set AGENT_BOT_ID to pin it):", err instanceof Error ? err.message : err);
        return undefined;
      }
    })();
    return resolved;
  };
}

// `self` pins the worker's identity; see workerIdentity.
export function githubTracker(o: { token: string; repo: string; issue: number; apiUrl?: string; self?: BotIdentity }): Tracker {
  const apiUrl = o.apiUrl ?? "https://api.github.com";
  const issue = `/issues/${o.issue}`;

  async function request(url: string, init: RequestInit, label: string, okStatus: number[] = []) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${o.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
    });
    if (!res.ok && !okStatus.includes(res.status)) throw new Error(`GitHub ${init.method ?? "GET"} ${label}: ${res.status} ${await res.text()}`);
    return res;
  }

  async function gh(path: string, init: RequestInit = {}) {
    return (await request(`${apiUrl}/repos/${o.repo}${path}`, init, path)).json();
  }

  // Like gh(), but undefined for a 404 instead of throwing.
  async function ghMaybe(path: string) {
    const res = await fetch(`${apiUrl}/repos/${o.repo}${path}`, { headers: { Authorization: `Bearer ${o.token}`, Accept: "application/vnd.github+json" } });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  // Native relations are a nicety on top of the chain header (src/chain.ts), and these APIs
  // aren't on every GitHub plan or server version, so a failure is only logged.
  async function bestEffort(what: string, f: () => Promise<unknown>) {
    try {
      await f();
    } catch (err) {
      console.error(`[github] couldn't ${what} (the issue body still records it):`, err instanceof Error ? err.message : err);
    }
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

  const identity = workerIdentity(o);

  return {
    platform: "github",

    async repo() {
      const r = await gh("");
      return { cloneUrl: r.clone_url, webUrl: r.html_url, defaultBranch: r.default_branch };
    },

    async getTicket() {
      const [i, comments, me] = await Promise.all([gh(issue), ghAll(`${issue}/comments?per_page=100`), identity()]);
      return {
        number: i.number,
        url: i.html_url,
        title: i.title,
        body: i.body ?? "",
        author: i.user.login,
        trust: githubAuthorTrust(i.user, i.author_association, me),
        labels: i.labels.map((l: any) => l.name),
        comments: comments.map((c: any) =>
          toComment(c.user.login, c.body ?? "", c.created_at, trustFromGithubAssociation(c.author_association), isWorker(c.user, me)),
        ),
      };
    },

    async comment(text) {
      await gh(`${issue}/comments`, { method: "POST", body: JSON.stringify({ body: withMarker(text) }) });
    },

    // Exactly one state label at a time; everything else on the issue is left alone. Only the
    // per-label endpoints, and nothing decided from an earlier read: a PATCH of the whole set
    // would undo any label someone else added or removed since we read it. Add the target first
    // (so the issue is never without a state), then remove every other state label, whether or
    // not it's there; a 404 means it already isn't, so a retry is a no-op.
    async setState(state) {
      const target = STATE_LABELS[state];
      await gh(`${issue}/labels`, { method: "POST", body: JSON.stringify({ labels: [target] }) });
      for (const name of Object.values(STATE_LABELS).filter((l) => l !== target)) {
        const path = `${issue}/labels/${encodeURIComponent(name)}`;
        await request(`${apiUrl}/repos/${o.repo}${path}`, { method: "DELETE" }, path, [404]);
      }
    },

    // A runnable one takes two calls, not one create-with-labels: GitHub doesn't fire a
    // `labeled` webhook event for labels included in the creation payload, only `opened` — and
    // agent.yml only triggers on `labeled`. Adding the label as a follow-up guarantees the new
    // run starts. A queued one should start nothing, so its label goes in the payload.
    async createSubIssue({ title, body, runnable, parent, blockedBy }) {
      const created = await gh("/issues", {
        method: "POST",
        body: JSON.stringify(runnable ? { title, body } : { title, body, labels: [STATE_LABELS.queued] }),
      });
      if (runnable) await gh(`/issues/${created.number}/labels`, { method: "POST", body: JSON.stringify({ labels: [OPT_IN_LABEL] }) });
      await bestEffort(`add #${created.number} as a sub-issue of #${parent}`, () =>
        gh(`/issues/${parent}/sub_issues`, { method: "POST", body: JSON.stringify({ sub_issue_id: created.id }) }));
      if (blockedBy) {
        await bestEffort(`mark #${created.number} blocked by #${blockedBy}`, async () => {
          const blocker = await gh(`/issues/${blockedBy}`);
          await gh(`/issues/${created.number}/dependencies/blocked_by`, { method: "POST", body: JSON.stringify({ issue_id: blocker.id }) });
        });
      }
      return { number: created.number, url: created.html_url };
    },

    async ensureBranch(branch, from) {
      if (await ghMaybe(`/git/ref/heads/${branch}`)) return false;
      const base = await gh(`/git/ref/heads/${from}`);
      await gh("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }) });
      return true;
    },

    // Pushing the branch already updated an open PR; only open one if there isn't one yet.
    async openReview({ branch, base, title, body }) {
      const owner = o.repo.split("/")[0]!;
      const open = await gh(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      if (Array.isArray(open) && open.length) return { url: open[0].html_url, created: false };
      const pr = await gh("/pulls", { method: "POST", body: JSON.stringify({ title, head: branch, base, body }) });
      return { url: pr.html_url, created: true };
    },

    // workflow_dispatch is one of the few events GITHUB_TOKEN may start a workflow with. Answers 204.
    async dispatchRelay() {
      const r = await gh("");
      const path = `/actions/workflows/${AGENT_WORKFLOW}/dispatches`;
      await request(`${apiUrl}/repos/${o.repo}${path}`, {
        method: "POST",
        body: JSON.stringify({ ref: r.default_branch, inputs: { issue: String(o.issue), trigger: "relay" } }),
      }, path);
    },
  };
}

export function githubChain(o: { token: string; repo: string; apiUrl?: string; self?: BotIdentity }): ChainForge {
  const apiUrl = o.apiUrl ?? "https://api.github.com";
  async function gh(path: string, init: RequestInit = {}, okStatus: number[] = []) {
    const res = await fetch(`${apiUrl}/repos/${o.repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${o.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
    });
    if (!res.ok && !okStatus.includes(res.status)) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 || !res.ok ? undefined : res.json();
  }
  const identity = workerIdentity(o);
  return {
    tracker: (issue) => githubTracker({ ...o, issue }),

    async listQueued() {
      const issues: any[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = await gh(`/issues?state=open&labels=${encodeURIComponent(STATE_LABELS.queued)}&per_page=100&page=${page}`);
        issues.push(...batch);
        if (batch.length < 100) break;
      }
      const me = await identity();
      return issues
        .filter((i) => !i.pull_request)
        .map((i) => ({ number: i.number, url: i.html_url, body: i.body ?? "", trust: githubAuthorTrust(i.user, i.author_association, me) }));
    },

    // Remove first, then add: adding `agent` fires the `labeled` event that starts the run.
    async release(issue) {
      await gh(`/issues/${issue}/labels/${encodeURIComponent(STATE_LABELS.queued)}`, { method: "DELETE" }, [404]);
      await gh(`/issues/${issue}/labels`, { method: "POST", body: JSON.stringify({ labels: [OPT_IN_LABEL] }) });
    },

    async close(issue) {
      await gh(`/issues/${issue}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
    },

    async getReview(number) {
      const pr = await gh(`/pulls/${number}`);
      return {
        number,
        open: pr.state === "open",
        merged: Boolean(pr.merged),
        head: pr.head.ref,
        base: pr.base.ref,
        sha: pr.head.sha,
        sameRepo: pr.head.repo?.full_name === o.repo,
      };
    },

    async findReview(branch, sha) {
      const owner = o.repo.split("/")[0]!;
      const prs = await gh(`/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&sort=updated&direction=desc&per_page=30`);
      return prs.find((pr: any) => pr.head.sha === sha)?.number;
    },

    async mergeReview(number, sha) {
      await gh(`/pulls/${number}/merge`, { method: "PUT", body: JSON.stringify({ sha, merge_method: "merge" }) });
    },
  };
}
