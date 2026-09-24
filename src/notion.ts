// Our thin Notion REST client. Unlike GitHub/GitLab, a Notion ticket has no
// inherent repo and no fixed schema we can rely on, so property *names* and
// *values* are read from env vars (see .env.example) with best-guess defaults,
// and property *values* are matched generically across the Notion property
// types a "tickets" database might reasonably use. Once a real NOTION_TOKEN and
// database are available, introspect the schema and tighten these defaults (or
// bake them into a skill) instead of guessing further here.
import { toComment, withMarker, type Tracker, type TicketState } from "./tracker.ts";

const NOTION_VERSION = "2022-06-28";

export async function notionFetch(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Notion ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Flattens a Notion property value to plain text, across the property types a
// "tickets" database is likely to use. Unknown types read as empty.
export function propertyText(prop: any): string {
  if (!prop) return "";
  switch (prop.type) {
    case "title": return (prop.title ?? []).map((t: any) => t.plain_text).join("");
    case "rich_text": return (prop.rich_text ?? []).map((t: any) => t.plain_text).join("");
    case "select": return prop.select?.name ?? "";
    case "status": return prop.status?.name ?? "";
    case "multi_select": return (prop.multi_select ?? []).map((s: any) => s.name).join(", ");
    case "url": return prop.url ?? "";
    case "people": return (prop.people ?? []).map((p: any) => p.name ?? p.id).join(", ");
    case "checkbox": return String(prop.checkbox ?? false);
    case "number": return String(prop.number ?? "");
    default: return "";
  }
}

// Whether a property's value equals `value`, checking array-valued types
// (people, multi_select) element-wise instead of via the joined string above.
export function propertyMatches(prop: any, value: string): boolean {
  if (!prop) return false;
  switch (prop.type) {
    case "people": return (prop.people ?? []).some((p: any) => p.id === value || p.name === value);
    case "multi_select": return (prop.multi_select ?? []).some((s: any) => s.name === value);
    case "checkbox": return String(prop.checkbox ?? false) === value.toLowerCase();
    default: return propertyText(prop) === value;
  }
}

function propertyUrl(prop: any): string {
  if (prop?.type === "url") return prop.url ?? "";
  const text = propertyText(prop);
  return /^https?:\/\//.test(text) ? text : "";
}

// A short, stable id for branch names and display, since Notion page ids are
// UUIDs, not the sequential numbers the rest of this repo assumes.
function shortId(pageId: string) {
  return pageId.replace(/-/g, "").slice(0, 8);
}

function blockText(b: any): string {
  const rt = b[b.type]?.rich_text;
  const text = Array.isArray(rt) ? rt.map((t: any) => t.plain_text).join("") : "";
  if (!text) return "";
  if (b.type === "bulleted_list_item" || b.type === "numbered_list_item") return `- ${text}`;
  if (b.type === "to_do") return `${b.to_do?.checked ? "[x]" : "[ ]"} ${text}`;
  return text;
}

async function paginate(token: string, path: string, param: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const q = cursor ? `${path}${path.includes("?") ? "&" : "?"}${param}=${cursor}` : path;
    const res: any = await notionFetch(token, q);
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

export function notionTracker(o: { token: string; pageId: string }): Tracker {
  const repoProperty = process.env.NOTION_REPO_PROPERTY || "Repo";
  const statusProperty = process.env.NOTION_STATUS_PROPERTY || "Status";
  // Notion's dedicated "Status" property type is the most likely fit for a ticket
  // tracker; set to "select" if the database uses a Select property instead.
  const statusPropertyType = process.env.NOTION_STATUS_PROPERTY_TYPE || "status";
  const statusValue: Record<TicketState, string> = {
    working: process.env.NOTION_STATUS_WORKING || "agent/working",
    blocked: process.env.NOTION_STATUS_BLOCKED || "agent/blocked",
    review: process.env.NOTION_STATUS_REVIEW || "agent/review",
  };

  const page = () => notionFetch(o.token, `/pages/${o.pageId}`);

  const userNames = new Map<string, string>();
  async function userName(id: string | undefined) {
    if (!id) return "unknown";
    if (!userNames.has(id)) {
      const name = await notionFetch(o.token, `/users/${id}`).then((u: any) => u.name ?? id).catch(() => id);
      userNames.set(id, name);
    }
    return userNames.get(id)!;
  }

  return {
    platform: "notion",

    // Best-effort: reads an explicit repo property on the ticket. Absent (the
    // common case until a mapping exists), callers fall back to the
    // `notion-ticket` skill to work out the target repo.
    async repo() {
      const url = propertyUrl((await page()).properties?.[repoProperty]);
      if (!url) return { cloneUrl: "", webUrl: "", defaultBranch: "" };
      return { cloneUrl: url.endsWith(".git") ? url : `${url.replace(/\/$/, "")}.git`, webUrl: url, defaultBranch: "main" };
    },

    async getTicket() {
      const p = await page();
      const titleProp = Object.values(p.properties as Record<string, any>).find((v: any) => v.type === "title");
      const title = propertyText(titleProp) || shortId(o.pageId);
      const blocks = await paginate(o.token, `/blocks/${o.pageId}/children`, "start_cursor");
      const body = blocks.map(blockText).filter(Boolean).join("\n");
      // Notion has no hidden-comment syntax like HTML, so unlike on GitHub/GitLab
      // the marker is visible in the Notion UI, not just in rendered markdown.
      const notes = await paginate(o.token, `/comments?block_id=${o.pageId}`, "start_cursor");
      const comments = await Promise.all(notes.map(async (n: any) => toComment(
        await userName(n.created_by?.id),
        (n.rich_text ?? []).map((t: any) => t.plain_text).join(""),
        n.created_time,
      )));
      return { number: shortId(o.pageId), url: p.url, title, body, labels: [], comments };
    },

    async comment(text) {
      await notionFetch(o.token, "/comments", {
        method: "POST",
        body: JSON.stringify({ parent: { page_id: o.pageId }, rich_text: [{ text: { content: withMarker(text) } }] }),
      });
    },

    async setState(state) {
      await notionFetch(o.token, `/pages/${o.pageId}`, {
        method: "PATCH",
        body: JSON.stringify({ properties: { [statusProperty]: { [statusPropertyType]: { name: statusValue[state] } } } }),
      });
    },
  };
}
