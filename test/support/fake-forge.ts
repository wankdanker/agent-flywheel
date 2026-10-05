// An in-memory GitHub or GitLab, served through a fake `fetch`: just the REST endpoints a
// Tracker uses, with real pagination (GitHub's `Link: rel="next"`, GitLab's `x-next-page`),
// auth checks, and label/comment/review state that later requests read back. The real
// githubTracker/gitlabTracker run against it unchanged, so test/tracker-contract.test.ts can
// hold both adapters to one contract and test/fixtures.test.ts can run whole scenarios with
// no network. Seeds are platform-neutral; each platform renders them in its own wire format.
import { BOT_BADGE, BOT_MARKER, withMarker, type CodePlatform, type Tracker } from "../../src/tracker.ts";
import { githubTracker } from "../../src/github.ts";
import { gitlabTracker } from "../../src/gitlab.ts";
import type { Trust } from "../../src/trust.ts";

export type Platform = CodePlatform;
export type Person = { name: string; trust: Trust };
// `bot: true` is a comment our own tracker posted earlier (badge + marker, from the bot account).
// `app: true` is a comment from some other bot account (on GitHub, a different `type: "Bot"`
// user, e.g. another installed GitHub App), posted as `author` with the body as given.
export type SeedComment = { author: string; trust?: Trust; bot?: boolean; app?: boolean; text: string; at: string };
// `authorType: "Bot"` is an issue opened by a bot account (a GitHub App installation token, or
// GITHUB_TOKEN): GitHub reports it with `type: "Bot"` and author_association NONE whatever
// `trust` says, so it's ours only if `author` is the worker's own bot (BOT.github).
export type Seed = {
  number: number;
  title: string;
  body: string;
  author: string;
  authorType?: "User" | "Bot";
  trust: Trust;
  labels: string[];
  comments?: SeedComment[];
  defaultBranch?: string;
};

// What the fixtures and contract cases assert on, the same for both platforms.
export type Recorded = { method: string; url: string; headers: Record<string, string>; body?: unknown };
export type Review = { branch: string; base: string; title: string; body: string; url: string };
export type Relay = { ref: string; issue: string; trigger: string };
// An issue our tracker opened (GitHub createSubIssue), authored by the token's bot account.
export type Created = { number: number; title: string; body: string; labels: string[]; subIssueOf?: number; blockedBy?: number };
type Stored = { author: Person & { bot?: boolean; app?: boolean }; body: string; at: string; system?: boolean };
type Failure = { method: string; path: RegExp; status: number; body: string; times: number; skip: number };

export const TOKEN = { github: "ghs_contractTOKEN0123456789", gitlab: "glpat-contractTOKEN0123456789" };
export const BOT = { github: "github-actions[bot]", gitlab: "project_1_bot" };
// github-actions[bot]'s real user id, which GraphQL `viewer` reports for a GITHUB_TOKEN.
export const GITHUB_BOT_ID = 41898282;
export const REPO = "acme/widgets";
export const GITHUB_API = "https://api.github.com";
export const GITLAB_API = "https://gitlab.example/api/v4";
export const CLONE_URL = { github: `https://github.com/${REPO}.git`, gitlab: `https://gitlab.example/${REPO}.git` };

export class FakeForge {
  readonly token: string;
  labels: string[];
  comments: Stored[];
  reviews: Review[] = [];
  relays: Relay[] = [];
  created: Created[] = [];
  branches = new Map<string, string>();
  requests: Recorded[] = [];
  private failures: Failure[] = [];
  // Runs after each request is recorded and before it's served: lets a test play someone else
  // editing the issue in between two of our calls.
  onRequest?: (r: Recorded) => void;
  private clock = 0;
  private userIds = new Map<string, number>();
  readonly platform: Platform;
  readonly seed: Seed;

  constructor(platform: Platform, seed: Seed) {
    this.platform = platform;
    this.seed = seed;
    this.token = TOKEN[platform];
    this.labels = [...seed.labels];
    this.comments = (seed.comments ?? []).map((c) => ({
      author: c.bot ? { name: BOT[platform], trust: "trusted", bot: true } : { name: c.author, trust: c.trust ?? "untrusted", app: c.app },
      body: c.bot ? withMarker(c.text) : c.text,
      at: c.at,
    }));
  }

