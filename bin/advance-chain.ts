// CLI: move a split's chain of sub-issues along after one of their PRs/MRs (src/chain.ts).
//   REVIEW=<PR/MR number>, or HEAD_BRANCH + HEAD_SHA to look it up (GitHub's workflow_run
//                          event names the branch and sha, not a merged PR's number)
//   MERGE_SHA=<sha>        merge it first, only if its head is still this sha (CI sets it once
//                          typecheck + tests passed on that sha); unset, it only advances an
//                          already-merged one
// Forge token only: GH_TOKEN + GITHUB_REPOSITORY on GitHub, AGENT_GITLAB_TOKEN + CI_API_V4_URL +
// CI_PROJECT_ID on GitLab. Never the model credential. Runs on stock node with no npm install,
// so it (and what it imports) stays dependency-free.
import { advanceChain } from "../src/chain.ts";
import { botIdentityFromEnv, githubChain } from "../src/github.ts";
import { gitlabChain } from "../src/gitlab.ts";
import { need } from "../src/tracker.ts";

const env = process.env;
const platform = env.AGENT_PLATFORM || (env.GITLAB_CI ? "gitlab" : env.GITHUB_ACTIONS ? "github" : "");
const forge =
  platform === "github"
    ? githubChain({ token: need("GH_TOKEN"), repo: need("GITHUB_REPOSITORY"), apiUrl: env.GITHUB_API_URL || undefined, self: botIdentityFromEnv(env) })
    : platform === "gitlab"
      ? gitlabChain({ token: need("AGENT_GITLAB_TOKEN"), apiUrl: need("CI_API_V4_URL"), project: need("CI_PROJECT_ID") })
      : (console.error("can't tell the platform; set AGENT_PLATFORM to github or gitlab"), process.exit(2));

const review = env.REVIEW ? Number(env.REVIEW) : await forge.findReview(need("HEAD_BRANCH"), need("HEAD_SHA"));
if (review === undefined) {
  console.log(`[chain] no PR/MR from ${env.HEAD_BRANCH} at ${env.HEAD_SHA}; nothing to do`);
  process.exit(0);
}
if (!Number.isInteger(review) || review < 1) {
  console.error(`REVIEW must be a PR/MR number, got ${JSON.stringify(env.REVIEW)}`);
  process.exit(2);
}
const sha = env.MERGE_SHA;
console.log(`[chain] ${await advanceChain(forge, { review, merge: sha ? { sha } : undefined })}`);
