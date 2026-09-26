import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    git(["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"], workDir);

    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" });

    assert.equal(git(["branch", "--show-current"], workDir), "agent/issue-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The cached work dir was last written by the agent, and resuming it runs git with the token in
// its env: nothing the agent left in .git may get to run, or to redirect where git connects.
test("prepareRepo resumes a hostile cached work dir without running its config or hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-flywheel-clone-test-"));
  try {
    const cloneUrl = makeOrigin(root);
    const workDir = join(root, "work");
    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" });

    const pwned = join(root, "pwned");
    const evil = join(root, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\nenv > ${pwned}\n`);
    chmodSync(evil, 0o755);
    git(["config", "credential.helper", `!${evil}`], workDir);
    git(["config", "core.fsmonitor", evil], workDir);
    git(["config", "remote.origin.url", join(root, "elsewhere.git")], workDir);
    writeFileSync(join(workDir, ".git", "hooks", "post-checkout"), `#!/bin/sh\n${evil}\n`);
    chmodSync(join(workDir, ".git", "hooks", "post-checkout"), 0o755);
    writeFileSync(join(workDir, "notes.txt"), "uncommitted work\n");

    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main", credential: { username: "x", token: TOKEN } });

    assert.ok(!existsSync(pwned), "something the agent planted in .git ran");
    assert.equal(originUrl(workDir), cloneUrl);
    assert.equal(git(["branch", "--show-current"], workDir), "agent/issue-1");
    assert.ok(existsSync(join(workDir, "notes.txt")), "the working tree should survive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRepo reclones when the cached .git isn't a plain directory", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-flywheel-clone-test-"));
  try {
    const cloneUrl = makeOrigin(root);
    const workDir = join(root, "work");
    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" });
    rmSync(join(workDir, ".git"), { recursive: true });
    symlinkSync(join(root, "origin.git"), join(workDir, ".git"));

    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" });

    assert.equal(git(["rev-parse", "--is-bare-repository"], workDir), "false");
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

function commitIn(workDir: string, msg: string): string {
  git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", msg], workDir);
  return git(["rev-parse", "HEAD"], workDir);
}

function captureLog<T>(fn: () => T): { result: T; logs: string } {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { result: fn(), logs: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

// A run that committed and then crashed before anything was pushed (#48): the cache is all
// that holds those commits, so resuming must not reset them away.
test("prepareRepo keeps unpushed commits on a cached branch that's ahead of the default branch", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-flywheel-clone-test-"));
  try {
    const cloneUrl = makeOrigin(root);
    const workDir = join(root, "work");
    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" });
    commitIn(workDir, "one");
    const head = commitIn(workDir, "two");

    const { logs } = captureLog(() => prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" }));

    assert.equal(git(["branch", "--show-current"], workDir), "agent/issue-1");
    assert.equal(git(["rev-parse", "HEAD"], workDir), head);
    assert.match(logs, /keeping 2 unpushed commit\(s\) on the cached agent\/issue-1 \(ahead of origin\/main\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRepo keeps unpushed commits on top of the branch an earlier run pushed", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-flywheel-clone-test-"));
  try {
    const cloneUrl = makeOrigin(root);
    const workDir = join(root, "work");
    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" });
    commitIn(workDir, "pushed");
    git(["push", "-q", "origin", "agent/issue-1"], workDir);
    const head = commitIn(workDir, "not pushed");

    const { logs } = captureLog(() => prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" }));

    assert.equal(git(["rev-parse", "HEAD"], workDir), head);
    assert.match(logs, /keeping 1 unpushed commit\(s\) .*ahead of origin\/agent\/issue-1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRepo resets a cached branch that has diverged from the remote one, and says so", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-flywheel-clone-test-"));
  try {
    const cloneUrl = makeOrigin(root);
    const workDir = join(root, "work");
    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" });
    commitIn(workDir, "pushed");
    git(["push", "-q", "origin", "agent/issue-1"], workDir);
    const remote = commitIn(workDir, "pushed later, e.g. by a maintainer");
    git(["push", "-q", "origin", "agent/issue-1"], workDir);
    git(["reset", "-q", "--hard", "HEAD~1"], workDir);
    commitIn(workDir, "local only");

    const { logs } = captureLog(() => prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" }));

    assert.equal(git(["rev-parse", "HEAD"], workDir), remote);
    assert.match(logs, /resetting the cached agent\/issue-1 \([0-9a-f]{12}\) to origin\/agent\/issue-1: it has diverged from it/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRepo fast-forwards a cached branch that's behind the remote one", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-flywheel-clone-test-"));
  try {
    const cloneUrl = makeOrigin(root);
    const workDir = join(root, "work");
    prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" });
    const remote = commitIn(workDir, "pushed");
    git(["push", "-q", "origin", "agent/issue-1"], workDir);
    git(["reset", "-q", "--hard", "HEAD~1"], workDir);

    const { logs } = captureLog(() => prepareRepo({ cloneUrl, workDir, branch: "agent/issue-1", defaultBranch: "main" }));

    assert.equal(git(["rev-parse", "HEAD"], workDir), remote);
    assert.match(logs, /resetting the cached agent\/issue-1 .* it is behind it/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
