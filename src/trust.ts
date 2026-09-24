// Who counts as trusted. One shared helper so prompt construction (what's safe to
// show the model) and dispatch (who can start a run) can't drift apart.
// No npm deps here, same as tracker.ts: bin/dispatch-gitlab.ts imports this on stock node.

export type Trust = "trusted" | "untrusted";

// Keep in sync with the `contains(fromJSON([...]))` list in .github/workflows/agent.yml;
// GitHub Actions expressions can't import this file, so that copy has to be kept by hand.
export const GITHUB_TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

export const trustFromGithubAssociation = (association: string | null | undefined): Trust =>
  association && GITHUB_TRUSTED_ASSOCIATIONS.includes(association) ? "trusted" : "untrusted";

// GitLab has no equivalent "association" field on notes/issues; membership has to be
// looked up per user. Developer (30) is the same floor bin/dispatch-gitlab.ts already
// required to let a comment trigger a run.
export const GITLAB_DEVELOPER_ACCESS_LEVEL = 30;

export async function gitlabMemberTrust(o: {
  apiUrl: string;
  project: string;
  token: string;
  userId: number;
}): Promise<Trust> {
  const res = await fetch(`${o.apiUrl}/projects/${encodeURIComponent(o.project)}/members/all/${o.userId}`, {
    headers: { "PRIVATE-TOKEN": o.token },
  });
  // Not a project member at all; that's "untrusted", not an error.
  if (res.status === 404) return "untrusted";
  if (!res.ok) throw new Error(`GitLab GET /members/all/${o.userId}: ${res.status} ${await res.text()}`);
  const member = await res.json();
  return member.access_level >= GITLAB_DEVELOPER_ACCESS_LEVEL ? "trusted" : "untrusted";
}
