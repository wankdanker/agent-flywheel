// A Notion database (our company Tickets board) as a ticket source: each page is an issue. The
// issue side (getTicket, comment, setState) talks to Notion; the code-host side (repo,
// ensureBranch, openReview) delegates to a GitHub or GitLab code host for the project the ticket's
// repo property names (NOTION_CODE_PLATFORM), so a ticket's work lands as a PR/MR there while the
// flywheel's own CI can live anywhere. See README's "Notion tickets".
//
// The board is shared company-wide, so this reads widely but writes narrowly: only the status
// property, the review-link property, and comments.
// No npm deps here, same as tracker.ts: bin/list-notion-tickets.ts imports this on stock node.
import { repoPathProblem } from "./chain.ts";
import { ConfigError } from "./config-error.ts";
import { RESUME_HINT, REVIEW_HINT } from "./dispatch.ts";
import { githubCodeHost } from "./github.ts";
import { gitlabCodeHost } from "./gitlab.ts";
import { BOT_BADGE, OPT_IN_LABEL, STATE_LABELS, toComment, withMarker, type CodeHost, type CodePlatform, type TicketState, type Tracker } from "./tracker.ts";
import type { Trust } from "./trust.ts";

export const NOTION_API = "https://api.notion.com/v1";
// The data-source API (`/data_sources/{id}/query`), not 2022-06-28's `/databases/{id}/query`.
export const NOTION_VERSION = "2025-09-03";
// The run workflow a relay dispatches (see dispatchRelay), with `page` and `trigger` inputs.
export const NOTION_WORKFLOW = "notion-poll.yml";

// A runaway-loop guard, as in github.ts/gitlab.ts: 1000 pages of 100 is far past any real ticket.
const MAX_PAGES = 1000;
// How deep into nested blocks (callouts, toggles, list items) a ticket body is read, and how many
// blocks in all: past either, the body ends with a note saying it was cut.
const MAX_DEPTH = 8;
const MAX_BLOCKS = 5000;
// Notion's own limits on one rich-text object and on a comment's rich-text array.
const MAX_TEXT_CONTENT = 2000;
const MAX_RICH_TEXT = 100;

// Property names and status values, from NOTION_* env vars (notionSchemaFromEnv); the defaults are
// our Tickets database's. Statuses map onto options the shared board already has.
export type NotionSchema = {
  props: { title: string; id: string; status: string; assignee: string; repo: string };
  statuses: { pickup: string; working: string; blocked: string; review: string };
  // The url property the PR/MR link goes to on `review`; undefined skips it.
  reviewLink?: string;
};

export const DEFAULT_SCHEMA: NotionSchema = {
  props: { title: "Name", id: "ID", status: "Status", assignee: "Assignee", repo: "Repo" },
  statuses: { pickup: "To Do", working: "Doing", blocked: "Blocked", review: "Needs Review" },
};
export const DEFAULT_REVIEW_LINK = "GitLab Link";

