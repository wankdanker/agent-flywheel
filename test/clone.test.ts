import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { originUrl, prepareRepo } from "../src/clone.ts";

const TOKEN = "SECRET-TOKEN-VALUE";

function git(args: string[], cwd: string) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

// A local bare repo stands in for the forge; file:// clones don't need credentials, but
// prepareRepo doesn't know that, so this still exercises the real GIT_ASKPASS plumbing.
function makeOrigin(root: string): string {
  const seed = join(root, "seed");
  git(["init", "-q", "-b", "main", seed], root);
  git(["-C", seed, "config", "user.email", "t@t.test"], root);
  git(["-C", seed, "config", "user.name", "t"], root);
  git(["-C", seed, "commit", "-q", "--allow-empty", "-m", "init"], root);
  const bare = join(root, "origin.git");
  git(["clone", "-q", "--bare", seed, bare], root);
  return bare;
}

test("prepareRepo clones fresh, checks out the issue branch, and leaves no token in git config", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-flywheel-clone-test-"));
  try {
    const cloneUrl = makeOrigin(root);
    const workDir = join(root, "work");

    prepareRepo({
      cloneUrl,
      workDir,
      branch: "agent/issue-1",
      defaultBranch: "main",
      credential: { username: "x-access-token", token: TOKEN },
    });

    assert.equal(git(["branch", "--show-current"], workDir), "agent/issue-1");

    // The credential must never survive as something a spawned subprocess can read back:
    // not in the clone's local config, not in the global config, not in our own env.
    const localConfig = git(["config", "--list"], workDir);
    assert.doesNotMatch(localConfig, new RegExp(TOKEN));
    const globalConfig = spawnSync("git", ["config", "--global", "--list"], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(globalConfig, new RegExp(TOKEN));
    assert.ok(!process.env.GIT_ASKPASS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRepo resumes a cached work dir on the branch a previous run already pushed", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-flywheel-clone-test-"));
  try {
    const cloneUrl = makeOrigin(root);
    const workDir = join(root, "work");

    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" });
    git(["checkout", "-b", "topic"], workDir); // simulate the agent's own work
    git(["push", "-q", "origin", "agent/issue-1"], workDir);

    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" });

    assert.equal(git(["branch", "--show-current"], workDir), "agent/issue-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("originUrl reports what a resumed work dir is actually a clone of", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-flywheel-clone-test-"));
  try {
    const cloneUrl = makeOrigin(root);
    const workDir = join(root, "work");
    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" });
    assert.equal(originUrl(workDir), cloneUrl);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
