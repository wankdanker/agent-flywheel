import { ConfigError } from "./config-error.ts";

// Which repo(s) the agent may clone or push to. Without this, an issue's own text is the
// only thing steering where a broad forge token gets used — nothing stops it from naming a
// different repo the same token can reach. Kept npm-dependency-free like tracker.ts.
//
// Entries are `owner/repo` (exact), `owner/*` (any repo directly under owner), `group/**`
// (any project at any depth under group, not group itself), or `*` inside a segment
// (`owner/whisper-*`, any run of characters except `/`). Malformed entries throw a
// ConfigError rather than silently matching nothing (or everything).
export function parseAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.AGENT_REPO_ALLOWLIST || env.GITHUB_REPOSITORY || env.CI_PROJECT_PATH || "";
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const e of entries) {
    const problem = patternProblem(e);
    if (problem) throw new ConfigError(`AGENT_REPO_ALLOWLIST entry ${JSON.stringify(e)} is invalid: ${problem}`);
  }
  return entries;
}

const SEGMENT = /^[A-Za-z0-9_.*-]+$/;

// Why `entry` isn't a valid allowlist pattern, or undefined if it is.
export function patternProblem(entry: string): string | undefined {
  if (/:\/\/|@|:/.test(entry)) return "use owner/repo or group/project, not a URL or host";
  const segs = entry.split("/");
  if (segs.length < 2) return "needs at least owner/repo (or owner/*, group/**)";
  for (const [i, seg] of segs.entries()) {
    if (seg === "") return "empty path segment";
    if (seg === "." || seg === "..") return `"${seg}" isn't allowed as a path segment`;
    if (!SEGMENT.test(seg)) return "only letters, digits, _ . - and * are allowed in a segment";
    if (i === 0 && seg.includes("*")) return "the first segment must be literal, or the entry would allow everything the token can reach";
    if (seg.includes("**") && !(seg === "**" && i === segs.length - 1)) return "** is only allowed as the final whole segment";
  }
  return undefined;
}

// Pulls "owner/repo" out of an https or ssh clone URL (GitHub or GitLab, nested groups and
// all), so it can be compared against the allowlist regardless of how the URL is spelled.
export function repoIdentifier(cloneUrl: string): string | null {
  const m = cloneUrl.trim().match(/^(?:[a-z][\w+.-]*:\/\/(?:[^/@]+@)?[^/]+|[^/@]+@[^:]+:)\/?(.+?)(?:\.git)?\/?$/i);
  return m ? m[1]!.toLowerCase() : null;
}

// One segment of a pattern against one segment of a repo path: everything literal except `*`.
function segmentMatches(pattern: string, seg: string): boolean {
  if (!pattern.includes("*")) return pattern === seg;
  const re = pattern.split("*").map((s) => s.replace(/[\\^$.|?+()[\]{}*]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${re}$`).test(seg);
}

// Matched segment by segment, never as one free-form regex. An invalid pattern (one that
// didn't come through parseAllowlist) matches nothing.
export function matchesPattern(id: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (patternProblem(p)) return false;
  const want = p.split("/");
  const have = id.toLowerCase().split("/");
  if (have.some((s) => s === "" || s === "." || s === "..")) return false;
  if (want.at(-1) === "**") {
    const prefix = want.slice(0, -1);
    return have.length > prefix.length && prefix.every((w, i) => segmentMatches(w, have[i]!));
  }
  return have.length === want.length && want.every((w, i) => segmentMatches(w, have[i]!));
}

export function isAllowedRepo(cloneUrl: string, allowlist: string[]): boolean {
  const id = repoIdentifier(cloneUrl);
  if (!id) return false;
  return allowlist.some((a) => matchesPattern(id, a));
}