// A Notion id (page, user, data source) as the API spells it, from a bare or dashed uuid, a
// `collection://<uuid>`, or a page URL ending in one. Undefined if there's no 32-hex id in it.
export function normalizeId(raw: string | undefined): string | undefined {
  const hex = raw?.replace(/-/g, "").match(/([0-9a-f]{32})(?![0-9a-f])/i)?.[1]?.toLowerCase();
  return hex && `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const sameId = (a: string | undefined, b: string | undefined) => a !== undefined && normalizeId(a) === normalizeId(b);

// ---- Properties ----

const plain = (rich: any[] | undefined) => (rich ?? []).map((t) => t?.plain_text ?? "").join("");

// Any property value as text, for the prompt and for matching.
export function flattenProperty(p: any): string {
  if (!p || typeof p !== "object") return "";
  const v = p[p.type];
  switch (p.type) {
    case "title":
    case "rich_text":
      return plain(v);
    case "select":
    case "status":
      return v?.name ?? "";
    case "multi_select":
      return (v ?? []).map((o: any) => o.name).join(", ");
    case "people":
      return (v ?? []).map((u: any) => u.name ?? u.id).join(", ");
    case "created_by":
    case "last_edited_by":
      return v?.name ?? v?.id ?? "";
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      return v ?? "";
    case "checkbox":
      return v ? "true" : "false";
    case "number":
      return v === null || v === undefined ? "" : String(v);
    case "unique_id":
      return v?.number === null || v?.number === undefined ? "" : v.prefix ? `${v.prefix}-${v.number}` : String(v.number);
    case "date":
      return v ? (v.end ? `${v.start} → ${v.end}` : v.start) : "";
    case "relation":
      return (v ?? []).map((r: any) => r.id).join(", ");
    case "formula":
      return v ? String(v[v.type] ?? "") : "";
    default:
      return "";
  }
}

// Does the property hold `value`? Element-wise for people (by id or name) and multi_select (by
// name or id), never a substring of the joined text; the whole flattened value otherwise.
export function propertyMatches(p: any, value: string): boolean {
  if (!p) return false;
  if (p.type === "people") return (p.people ?? []).some((u: any) => sameId(u.id, value) || (u.name !== undefined && u.name === value));
  if (p.type === "multi_select") return (p.multi_select ?? []).some((o: any) => o.name === value || o.id === value);
  return flattenProperty(p) === value;
}

// ---- Page body ----

// One block's own line(s), without its children.
function blockLine(b: any): string {
  const v = b[b.type] ?? {};
  const text = plain(v.rich_text);
  switch (b.type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
    case "numbered_list_item":
      return `- ${text}`;
    case "to_do":
      return `${v.checked ? "[x]" : "[ ]"} ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return `\`\`\`${v.language ?? ""}\n${text}\n\`\`\``;
    case "divider":
      return "---";
    case "equation":
      return v.expression ?? "";
    case "child_page":
    case "child_database":
      return `(${b.type === "child_page" ? "sub-page" : "database"}: ${v.title ?? ""})`;
    case "bookmark":
    case "embed":
    case "link_preview":
      return v.url ?? "";
    default:
      return text;
  }
}

// ---- Comments ----
//
// Notion comments are plain rich text: no hidden HTML comments, no markdown. So what the forge
// adapters post as a hidden BOT_MARKER (and chain markers) goes out as a short gray `‹…›` token,
// the badge as bold text, and the resume/review hints in their Notion form; reading back one of
// *our own* comments (`isSelf`: posted by our integration's bot user, /users/me) reverses all of
// it, so toComment, guardTracker's de-dupe and the chain count see exactly what a forge shows them.

export const NOTION_RESUME_HINT =
  "To have me pick this ticket up again, move it back to To Do (still assigned to me); add any directions as a " +
  "comment first. Only comments from a trusted user (NOTION_TRUSTED_USERS) are read as instructions.";
export const NOTION_REVIEW_HINT =
  "To have me rework this, comment with what to change, then move the ticket back to To Do (still assigned to me).";
const BADGE_TEXT = "🤖 Agent Flywheel";
const HIDDEN = /<!-- (agent-flywheel[^>]*?) -->/g;
const TOKEN = /‹(agent-flywheel[^›]*)›/g;

type RichText = { type: "text"; text: { content: string }; annotations?: { bold?: boolean; color?: string } };

// What comment() posts for `text`: withMarker's text, translated as above, in Notion-sized pieces.
export function toRichText(text: string): RichText[] {
  const body = withMarker(text).split(RESUME_HINT).join(NOTION_RESUME_HINT).split(REVIEW_HINT).join(NOTION_REVIEW_HINT);
  const out: RichText[] = [];
  const push = (content: string, annotations?: RichText["annotations"]) => {
    for (let i = 0; i < content.length; i += MAX_TEXT_CONTENT) {
      out.push({ type: "text", text: { content: content.slice(i, i + MAX_TEXT_CONTENT) }, ...(annotations ? { annotations } : {}) });
    }
  };
  let rest = body;
  if (rest.startsWith(BOT_BADGE)) {
    push(BADGE_TEXT, { bold: true });
    rest = rest.slice(BOT_BADGE.length);
  }
  let at = 0;
  for (const m of rest.matchAll(HIDDEN)) {
    if (m.index > at) push(rest.slice(at, m.index));
    push(`‹${m[1]}›`, { color: "gray" });
    at = m.index + m[0].length;
  }
  if (at < rest.length) push(rest.slice(at));
  if (out.length > MAX_RICH_TEXT) {
    // Over ~200k characters; keep the head and the trailing marker, so it still reads as ours.
    return [...out.slice(0, MAX_RICH_TEXT - 2), { type: "text", text: { content: "\n\n(cut: too long for a Notion comment)\n\n" } }, out.at(-1)!];
  }
  return out;
}

