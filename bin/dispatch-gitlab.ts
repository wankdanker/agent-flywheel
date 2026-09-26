// CLI: turn a GitLab webhook (TRIGGER_PAYLOAD) or a manual run (ISSUE) into a
// child-pipeline YAML with at most one job, which either works that issue (by triggering
// .gitlab/agent-stages.yml's three stage jobs) or, for a split's sub-issue MR into its
// integration branch, moves that chain along (.gitlab/chain-stages.yml; see src/chain.ts).
// Runs on stock node with no npm install, so it (and what it imports) stays dependency-free.
import { readFileSync } from "node:fs";
import { BOT_MARKER, OPT_IN_LABEL, need } from "../src/tracker.ts";
import { gitlabMemberTrust } from "../src/trust.ts";

const titles = (labels: any[] = []) => labels.map((l) => l.title);

// Anyone who can comment could otherwise start a run with our secrets; require Developer+.
// Same membership check src/gitlab.ts uses to classify comment trust for the prompt, so
// "who can trigger a run" and "whose content the model sees" can't drift apart.
async function isDeveloper(userId: number) {
  const trust = await gitlabMemberTrust({
    apiUrl: need("CI_API_V4_URL"),
    project: need("CI_PROJECT_ID"),
    token: need("AGENT_GITLAB_TOKEN"),
    userId,
  });
  return trust === "trusted";
}

async function actionableIssue(p: any): Promise<number | undefined> {
  if (p.object_kind === "issue") {
    const a = p.object_attributes;
    if (a.state !== "opened" || !titles(p.labels).includes(OPT_IN_LABEL)) return;
    // Only when `agent` arrives (on open, reopen, or added later). Our own state-label
    // edits fire issue events too and must not re-trigger us. Adding labels needs Reporter+.
    const added = a.action === "open" || a.action === "reopen"
      || (p.changes?.labels && !titles(p.changes.labels.previous).includes(OPT_IN_LABEL));
    return added ? a.iid : undefined;
  }
  if (p.object_kind === "note" && p.object_attributes.noteable_type === "Issue") {
    const i = p.issue;
    if (i.state !== "opened" || !titles(i.labels).includes(OPT_IN_LABEL)) return;
    if (p.object_attributes.note.includes(BOT_MARKER)) return;
    return (await isDeveloper(p.user.id)) ? i.iid : undefined;
  }
}

const CHAIN_BRANCH = /^agent\/issue-\d+$/;

// A sub-issue MR (agent/issue-<n> → agent/issue-<parent>, both in this project): new commits get
// tested and, if they pass, merged; a merge advances the chain. advanceChain re-checks all of it
// against the issues themselves, so this only filters out what's obviously not ours.
function chainEvent(p: any): { mr: number; sha: string; action: "test" | "advance"; target: string } | undefined {
  if (p.object_kind !== "merge_request") return;
  const a = p.object_attributes;
  if (!Number.isInteger(a.iid) || a.source_project_id !== a.target_project_id || !CHAIN_BRANCH.test(a.source_branch) || !CHAIN_BRANCH.test(a.target_branch)) return;
  const sha = a.last_commit?.id;
  if (typeof sha !== "string" || !/^[0-9a-f]{40,64}$/.test(sha)) return;
  if (a.action === "merge") return { mr: a.iid, sha, action: "advance", target: a.target_branch };
  // `update` also fires for title/label edits; only new commits (`oldrev`) need a new test.
  if (a.state === "opened" && (a.action === "open" || a.action === "reopen" || (a.action === "update" && a.oldrev))) {
    return { mr: a.iid, sha, action: "test", target: a.target_branch };
  }
}

const payloadFile = process.env.TRIGGER_PAYLOAD;
const payload = payloadFile && !process.env.ISSUE ? JSON.parse(readFileSync(payloadFile, "utf8")) : undefined;
const chain = payload ? chainEvent(payload) : undefined;
const iid = process.env.ISSUE ? Number(process.env.ISSUE) : payload && !chain ? await actionableIssue(payload) : undefined;
const image = process.env.AGENT_IMAGE || `${need("CI_REGISTRY_IMAGE")}:latest`;
console.error(
  iid ? `[dispatch] issue #${iid} on ${image}`
    : chain ? `[dispatch] ${chain.action} sub-issue MR !${chain.mr} into ${chain.target}`
    : "[dispatch] event not actionable",
);

// GitLab rejects an empty child pipeline, so we always emit exactly one job. For an actionable
// issue that job triggers .gitlab/agent-stages.yml: the prepare/agent/publish jobs that keep the
// forge token and the model credential in separate containers (see src/stages.ts). It holds the
// per-issue resource_group until that whole pipeline is done (`strategy: depend`), so two runs
// on one issue never overlap, and its status is that pipeline's. For a sub-issue MR, the one job
// triggers .gitlab/chain-stages.yml instead, one chain at a time.
console.log(chain ? `
chain-mr-${chain.mr}:
  variables: { MR_IID: "${chain.mr}", MR_SHA: "${chain.sha}", CHAIN_ACTION: "${chain.action}" }
  resource_group: agent-chain-${chain.target.replace("/", "-")}   # one advance per chain at a time
  trigger:
    include: [{ local: .gitlab/chain-stages.yml }]
    strategy: depend
` : iid ? `
agent-issue-${iid}:
  variables: { ISSUE: "${iid}", AGENT_IMAGE: ${JSON.stringify(image)} }
  resource_group: agent-issue-${iid}   # never two runs on one issue
  trigger:
    include: [{ local: .gitlab/agent-stages.yml }]
    strategy: depend
` : `
nothing-to-do:
  image: alpine
  variables: { GIT_STRATEGY: none }
  script: [echo nothing to do]
`);
