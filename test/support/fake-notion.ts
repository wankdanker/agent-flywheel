// An in-memory Notion, served through a fake `fetch`: just the endpoints src/notion.ts uses (pages,
// block children, comments, users, data-source query), with real cursor pagination and auth/version
// checks, and page/comment state that later requests read back. Requests to any other host go to
// `next` (a FakeForge for the code host, say), so one fetch serves a whole Notion → GitLab run.
import { notionTracker, type NotionCode, type NotionSchema } from "../../src/notion.ts";
import { gitlabCodeHost } from "../../src/gitlab.ts";
import type { Tracker } from "../../src/tracker.ts";
import { GITLAB_API, TOKEN } from "./fake-forge.ts";

export const NOTION_TOKEN = "ntn_fakeNOTIONtoken0123456789";
export const NOTION_API = "https://api.notion.com/v1";
export const PAGE = "5a5e2609-db59-4119-8e1f-e144fb29175f";
export const DATA_SOURCE = "d2f541d5-faea-40a9-b7ce-216c61544124";
export const USERS = {
  dan: "11111111-1111-4111-8111-111111111111", // trusted
  agent: "22222222-2222-4222-8222-222222222222", // the person the agent is assigned as
  bot: "33333333-3333-4333-8333-333333333333", // our integration (/users/me)
  rando: "44444444-4444-4444-8444-444444444444", // a workspace member nobody trusted
  otherBot: "55555555-5555-4555-8555-555555555555", // some other integration
};
const NAMES: Record<string, string> = { [USERS.dan]: "Dan", [USERS.agent]: "Flywheel Agent", [USERS.bot]: "Agent Flywheel", [USERS.rando]: "Rando", [USERS.otherBot]: "Other Integration" };

export type Block = { type: string; text?: string; checked?: boolean; language?: string; children?: Block[] };
export type NotionSeed = {
  id?: string;
  number?: number;
  prefix?: string;
  title?: string;
  status?: string;
  assignees?: string[];
  createdBy?: string;
  repo?: string;
  repoType?: "rich_text" | "url";
  blocks?: Block[];
  comments?: { author: string; text: string; rich?: unknown[] }[];
  reviewLink?: string;
};

type Stored = { id: string; type: string; has_children: boolean; [k: string]: unknown };

export class FakeNotion {
  pages = new Map<string, NotionSeed & { id: string }>();
  comments = new Map<string, { created_by: { id: string }; created_time: string; rich_text: any[] }[]>();
  blocks = new Map<string, Stored[]>();
  requests: { method: string; url: string; body?: any }[] = [];
  patches: { page: string; properties: Record<string, any> }[] = [];
  failMe = false;
  next?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private clock = 0;
  private nextBlock = 1;

  constructor(...seeds: NotionSeed[]) {
    for (const s of seeds) this.add(s);
  }

  add(s: NotionSeed) {
    const id = s.id ?? PAGE;
    this.pages.set(id, { ...s, id });
    this.comments.set(id, (s.comments ?? []).map((c) => ({
      created_by: { id: c.author },
      created_time: this.now(),
      rich_text: c.rich ?? [{ type: "text", plain_text: c.text, text: { content: c.text } }],
    })));
    this.store(id, s.blocks ?? []);
  }

  private store(parent: string, blocks: Block[]) {
    this.blocks.set(parent, blocks.map((b) => {
      const id = `b${String(this.nextBlock++).padStart(31, "0")}`;
      if (b.children?.length) this.store(id, b.children);
      const body: Record<string, unknown> = { rich_text: [{ type: "text", plain_text: b.text ?? "" }] };
      if (b.checked !== undefined) body.checked = b.checked;
      if (b.language) body.language = b.language;
      if (b.type === "child_page") body.title = b.text;
      return { id, type: b.type, has_children: Boolean(b.children?.length), [b.type]: body };
    }));
  }

  private now() {
    return `2026-10-05T12:00:${String(this.clock++).padStart(2, "0")}.000Z`;
  }

  page(id = PAGE) {
    return this.pages.get(id)!;
  }

  // Our own comments as Notion shows them: the joined plain text.
  posted(id = PAGE): string[] {
    return this.comments.get(id)!.filter((c) => c.created_by.id === USERS.bot).map((c) => c.rich_text.map((t) => t.plain_text).join(""));
  }

  private properties(p: NotionSeed & { id: string }) {
    return {
      Name: { type: "title", title: [{ plain_text: p.title ?? "Fix the export" }] },
      ID: { type: "unique_id", unique_id: { prefix: p.prefix === undefined ? "PRO" : p.prefix || null, number: p.number ?? 3801 } },
      Status: { type: "status", status: p.status === undefined ? { name: "To Do" } : { name: p.status } },
      Assignee: { type: "people", people: (p.assignees ?? [USERS.agent]).map((id) => ({ object: "user", id, name: NAMES[id] })) },
      Type: { type: "select", select: { name: "Bug" } },
      ...(p.repoType === "url"
        ? { Repo: { type: "url", url: p.repo ?? null } }
        : { Repo: { type: "rich_text", rich_text: p.repo ? [{ plain_text: p.repo }] : [] } }),
      "GitLab Link": { type: "url", url: p.reviewLink ?? null },
    };
  }