// One of our own comments, read back into the text a forge would have returned.
export function fromOwnComment(text: string): string {
  let s = text.startsWith(BADGE_TEXT) ? `${BOT_BADGE}${text.slice(BADGE_TEXT.length)}` : text;
  s = s.replace(TOKEN, "<!-- $1 -->");
  return s.split(NOTION_RESUME_HINT).join(RESUME_HINT).split(NOTION_REVIEW_HINT).join(REVIEW_HINT);
}

// ---- Repo property ----

// The code project a ticket's repo property names: a plain path (`group/sub/project`) or a URL on
// the code host (a project URL, or an issue/MR/PR URL, from which the project is derived). A URL
// on any other host is refused; so is anything that isn't then a valid repo path. Undefined when
// the property is empty. The allowlist still applies to whatever this returns (run.ts).
export function parseRepoProperty(raw: string, code: { platform: CodePlatform; host: string }): { path: string } | { invalid: string } {
  const value = raw.trim();
  const shown = `\`${value.replace(/`/g, "'").slice(0, 200)}\``;
  let path = value;
  if (/^[a-z][\w+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { invalid: `${shown} isn't a valid URL` };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { invalid: `${shown} isn't an http(s) URL` };
    if (url.username || url.password) return { invalid: `${shown} has credentials in it` };
    if (url.host.toLowerCase() !== code.host.toLowerCase()) return { invalid: `${shown} is on ${url.host}, but code lands on ${code.host}` };
    path = decodeURIComponent(url.pathname)
      .replace(/\/-\/.*$/, "") // GitLab: /-/issues/N, /-/merge_requests/N, /-/tree/…
      .replace(/\/(issues|pull)\/\d+\/?$/, "") // GitHub: /issues/N, /pull/N
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "");
  }
  const problem = repoPathProblem(path, code.platform);
  return problem ? { invalid: `${shown} isn't a ${code.platform === "github" ? "GitHub" : "GitLab"} project: ${problem}` } : { path };
}

// ---- Client ----

type Client = {
  api(path: string, init?: RequestInit): Promise<any>;
  // Every result of a cursor-paginated endpoint (`has_more`/`next_cursor`): `page(cursor)` fetches one.
  all(label: string, page: (cursor: string | undefined) => Promise<any>): Promise<any[]>;
};

