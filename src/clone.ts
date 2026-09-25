// Clones (or resumes) the one repo a run is allowed to touch, using a token scoped to a
// single git subprocess (via GIT_ASKPASS) rather than a credential written into git config.
// That way nothing token-bearing is left behind for the agent's own shell commands to read
// once this returns — see allowlist.ts for what "allowed" means, enforced by the caller
// before this runs at all.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Credential = { username: string; token: string };

function git(args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }): string {
  const res = spawnSync("git", args, { cwd: opts.cwd, env: opts.env, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout || res.error}`);
  return res.stdout.trim();
}

// A GIT_ASKPASS script answers git's username/password prompts for exactly the subprocess
// it's set on; it's never written to git config, so it doesn't outlive that one call.
function withCredential<T>(cred: Credential | undefined, run: (env: NodeJS.ProcessEnv) => T): T {
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
  defaultBranch: string;
  credential?: Credential;
}) {
  const resuming = existsSync(join(o.workDir, ".git"));
  withCredential(o.credential, (env) => {
    if (!resuming) {
      git(["clone", o.cloneUrl, o.workDir], { env });
    } else {
      git(["fetch", "origin"], { cwd: o.workDir, env });
    }
    // Continue the issue's branch if an earlier run already pushed it; otherwise start it
    // fresh off the default branch rather than whatever HEAD the cache happened to leave.
    const remoteBranch = git(["ls-remote", "--heads", "origin", o.branch], { cwd: o.workDir, env });
    const base = remoteBranch ? `origin/${o.branch}` : `origin/${o.defaultBranch}`;
    git(["checkout", "-B", o.branch, base], { cwd: o.workDir, env });
  });
}
