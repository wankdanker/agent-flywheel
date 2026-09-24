// CLI: sync GitHub/GitLab repo labels from labels.json. Creates missing labels and
// fixes color/description drift. Only deletes labels absent from the file when it
// sets "prune": true, because deleting a label also strips it from every issue that has it.
// Runs on stock node with no npm install, so it (and what it imports) stays dependency-free.
import { readFileSync } from "node:fs";
import { need } from "../src/tracker.ts";

type LabelDef = { name: string; color: string; description?: string };
type LabelsFile = { labels: LabelDef[]; prune?: boolean };

const file: LabelsFile = JSON.parse(readFileSync(new URL("../labels.json", import.meta.url), "utf8"));
const wanted = new Map(file.labels.map((l) => [l.name, l]));

async function request(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}

async function syncGithub() {
  const base = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${need("GITHUB_REPOSITORY")}/labels`;
  const headers = {
    Authorization: `Bearer ${need("GH_TOKEN")}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  const existing: any[] = await request(`${base}?per_page=100`, { headers });
  const byName = new Map(existing.map((l) => [l.name, l]));

  for (const [name, def] of wanted) {
    const cur = byName.get(name);
    const body = { name, color: def.color, description: def.description ?? "" };
    if (!cur) {
      console.log(`[github] create ${name}`);
      await request(base, { method: "POST", headers, body: JSON.stringify(body) });
    } else if (cur.color !== def.color || (cur.description ?? "") !== (def.description ?? "")) {
      console.log(`[github] update ${name}`);
      await request(`${base}/${encodeURIComponent(name)}`, { method: "PATCH", headers, body: JSON.stringify(body) });
    }
  }

  if (!file.prune) return;
  for (const l of existing) {
    if (wanted.has(l.name)) continue;
    console.log(`[github] delete ${l.name}`);
    await request(`${base}/${encodeURIComponent(l.name)}`, { method: "DELETE", headers });
  }
}

async function syncGitlab() {
  const apiUrl = process.env.CI_API_V4_URL || `https://${need("CI_SERVER_HOST")}/api/v4`;
  const project = process.env.CI_PROJECT_ID || need("CI_PROJECT_PATH");
  const base = `${apiUrl}/projects/${encodeURIComponent(project)}/labels`;
  const headers = { "PRIVATE-TOKEN": need("AGENT_GITLAB_TOKEN"), "Content-Type": "application/json" };

  const existing: any[] = await request(`${base}?per_page=100`, { headers });
  const byName = new Map(existing.map((l) => [l.name, l]));

  for (const [name, def] of wanted) {
    const color = `#${def.color}`;
    const cur = byName.get(name);
    const body = { name, new_name: name, color, description: def.description ?? "" };
    if (!cur) {
      console.log(`[gitlab] create ${name}`);
      await request(base, { method: "POST", headers, body: JSON.stringify(body) });
    } else if ((cur.color ?? "").toLowerCase() !== color.toLowerCase() || (cur.description ?? "") !== (def.description ?? "")) {
      console.log(`[gitlab] update ${name}`);
      await request(`${base}/${encodeURIComponent(name)}`, { method: "PUT", headers, body: JSON.stringify(body) });
    }
  }

  if (!file.prune) return;
  for (const l of existing) {
    if (wanted.has(l.name)) continue;
    // Group labels are inherited, not owned by the project; deleting them 404s or 403s.
    try {
      console.log(`[gitlab] delete ${l.name}`);
      await request(`${base}/${encodeURIComponent(l.name)}`, { method: "DELETE", headers });
    } catch (err) {
      console.log(`[gitlab] skip ${l.name}: ${err}`);
    }
  }
}

const platform = process.env.AGENT_PLATFORM || (process.env.GITLAB_CI ? "gitlab" : process.env.GITHUB_ACTIONS ? "github" : "");
if (platform === "github") await syncGithub();
else if (platform === "gitlab") await syncGitlab();
else {
  console.error("can't tell the platform; set AGENT_PLATFORM to github or gitlab");
  process.exit(2);
}