export function notionClient(o: { token: string; apiUrl?: string }): Client {
  const apiUrl = o.apiUrl ?? NOTION_API;
  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${o.token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`Notion ${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
    return res.json();
  }
  async function all(label: string, page: (cursor: string | undefined) => Promise<any>) {
    const items: any[] = [];
    let cursor: string | undefined;
    for (let n = 1; ; n++) {
      if (n > MAX_PAGES) throw new Error(`Notion ${label}: more than ${MAX_PAGES} pages, refusing to continue`);
      const body = await page(cursor);
      if (!Array.isArray(body?.results)) throw new Error(`Notion ${label} (page ${n}): expected a results array`);
      items.push(...body.results);
      if (!body.has_more) return items;
      if (typeof body.next_cursor !== "string" || !body.next_cursor) throw new Error(`Notion ${label} (page ${n}): has_more without a next_cursor`);
      cursor = body.next_cursor;
    }
  }
  return { api, all };
}

const withCursor = (path: string, cursor: string | undefined) =>
  cursor ? `${path}${path.includes("?") ? "&" : "?"}start_cursor=${encodeURIComponent(cursor)}` : path;

// A page's body as text: every block, recursing into children (callouts and toggles hold most of a
// ticket template's content, its acceptance criteria included), children indented under their parent.
export async function pageText(client: Client, pageId: string): Promise<string> {
  const lines: string[] = [];
  let count = 0;
  let cut = false;
  async function walk(id: string, depth: number) {
    const path = `/blocks/${id}/children?page_size=100`;
    const blocks = await client.all(`GET ${path.split("?")[0]}`, (c) => client.api(withCursor(path, c)));
    for (const b of blocks) {
      if (++count > MAX_BLOCKS) return void (cut = true);
      const indent = "  ".repeat(depth);
      lines.push(...blockLine(b).split("\n").map((l) => (l ? indent + l : l)));
      // A sub-page or database is its own thing, not this ticket's text.
      if (b.has_children && b.type !== "child_page" && b.type !== "child_database") {
        if (depth + 1 >= MAX_DEPTH) cut = true;
        else await walk(b.id, depth + 1);
      }
    }
  }
  await walk(pageId, 0);
  if (cut) lines.push("", `(the rest of this page isn't shown: it's nested deeper than ${MAX_DEPTH} levels or longer than ${MAX_BLOCKS} blocks)`);
  return lines.join("\n").trim();
}

// ---- Tracker ----

// The forge a Notion ticket's code lands on: which platform, its web host (what a repo URL in the
// property must be on), and a code host for any project path there.
export type NotionCode = { platform: CodePlatform; host: string; build(path: string): CodeHost };

export type NotionOptions = {
  token: string;
  apiUrl?: string;
  page: string;
  schema?: NotionSchema;
  // User ids whose tickets (created_by) and comments are trusted. Nobody else's are.
  trusted: string[];
  // The person in the assignee property that stands for the agent: pickup requires it.
  agentUser: string;
  code: NotionCode;
  // Starts the next run on this page (a relay); see notionRelay.
  relay?: () => Promise<void>;
  // The project the code-host calls act on (Tracker#retarget); none until the ticket's repo
  // property has been read and allowlisted (run.ts's fetchAllowedTicket).
  target?: string;
  // Shared between a tracker and its retargets: the PR/MR openReview opened, for setState("review").
  shared?: { reviewUrl?: string };
};

export function notionTracker(o: NotionOptions): Tracker {
  const client = notionClient(o);
  const page = normalizeId(o.page);
  if (!page) throw new ConfigError(`NOTION_PAGE_ID must be a Notion page id, got ${JSON.stringify(o.page)}`);
  const schema = o.schema ?? DEFAULT_SCHEMA;
  const shared = o.shared ?? {};
  const trusted = o.trusted.map((u) => normalizeId(u)).filter((u): u is string => !!u);
  const trustOf = (id: string | undefined): Trust => (id && trusted.includes(normalizeId(id) ?? "") ? "trusted" : "untrusted");

  // Our own integration's bot user. If Notion won't say, fail closed: nothing reads as ours by
  // identity (a trusted user's marker still counts, as on the forges).
  let me: Promise<string | undefined> | undefined;
  const self = () =>
    (me ??= client.api("/users/me").then(
      (u) => normalizeId(u?.id),
      (err) => (console.error("[notion] couldn't resolve our own integration's user; nothing will count as ours by identity:", err instanceof Error ? err.message : err), undefined),
    ));

  // One /users/{id} lookup per author per run; the id itself if that fails (or isn't allowed).
  const names = new Map<string, Promise<string>>();
  const nameOf = (id: string) => {
    if (!names.has(id)) names.set(id, client.api(`/users/${id}`).then((u) => u?.name || id, () => id));
    return names.get(id)!;
  };

  const code = () => {
    if (!o.target) throw new Error("this Notion ticket has no code project yet: its repo property must be read and allowlisted first (Tracker#retarget)");
    return o.code.build(o.target);
  };

  // A state's status value; `queued` is a split's, which Notion tickets never are (yet).
  const statusFor = (state: TicketState) => {
    if (state === "queued") throw new Error("Notion tickets can't be queued sub-issues");
    return schema.statuses[state];
  };

  return {
    platform: "notion",
    codePlatform: o.code.platform,

    // The ticket's status (and whether it's assigned to the agent) as the forge labels the rest of
    // the run reasons with: `agent` while assigned and in one of the flywheel's statuses, plus the
    // state label for Doing/Blocked/Needs Review. Anything else (Done, Backlog, unassigned) has no
    // `agent`, so no queued or relayed run goes ahead on it (dispatch.ts's recheckTrigger).
    async getTicket() {
      const [p, mine] = await Promise.all([client.api(`/pages/${page}`), self()]);
      const props = p.properties ?? {};
      const uid = props[schema.props.id]?.type === "unique_id" ? props[schema.props.id].unique_id : undefined;
      if (!Number.isSafeInteger(uid?.number) || uid.number < 1) {
        throw new Error(`Notion page ${page} has no \`${schema.props.id}\` (unique id) value; is NOTION_ID_PROPERTY right?`);
      }
      const status = flattenProperty(props[schema.props.status]);
      const states = (["working", "blocked", "review"] as const).filter((s) => schema.statuses[s] === status);
      const live = status === schema.statuses.pickup || states.length > 0;
      const labels = [
        ...(live && propertyMatches(props[schema.props.assignee], o.agentUser) ? [OPT_IN_LABEL] : []),
        ...states.map((s) => STATE_LABELS[s]),
      ];

      const commentsPath = `/comments?block_id=${page}&page_size=100`;
      const [body, raw, author] = await Promise.all([
        pageText(client, page),
        client.all("GET /comments", (c) => client.api(withCursor(commentsPath, c))),
        nameOf(p.created_by?.id ?? "unknown"),
      ]);
      const comments = await Promise.all(raw.map(async (c: any) => {
        const id = c.created_by?.id;
        const isSelf = mine !== undefined && sameId(id, mine);
        const text = plain(c.rich_text);
        return toComment(await nameOf(id ?? "unknown"), isSelf ? fromOwnComment(text) : text, c.created_time ?? "", trustOf(id), isSelf);
      }));
      const repo = flattenProperty(props[schema.props.repo]);
      return {
        number: uid.number,
        key: uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number),
        url: p.url ?? `https://www.notion.so/${page.replace(/-/g, "")}`,
        title: flattenProperty(props[schema.props.title]),
        body,
        author,
        trust: trustOf(p.created_by?.id),
        labels,
        comments,
        target: repo.trim()
          ? parseRepoProperty(repo, o.code)
          : { invalid: `it has no \`${schema.props.repo}\` value: set it to the project path (group/project) or its URL on ${o.code.host}` },
      };
    },

    async comment(text) {
      await client.api("/comments", { method: "POST", body: JSON.stringify({ parent: { page_id: page }, rich_text: toRichText(text) }) });
    },

    // Only the status property, and on `review` the review-link property (when configured and we
    // opened or found a PR/MR in this run).
    async setState(state) {
      const properties: Record<string, unknown> = { [schema.props.status]: { status: { name: statusFor(state) } } };
      if (state === "review" && schema.reviewLink && shared.reviewUrl) properties[schema.reviewLink] = { url: shared.reviewUrl };
      await client.api(`/pages/${page}`, { method: "PATCH", body: JSON.stringify({ properties }) });
    },

    // Splits aren't mapped onto Notion's Sub-item / Blocked by relations yet; worker.ts's
    // splitRefusal refuses them before this is ever reached.
    async createSubIssue() {
      throw new Error("Notion tickets can't be split into sub-issues yet");
    },

    repo: async () => code().repo(),
    ensureBranch: async (branch, from) => code().ensureBranch(branch, from),
    async openReview(input) {
      const review = await code().openReview(input);
      shared.reviewUrl = review.url;
      return review;
    },

    async dispatchRelay() {
      if (!o.relay) throw new Error("no relay configured for Notion tickets (needs GH_TOKEN and GITHUB_REPOSITORY)");
      await o.relay();
    },

    retarget: (path) => notionTracker({ ...o, shared, target: path }),
  };
}