  private pageJson(p: NotionSeed & { id: string }) {
    return {
      object: "page",
      id: p.id,
      url: `https://www.notion.so/Fix-the-export-${p.id.replace(/-/g, "")}`,
      created_by: { object: "user", id: p.createdBy ?? USERS.dan },
      properties: this.properties(p),
    };
  }

  // One page of `items` from the request's start_cursor (an index) and page_size.
  private paged<T>(items: T[], cursor: string | null | undefined, size: unknown) {
    const start = Number(cursor ?? 0);
    const per = Number(size ?? 100);
    const end = start + per;
    return { object: "list", results: items.slice(start, end), has_more: end < items.length, next_cursor: end < items.length ? String(end) : null };
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.href.startsWith(`${NOTION_API}/`)) {
      if (this.next) return this.next(input, init);
      throw new Error(`fake notion: unhandled ${url.href}`);
    }
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, url: url.href, body });
    if (headers.authorization !== `Bearer ${NOTION_TOKEN}`) return json({ code: "unauthorized" }, 401);
    if (headers["notion-version"] !== "2025-09-03") return json({ code: "missing_version" }, 400);
    const p = url.pathname.replace(/^\/v1/, "");

    if (method === "GET" && p === "/users/me") return this.failMe ? json({ code: "restricted_resource" }, 403) : json({ object: "user", id: USERS.bot, type: "bot" });
    const user = /^\/users\/([^/]+)$/.exec(p);
    if (method === "GET" && user) return NAMES[user[1]!] ? json({ object: "user", id: user[1], name: NAMES[user[1]!] }) : json({ code: "object_not_found" }, 404);
    const page = /^\/pages\/([^/]+)$/.exec(p);
    if (page && this.pages.has(page[1]!)) {
      const seed = this.pages.get(page[1]!)!;
      if (method === "GET") return json(this.pageJson(seed));
      if (method === "PATCH") {
        this.patches.push({ page: seed.id, properties: body.properties });
        for (const [k, v] of Object.entries(body.properties as Record<string, any>)) {
          if (k === "Status") seed.status = v.status.name;
          else if (k === "GitLab Link") seed.reviewLink = v.url;
          else return json({ code: "validation_error", message: `${k} is not a property that exists` }, 400);
        }
        return json(this.pageJson(seed));
      }
    }
    const children = /^\/blocks\/([^/]+)\/children$/.exec(p);
    if (method === "GET" && children) {
      return json(this.paged(this.blocks.get(children[1]!) ?? [], url.searchParams.get("start_cursor"), url.searchParams.get("page_size")));
    }
    if (method === "GET" && p === "/comments") {
      const list = this.comments.get(url.searchParams.get("block_id") ?? "");
      if (!list) return json({ code: "object_not_found" }, 404);
      return json(this.paged(list, url.searchParams.get("start_cursor"), url.searchParams.get("page_size")));
    }
    if (method === "POST" && p === "/comments") {
      const list = this.comments.get(body.parent.page_id)!;
      for (const t of body.rich_text) if (t.text.content.length > 2000) return json({ code: "validation_error" }, 400);
      list.push({ created_by: { id: USERS.bot }, created_time: this.now(), rich_text: body.rich_text.map((t: any) => ({ ...t, plain_text: t.text.content })) });
      return json({ object: "comment" });
    }
    const query = /^\/data_sources\/([^/]+)\/query$/.exec(p);
    if (method === "POST" && query) {
      if (query[1] !== DATA_SOURCE) return json({ code: "object_not_found" }, 404);
      const [status, assignee] = body.filter.and;
      const all = [...this.pages.values()].map((s) => this.pageJson(s)).filter((pg) =>
        pg.properties.Status.status.name === status.status.equals && pg.properties.Assignee.people.some((u: any) => u.id === assignee.people.contains));
      return json(this.paged(all, body.start_cursor, body.page_size));
    }
    throw new Error(`fake notion: unhandled ${method} ${url.href}`);
  };

  // A tracker on this page whose code lands on the FakeForge GitLab (gitlab.example).
  tracker(o: { schema?: NotionSchema; trusted?: string[]; relay?: () => Promise<void>; page?: string } = {}): Tracker {
    return notionTracker({
      token: NOTION_TOKEN,
      page: o.page ?? PAGE,
      schema: o.schema,
      trusted: o.trusted ?? [USERS.dan],
      agentUser: USERS.agent,
      code: gitlabCode(),
      relay: o.relay,
    });
  }
}

export const gitlabCode = (): NotionCode => ({
  platform: "gitlab",
  host: "gitlab.example",
  build: (project) => gitlabCodeHost({ token: TOKEN.gitlab, apiUrl: GITLAB_API, project }),
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
