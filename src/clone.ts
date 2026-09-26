// Clones (or resumes) the one repo a run is allowed to touch, using a token scoped to a
// single git subprocess (via GIT_ASKPASS) rather than a credential written into git config.
// That way nothing token-bearing is left behind for the agent's own shell commands to read
// once this returns — see allowlist.ts for what "allowed" means, enforced by the caller
// before this runs at all.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Credential = { username: string; token: string };

export function git(args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }): string {
  const res = spawnSync("git", args, { cwd: opts.cwd, env: opts.env, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout || res.error}`);
  return res.stdout.trim();
}

// A GIT_ASKPASS script answers git's username/password prompts for exactly the subprocess
// it's set on; it's never written to git config, so it doesn't outlive that one call.
export function withCredential<T>(cred: Credential | undefined, run: (env: NodeJS.ProcessEnv) => T): T {
  if (!cred) return run(process.env);
  const dir = mkdtempSync(join(tmpdir(), "agent-askpass-"));
  const script = join(dir, "askpass.sh");
  writeFileSync(
    script,
    `#!/bin/sh\ncase "$1" in\n  Username*) printf '%s' "$ASKPASS_USERNAME" ;;\n  *) printf '%s' "$ASKPASS_TOKEN" ;;\nesac\n`,
  );
  chmodSync(script, 0o700);
  try {
    return run({
      ...process.env,
      GIT_ASKPASS: script,
      GIT_TERMINAL_PROMPT: "0",
      ASKPASS_USERNAME: cred.username,
      ASKPASS_TOKEN: cred.token,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Belt-and-suspenders check for a resumed work dir: confirms the clone that's actually on
// disk points at the repo we think it does, in case a cache survived an allowlist change.
export function originUrl(workDir: string): string {
  return git(["remote", "get-url", "origin"], { cwd: workDir, env: process.env });
}

export function prepareRepo(o: {
  cloneUrl: string;
  workDir: string;
  branch: string;
  defaultBranch: string; // where a new branch starts: the default branch, or a sub-issue's integration branch
  credential?: Credential;
}) {
  const resuming = existsSync(o.workDir) && distrustGitDir(o.workDir, o.cloneUrl);
  withCredential(o.credential, (env) => {
    if (!resuming) {
      git(["clone", o.cloneUrl, o.workDir], { env });
    }
    // Continue the issue's branch if an earlier run already pushed it; otherwise start it
    // fresh off the default branch rather than whatever HEAD the cache happened to leave,
    // unless the cached branch is ahead of that (see resumePoint).
    const remoteBranch = git(["ls-remote", "--heads", "origin", o.branch], { cwd: o.workDir, env });
    const baseBranch = remoteBranch ? o.branch : o.defaultBranch;
    git(["fetch", "origin", `refs/heads/${baseBranch}`], { cwd: o.workDir, env });
    git(["update-ref", `refs/remotes/origin/${baseBranch}`, "FETCH_HEAD"], { cwd: o.workDir, env });
    const base = git(["rev-parse", "FETCH_HEAD"], { cwd: o.workDir, env });
    const start = resuming ? resumePoint(o.workDir, o.branch, `origin/${baseBranch}`, base, env) : base;
    git(["checkout", "-B", o.branch, start], { cwd: o.workDir, env });
  });
}

// A cached local branch that's ahead of `base` holds commits a crashed run never got to push:
// keep them (the publisher still validates every one before anything is pushed). One that's
// behind or has diverged is reset to `base`, as is a cache with no such branch at all.
function resumePoint(workDir: string, branch: string, baseName: string, base: string, env: NodeJS.ProcessEnv): string {
  let local: string;
  try {
    local = git(["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`], { cwd: workDir, env });
  } catch {
    return base;
  }
  if (local === base) return base;
  const ahead = spawnSync("git", ["merge-base", "--is-ancestor", base, local], { cwd: workDir, env }).status === 0;
  if (ahead) {
    const count = git(["rev-list", "--count", `${base}..${local}`], { cwd: workDir, env });
    console.log(`[clone] keeping ${count} unpushed commit(s) on the cached ${branch} (ahead of ${baseName})`);
    return local;
  }
  const behind = spawnSync("git", ["merge-base", "--is-ancestor", local, base], { cwd: workDir, env }).status === 0;
  console.log(`[clone] resetting the cached ${branch} (${local.slice(0, 12)}) to ${baseName}: it ${behind ? "is behind" : "has diverged from"} it`);
  return base;
}

// A cached work dir was last written by the agent (Bash, permissions bypassed), and the git
// calls above run in it with the forge token in their env. So before any of them, everything in
// `.git` that can run a command or redirect where git connects (config: credential helpers,
// fsmonitor, proxies, the remote's URL, includes; hooks; a gitdir/commondir pointer; object
// alternates) is replaced with a config of our own. The objects, refs and working tree stay:
// they're data to git. False (having removed the work dir, to be recloned) if there's no `.git`
// or it isn't a plain directory.
export function distrustGitDir(workDir: string, cloneUrl: string): boolean {
  const dotGit = join(workDir, ".git");
  if (!lstatSync(dotGit, { throwIfNoEntry: false })?.isDirectory()) {
    rmSync(workDir, { recursive: true, force: true });
    return false;
  }
  for (const f of ["config", "config.worktree", "hooks", "commondir", "info/attributes", "objects/info/alternates", "objects/info/http-alternates"]) {
    rmSync(join(dotGit, f), { recursive: true, force: true });
  }
  writeFileSync(
    join(dotGit, "config"),
    `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n` +
      `[remote "origin"]\n\turl = ${JSON.stringify(cloneUrl)}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    { flag: "wx" },
  );
  return true;
}