// workflow_dispatch of the Notion run workflow on the flywheel's own GitHub repo, for this page,
// with trigger `relay`: the same thing a forge tracker's dispatchRelay does for an issue.
export function notionRelay(o: { token: string; repo: string; page: string; apiUrl?: string; workflow?: string }): () => Promise<void> {
  const apiUrl = o.apiUrl ?? "https://api.github.com";
  const headers = { Authorization: `Bearer ${o.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
  return async () => {
    const r = await fetch(`${apiUrl}/repos/${o.repo}`, { headers });
    if (!r.ok) throw new Error(`GitHub GET /repos/${o.repo}: ${r.status} ${await r.text()}`);
    const { default_branch } = await r.json();
    const path = `/actions/workflows/${o.workflow ?? NOTION_WORKFLOW}/dispatches`;
    const res = await fetch(`${apiUrl}/repos/${o.repo}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ref: default_branch, inputs: { page: o.page, trigger: "relay" } }),
    });
    if (!res.ok) throw new Error(`GitHub POST ${path}: ${res.status} ${await res.text()}`);
  };
}

// ---- Configuration ----

const required = (env: NodeJS.ProcessEnv, k: string) => {
  const v = env[k];
  if (!v) throw new ConfigError(`missing env ${k}`);
  return v;
};

// Property names and statuses from NOTION_*_PROPERTY / NOTION_STATUS_*, defaulting to our board's.
// The review link defaults to `GitLab Link` only when code lands on GitLab; `none` turns it off.
export function notionSchemaFromEnv(env: NodeJS.ProcessEnv, codePlatform?: CodePlatform): NotionSchema {
  const d = DEFAULT_SCHEMA;
  const link = env.NOTION_REVIEW_LINK_PROPERTY ?? (codePlatform === "gitlab" ? DEFAULT_REVIEW_LINK : undefined);
  return {
    props: {
      title: env.NOTION_TITLE_PROPERTY || d.props.title,
      id: env.NOTION_ID_PROPERTY || d.props.id,
      status: env.NOTION_STATUS_PROPERTY || d.props.status,
      assignee: env.NOTION_ASSIGNEE_PROPERTY || d.props.assignee,
      repo: env.NOTION_REPO_PROPERTY || d.props.repo,
    },
    statuses: {
      pickup: env.NOTION_STATUS_TODO || d.statuses.pickup,
      working: env.NOTION_STATUS_DOING || d.statuses.working,
      blocked: env.NOTION_STATUS_BLOCKED || d.statuses.blocked,
      review: env.NOTION_STATUS_REVIEW || d.statuses.review,
    },
    ...(link && link.toLowerCase() !== "none" ? { reviewLink: link } : {}),
  };
}

