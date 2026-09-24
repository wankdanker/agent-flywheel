// CLI: turn a GitLab webhook (TRIGGER_PAYLOAD) or a manual run (ISSUE) into a
// child-pipeline YAML with at most one job, which works that issue.
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

const payloadFile = process.env.TRIGGER_PAYLOAD;
const iid = process.env.ISSUE
  ? Number(process.env.ISSUE)
  : payloadFile ? await actionableIssue(JSON.parse(readFileSync(payloadFile, "utf8"))) : undefined;
const image = process.env.AGENT_IMAGE || `${need("CI_REGISTRY_IMAGE")}:latest`;
console.error(iid ? `[dispatch] issue #${iid} on ${image}` : "[dispatch] event not actionable");

// GitLab rejects an empty child pipeline, so we always emit exactly one job.
console.log(iid ? `
agent-issue-${iid}:
  image: { name: ${JSON.stringify(image)}, entrypoint: [""] }
  variables: { ISSUE: "${iid}", GIT_STRATEGY: none, WORK_DIR: "$CI_PROJECT_DIR/work" }
  resource_group: agent-issue-${iid}   # never two runs on one issue
  timeout: 2h
  # Cached per issue so a run that dies partway (turn limit, crash) doesn't lose its
  # clone; the next run on that issue resumes from it. "when: always" saves it even
  # when the job fails, which is the case that most needs resuming.
  cache:
    key: agent-work-issue-${iid}
    paths: [work]
    when: always
  script: [/opt/agent/entrypoint.sh]
  allow_failure: { exit_codes: [10] }   # 10 = asked a question; not a failure for us
` : `
nothing-to-do:
  image: alpine
  variables: { GIT_STRATEGY: none }
  script: [echo nothing to do]
`);
