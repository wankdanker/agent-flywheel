// CLI: list Notion "tickets" database pages assigned to the bot and ready for
// pickup, as a JSON array of page ids on stdout (consumed by a CI matrix).
// The schema isn't pinned down yet, so property *names* are env-configurable
// with best-guess defaults and property *values* are matched across whatever
// property type the database turns out to use (see src/notion.ts). Stock
// node, no npm deps, like bin/dispatch-gitlab.ts.
import { need } from "../src/tracker.ts";
import { notionFetch, propertyMatches } from "../src/notion.ts";

const token = need("NOTION_TOKEN");
const databaseId = need("NOTION_DATABASE_ID");
const assigneeProperty = process.env.NOTION_ASSIGNEE_PROPERTY || "Assignee";
const assigneeValue = need("NOTION_ASSIGNEE_VALUE");
const readyProperty = process.env.NOTION_READY_PROPERTY || "Status";
const readyValue = process.env.NOTION_READY_VALUE || "Ready";

async function readyTickets(): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notionFetch(token, `/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify(cursor ? { start_cursor: cursor } : {}),
    });
    for (const page of res.results) {
      if (propertyMatches(page.properties[assigneeProperty], assigneeValue) &&
          propertyMatches(page.properties[readyProperty], readyValue)) {
        ids.push(page.id);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return ids;
}

const ids = await readyTickets();
console.error(`[notion] ${ids.length} ticket(s) ready`);
console.log(JSON.stringify(ids));