// The forge code lands on, with that forge's usual env vars and token: GitHub's GH_TOKEN and
// GITHUB_API_URL, GitLab's AGENT_GITLAB_TOKEN and CI_API_V4_URL (or CI_SERVER_HOST).
export function notionCodeFromEnv(env: NodeJS.ProcessEnv): NotionCode {
  const platform = env.NOTION_CODE_PLATFORM;
  if (platform === "github") {
    const token = required(env, "GH_TOKEN");
    const apiUrl = env.GITHUB_API_URL || "https://api.github.com";
    const api = new URL(apiUrl).host;
    return { platform, host: api === "api.github.com" ? "github.com" : api, build: (repo) => githubCodeHost({ token, repo, apiUrl }) };
  }
  if (platform === "gitlab") {
    const token = required(env, "AGENT_GITLAB_TOKEN");
    const apiUrl = env.CI_API_V4_URL || `https://${required(env, "CI_SERVER_HOST")}/api/v4`;
    return { platform, host: new URL(apiUrl).host, build: (project) => gitlabCodeHost({ token, apiUrl, project }) };
  }
  throw new ConfigError(`NOTION_CODE_PLATFORM must be github or gitlab, got ${JSON.stringify(platform ?? "")}`);
}

export const trustedUsersFromEnv = (env: NodeJS.ProcessEnv) =>
  (env.NOTION_TRUSTED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function notionTrackerFromEnv(env: NodeJS.ProcessEnv): Tracker {
  const code = notionCodeFromEnv(env);
  const page = required(env, "NOTION_PAGE_ID");
  const relay = env.GH_TOKEN && env.GITHUB_REPOSITORY
    ? notionRelay({ token: env.GH_TOKEN, repo: env.GITHUB_REPOSITORY, page, apiUrl: env.GITHUB_API_URL, workflow: env.NOTION_RELAY_WORKFLOW })
    : undefined;
  return notionTracker({
    token: required(env, "NOTION_TOKEN"),
    apiUrl: env.NOTION_API_URL,
    page,
    schema: notionSchemaFromEnv(env, code.platform),
    trusted: trustedUsersFromEnv(env),
    agentUser: required(env, "NOTION_AGENT_USER_ID"),
    code,
    relay,
  });
}

// ---- Pickup (bin/list-notion-tickets.ts) ----

// Server-side: status is the pickup status and the assignee includes the agent's user.
export const pickupFilter = (schema: NotionSchema, agentUser: string) => ({
  and: [
    { property: schema.props.status, status: { equals: schema.statuses.pickup } },
    { property: schema.props.assignee, people: { contains: agentUser } },
  ],
});

// The ids of every page ready for pickup, across all result pages. The filter is re-checked on
// each result too, so a ticket already Doing (or Blocked, or in review) is never dispatched again,
// whatever the server returned: those continue only by a relay or a human moving them to To Do.
export async function listPickup(o: { token: string; apiUrl?: string; dataSource: string; schema?: NotionSchema; agentUser: string }): Promise<string[]> {
  const client = notionClient(o);
  const schema = o.schema ?? DEFAULT_SCHEMA;
  const source = normalizeId(o.dataSource);
  if (!source) throw new ConfigError(`NOTION_DATA_SOURCE_ID must be a Notion data source id, got ${JSON.stringify(o.dataSource)}`);
  const filter = pickupFilter(schema, o.agentUser);
  const path = `/data_sources/${source}/query`;
  const pages = await client.all(`POST ${path}`, (cursor) =>
    client.api(path, { method: "POST", body: JSON.stringify({ filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }) }));
  return pages
    .filter((p) => !p.in_trash && !p.archived)
    .filter((p) => flattenProperty(p.properties?.[schema.props.status]) === schema.statuses.pickup)
    .filter((p) => propertyMatches(p.properties?.[schema.props.assignee], o.agentUser))
    .map((p) => normalizeId(p.id))
    .filter((id): id is string => !!id);
}
