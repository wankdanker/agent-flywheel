// bin/dispatch-gitlab.ts for sub-issue MR events (src/chain.ts): run as CI runs it, on a saved
// payload. Issue/note payloads that need the members API aren't covered here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA = "a".repeat(40);

function dispatch(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-"));
  try {
    const file = join(dir, "payload.json");
    writeFileSync(file, JSON.stringify(payload));
    const res = spawnSync(process.execPath, ["bin/dispatch-gitlab.ts"], {
      env: { PATH: process.env.PATH, TRIGGER_PAYLOAD: file, CI_REGISTRY_IMAGE: "registry.example/agent" },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mr = (over: Record<string, unknown>) => ({
  object_kind: "merge_request",
  object_attributes: {
    iid: 5, action: "open", state: "opened", source_branch: "agent/issue-21", target_branch: "agent/issue-12",
    source_project_id: 3, target_project_id: 3, last_commit: { id: SHA }, ...over,
  },
});

test("dispatch: a new sub-issue MR into its integration branch → test-and-merge chain pipeline", () => {
  const out = dispatch(mr({}));
  assert.match(out, /chain-mr-5:/);
  assert.match(out, new RegExp(`MR_SHA: "${SHA}"`));
  assert.match(out, /CHAIN_ACTION: "test"/);
  assert.match(out, /local: \.gitlab\/chain-stages\.yml/);
  assert.match(out, /resource_group: agent-chain-agent-issue-12/);
  assert.match(dispatch(mr({ action: "update", oldrev: "b".repeat(40) })), /CHAIN_ACTION: "test"/);
});

test("dispatch: a merged sub-issue MR → advance only", () => {
  assert.match(dispatch(mr({ action: "merge", state: "merged" })), /CHAIN_ACTION: "advance"/);
});

test("dispatch: other MRs, forks, and non-commit updates do nothing", () => {
  for (const over of [
    { target_branch: "main" },
    { source_branch: "feature/x" },
    { source_project_id: 4 },
    { action: "update" },
    { action: "close", state: "closed" },
    { last_commit: { id: "not a sha\n  script: [evil]" } },
    { target_branch: "agent/issue-12\n  evil: 1" },
  ]) {
    assert.match(dispatch(mr(over)), /nothing-to-do:/, JSON.stringify(over));
  }
});
