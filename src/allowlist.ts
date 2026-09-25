// Which repo(s) the agent may clone or push to. Without this, an issue's own text is the
// only thing steering where a broad forge token gets used — nothing stops it from naming a
// different repo the same token can reach. Kept npm-dependency-free like tracker.ts.
export function parseAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.AGENT_REPO_ALLOWLIST || env.GITHUB_REPOSITORY || env.CI_PROJECT_PATH || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Pulls "owner/repo" out of an https or ssh clone URL (GitHub or GitLab, nested groups and
// all), so it can be compared against the allowlist regardless of how the URL is spelled.
export function repoIdentifier(cloneUrl: string): string | null {
  const m = cloneUrl.trim().match(/^(?:[a-z][\w+.-]*:\/\/(?:[^/@]+@)?[^/]+|[^/@]+@[^:]+:)\/?(.+?)(?:\.git)?\/?$/i);
  return m ? m[1]!.toLowerCase() : null;
}

export function isAllowedRepo(cloneUrl: string, allowlist: string[]): boolean {
  const id = repoIdentifier(cloneUrl);
  if (!id) return false;
  return allowlist.some((a) => a.trim().toLowerCase() === id);
}