  tracker(): Tracker {
    return this.platform === "github"
      ? githubTracker({ token: this.token, repo: REPO, issue: this.seed.number })
      : gitlabTracker({ token: this.token, apiUrl: GITLAB_API, project: REPO, issue: this.seed.number });
  }

  // A sub-issue this forge saw us open, as the seed of the forge its own run talks to: authored
  // by our bot account, which GitHub reports as association NONE.
  childSeed(number: number): Seed {
    const c = this.created.find((x) => x.number === number);
    if (!c) throw new Error(`fake forge: no issue #${number} was created`);
    return { number, title: c.title, body: c.body, author: BOT[this.platform], authorType: "Bot", trust: "untrusted", labels: [...c.labels], defaultBranch: this.seed.defaultBranch };
  }

  // After letting `skip` through, the next `times` requests matching `method` and `path` (the
  // URL's pathname) answer `status`.
  failNext(method: string, path: RegExp, status: number, body = `{"message":"injected ${status}"}`, times = 1, skip = 0) {
    this.failures.push({ method, path, status, body, times, skip });
  }

  // The forge is back: no more injected failures.
  heal() {
    this.failures = [];
  }

  // Our own comments as a human reads them: badge and marker stripped.
  botComments(): string[] {
    return this.comments.filter((c) => c.author.bot && !c.system).map((c) => c.body.replace(BOT_BADGE, "").replace(BOT_MARKER, "").trim());
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, url: url.href, headers, body });
    this.onRequest?.(this.requests.at(-1)!);

    const authed = this.platform === "github" ? headers.authorization === `Bearer ${this.token}` : headers["private-token"] === this.token;
    if (!authed) return json({ message: "401 Unauthorized" }, 401);
    const failure = this.failures.find((f) => f.times > 0 && f.method === method && f.path.test(url.pathname));
    if (failure && failure.skip > 0) failure.skip--;
    else if (failure) {
      failure.times--;
      return new Response(failure.body, { status: failure.status });
    }
    return this.platform === "github" ? this.github(method, url, body) : this.gitlab(method, url, body);
  };

  // Authors are identified by id: the bot is 1 (GitLab) or GITHUB_BOT_ID, everyone else gets
  // the next one on first sight.
  private userId(name: string) {
    if (name === BOT.gitlab) return 1;
    if (name === BOT.github) return GITHUB_BOT_ID;
    if (!this.userIds.has(name)) this.userIds.set(name, 100 + this.userIds.size);
    return this.userIds.get(name)!;
  }

  private now() {
    return `2026-09-27T12:${String(Math.floor(this.clock / 60) % 60).padStart(2, "0")}:${String(this.clock++ % 60).padStart(2, "0")}Z`;
  }

  // One page of `items` per the request's `page`/`per_page`, and whether there's another.
  private page<T>(items: T[], url: URL) {
    const page = Number(url.searchParams.get("page") ?? "1");
    const per = Number(url.searchParams.get("per_page") ?? "20");
    return { items: items.slice((page - 1) * per, page * per), page, next: page * per < items.length ? page + 1 : undefined };
  }

  private github(method: string, url: URL, body: any): Response {
    const base = `/repos/${REPO}`;
    const p = url.pathname;
    const n = this.seed.number;
    const issue = () => ({
      number: n,
      id: 1000 + n,
      html_url: `https://github.com/${REPO}/issues/${n}`,
      title: this.seed.title,
      body: this.seed.body,
      user: { login: this.seed.author, id: this.userId(this.seed.author), type: this.seed.authorType ?? "User" },
      author_association: this.seed.authorType === "Bot" ? "NONE" : association(this.seed.trust),
      labels: this.labels.map((name) => ({ name })),
    });
    if (method === "POST" && p === "/graphql" && /viewer/.test(body?.query ?? "")) {
      return json({ data: { viewer: { login: BOT.github, databaseId: GITHUB_BOT_ID } } });
    }
    if (method === "GET" && p === base) {
      return json({ clone_url: CLONE_URL.github, html_url: `https://github.com/${REPO}`, default_branch: this.seed.defaultBranch ?? "main" });
    }
    if (method === "GET" && p === `${base}/issues/${n}`) return json(issue());
    // Only the per-label endpoints: a PATCH of the whole label set isn't served, so an adapter
    // that replaced it from a stale read would fail loudly here.
    if (method === "POST" && p === `${base}/issues/${n}/labels`) {
      this.labels = [...this.labels, ...body.labels.filter((l: string) => !this.labels.includes(l))];
      return json(issue().labels);
    }
    const unlabel = p.match(new RegExp(`^${esc(base)}/issues/${n}/labels/([^/]+)$`));
    if (method === "DELETE" && unlabel) {
      const name = decodeURIComponent(unlabel[1]!);
      if (!this.labels.includes(name)) return json({ message: "Label does not exist" }, 404);
      this.labels = this.labels.filter((l) => l !== name);
      return json(issue().labels);
    }
    if (method === "GET" && p === `${base}/issues/${n}/comments`) {
      const { items, next } = this.page(this.comments, url);
      const link: Record<string, string> = next ? { link: `<${GITHUB_API}${p}?per_page=${url.searchParams.get("per_page") ?? 20}&page=${next}>; rel="next"` } : {};
      return json(items.map((c) => ({
        user: { login: c.author.name, id: this.userId(c.author.name), type: c.author.bot || c.author.app ? "Bot" : "User" },
        // A GitHub App / Actions bot posts with association NONE; only its user id tells ours
        // apart from any other app's.
        author_association: c.author.bot || c.author.app ? "NONE" : association(c.author.trust),
        body: c.body,
        created_at: c.at,
      })), 200, link);
    }
    if (method === "POST" && p === `${base}/issues/${n}/comments`) {
      this.comments.push({ author: { name: BOT.github, trust: "trusted", bot: true }, body: body.body, at: this.now() });
      return json({ id: this.comments.length }, 201);
    }
    // Opening sub-issues (createSubIssue) and the integration branch (ensureBranch).
    if (method === "POST" && p === `${base}/issues`) {
      const c: Created = { number: n + 1 + this.created.length, title: body.title, body: body.body, labels: body.labels ?? [] };
      this.created.push(c);
      return json({ number: c.number, id: 1000 + c.number, html_url: `https://github.com/${REPO}/issues/${c.number}` }, 201);
    }
    const created = (k: string | undefined) => this.created.find((c) => c.number === Number(k));
    const labelsOf = p.match(new RegExp(`^${esc(base)}/issues/(\\d+)/labels$`));
    if (method === "POST" && labelsOf && created(labelsOf[1])) {
      const c = created(labelsOf[1])!;
      c.labels.push(...body.labels.filter((l: string) => !c.labels.includes(l)));
      return json(c.labels.map((name) => ({ name })));
    }
    const other = p.match(new RegExp(`^${esc(base)}/issues/(\\d+)$`));
    if (method === "GET" && other && created(other[1])) return json({ number: Number(other[1]), id: 1000 + Number(other[1]) });
    const subIssues = p.match(new RegExp(`^${esc(base)}/issues/(\\d+)/sub_issues$`));
    if (method === "POST" && subIssues) {
      const c = this.created.find((x) => 1000 + x.number === body.sub_issue_id)!;
      c.subIssueOf = Number(subIssues[1]);
      return json({}, 201);
    }
    const blocked = p.match(new RegExp(`^${esc(base)}/issues/(\\d+)/dependencies/blocked_by$`));
    if (method === "POST" && blocked && created(blocked[1])) {
      created(blocked[1])!.blockedBy = body.issue_id - 1000;
      return json({}, 201);
    }
    const ref = p.match(new RegExp(`^${esc(base)}/git/ref/heads/(.+)$`));
    if (method === "GET" && ref) {
      const branch = decodeURIComponent(ref[1]!);
      const sha = branch === (this.seed.defaultBranch ?? "main") ? "0".repeat(40) : this.branches.get(branch);
      return sha ? json({ object: { sha } }) : json({ message: "Not Found" }, 404);
    }
    if (method === "POST" && p === `${base}/git/refs`) {
      this.branches.set(String(body.ref).replace(/^refs\/heads\//, ""), body.sha);
      return json({}, 201);
    }
    if (method === "GET" && p === `${base}/pulls`) {
      const head = url.searchParams.get("head") ?? "";
      const open = this.reviews.filter((r) => `${REPO.split("/")[0]}:${r.branch}` === head);
      return json(open.map((r) => ({ html_url: r.url })));
    }
    if (method === "POST" && p === `${base}/pulls`) {
      const r = { branch: body.head, base: body.base, title: body.title, body: body.body, url: `https://github.com/${REPO}/pull/${this.reviews.length + 1}` };
      this.reviews.push(r);
      return json({ html_url: r.url }, 201);
    }
    if (method === "POST" && p === `${base}/actions/workflows/agent.yml/dispatches`) {
      this.relays.push({ ref: body.ref, issue: body.inputs.issue, trigger: body.inputs.trigger });
      return new Response(null, { status: 204 });
    }
    throw new Error(`fake github: unhandled ${method} ${url.href}`);
  }

  private gitlab(method: string, url: URL, body: any): Response {
    const base = `/api/v4/projects/${encodeURIComponent(REPO)}`;
    const p = url.pathname;
    const n = this.seed.number;
    const idOf = (name: string) => this.userId(name);
    const issue = () => ({
      iid: n,
      web_url: `https://gitlab.example/${REPO}/-/issues/${n}`,
      title: this.seed.title,
      description: this.seed.body,
      author: { id: idOf(this.seed.author), username: this.seed.author },
      labels: this.labels,
    });
    if (method === "GET" && p === base) {
      return json({ http_url_to_repo: CLONE_URL.gitlab, web_url: `https://gitlab.example/${REPO}`, default_branch: this.seed.defaultBranch ?? "main" });
    }
    const member = p.match(new RegExp(`^${esc(base)}/members/all/(\\d+)$`));
    if (method === "GET" && member) {
      const id = Number(member[1]);
      const people = [{ name: this.seed.author, trust: this.seed.trust }, ...this.comments.map((c) => c.author)];
      const who = people.find((x) => idOf(x.name) === id);
      if (!who || who.trust !== "trusted") return json({ message: "404 Not found" }, 404);
      return json({ id, access_level: id === 1 ? 40 : 30 });
    }
    if (method === "GET" && p === `${base}/issues/${n}`) return json(issue());
    if (method === "PUT" && p === `${base}/issues/${n}`) {
      const add = String(body.add_labels ?? "").split(",").filter(Boolean);
      const remove = String(body.remove_labels ?? "").split(",").filter(Boolean);
      const before = this.labels;
      this.labels = [...before.filter((l) => !remove.includes(l)), ...add.filter((l) => !before.includes(l))];
      // GitLab records label changes as system notes in the same list as comments.
      for (const l of add.filter((l) => !before.includes(l))) {
        this.comments.push({ author: { name: BOT.gitlab, trust: "trusted", bot: true }, body: `added ~"${l}" label`, at: this.now(), system: true });
      }
      return json(issue());
    }
    if (method === "GET" && p === `${base}/issues/${n}/notes`) {
      const { items, next } = this.page(this.comments, url);
      return json(items.map((c) => ({
        system: Boolean(c.system),
        author: { id: idOf(c.author.name), username: c.author.name },
        body: c.body,
        created_at: c.at,
      })), 200, { "x-next-page": next ? String(next) : "" });
    }
    if (method === "POST" && p === `${base}/issues/${n}/notes`) {
      this.comments.push({ author: { name: BOT.gitlab, trust: "trusted", bot: true }, body: body.body, at: this.now() });
      return json({ id: this.comments.length }, 201);
    }
    if (method === "GET" && p === `${base}/merge_requests`) {
      const branch = url.searchParams.get("source_branch");
      return json(this.reviews.filter((r) => r.branch === branch).map((r) => ({ web_url: r.url })));
    }
    if (method === "POST" && p === `${base}/merge_requests`) {
      const r = { branch: body.source_branch, base: body.target_branch, title: body.title, body: body.description, url: `https://gitlab.example/${REPO}/-/merge_requests/${this.reviews.length + 1}` };
      this.reviews.push(r);
      return json({ web_url: r.url }, 201);
    }
    if (method === "POST" && p === `${base}/pipeline`) {
      const v = Object.fromEntries((body.variables as { key: string; value: string }[]).map((x) => [x.key, x.value]));
      this.relays.push({ ref: body.ref, issue: v.ISSUE, trigger: v.AGENT_TRIGGER });
      return json({ id: this.relays.length }, 201);
    }
    throw new Error(`fake gitlab: unhandled ${method} ${url.href}`);
  }
}

const association = (t: Trust) => (t === "trusted" ? "MEMBER" : "NONE");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
