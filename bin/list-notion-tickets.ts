// CLI: the Notion tickets ready for pickup, as a JSON array of page ids on stdout, for a CI matrix
// (the scheduled notion-poll.yml; see README's "Notion tickets"). Ready means Status is To Do and
// Assignee includes NOTION_AGENT_USER_ID (src/notion.ts's pickupFilter). A ticket already Doing,
// Blocked or in review is never listed, so a poll doesn't re-dispatch a run under way, or one that
// stopped: those continue by their own relay (MAX_CHAINED_RUNS) or by a human moving them back to
// To Do. At most NOTION_MAX_PICKUP (default 5) per poll; the rest wait for the next one.
// Notion token only (NOTION_TOKEN, NOTION_DATA_SOURCE_ID). Runs on stock node with no npm install,
// so it (and what it imports) stays dependency-free.
import { listPickup, notionSchemaFromEnv } from "../src/notion.ts";
import { need } from "../src/tracker.ts";

const env = process.env;
const max = Number(env.NOTION_MAX_PICKUP || 5);
if (!Number.isInteger(max) || max < 0) {
  console.error(`NOTION_MAX_PICKUP must be a non-negative integer, got ${JSON.stringify(env.NOTION_MAX_PICKUP)}`);
  process.exit(2);
}

try {
  const pages = await listPickup({
    token: need("NOTION_TOKEN"),
    apiUrl: env.NOTION_API_URL || undefined,
    dataSource: need("NOTION_DATA_SOURCE_ID"),
    schema: notionSchemaFromEnv(env),
    agentUser: need("NOTION_AGENT_USER_ID"),
  });
  if (pages.length > max) console.error(`[notion] ${pages.length} tickets ready; dispatching ${max} (NOTION_MAX_PICKUP), the rest next poll`);
  console.log(JSON.stringify(pages.slice(0, max)));
} catch (err) {
  console.error("[notion] couldn't list tickets for pickup:", err instanceof Error ? err.message : err);
  process.exit(1);
}
