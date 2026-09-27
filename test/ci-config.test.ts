// The CI side of the credential split (src/stages.ts): whatever each job's container is handed
// with `-e`, the agent job must get no forge token and the prepare/publish jobs no model
// credential. Plain text checks over the workflow files, since there's no YAML parser in our
// deps; they only need to find each job's block and the variable names in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_CREDENTIAL_VARS } from "../src/stages.ts";
import { FORGE_TOKEN_VARS } from "../src/model-proxy.ts";

const FORGE = FORGE_TOKEN_VARS;

// Top-level blocks at `indent` spaces: name → text up to the next key at that indent.
function blocks(text: string, indent: number): Map<string, string> {
  const out = new Map<string, string>();
  const key = new RegExp(`^ {${indent}}([\\w.-]+):`);
  let name: string | undefined;
  for (const line of text.split("\n")) {
    const m = key.exec(line);
    if (m) name = m[1];
    else if (name && line.length && !line.startsWith(" ".repeat(indent + 1)) && !line.startsWith("#")) name = undefined;
    if (name) out.set(name, `${out.get(name) ?? ""}${line}\n`);
  }
  return out;
}

// The names a block mentions, ignoring comments (which explain what's left out).
const mentions = (block: string, names: string[]) => {
  const code = block.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
  return names.filter((n) => new RegExp(`\\b${n}\\b`).test(code));
};

test("GitHub agent.yml: the agent job gets no forge token; prepare and publish get no model credential", () => {
  const jobsText = readFileSync("./.github/workflows/agent.yml", "utf8").split(/^jobs:\n/m)[1]!;
  const jobs = blocks(jobsText, 2);
  for (const name of ["prepare", "agent", "publish"]) assert.ok(jobs.has(name), `no ${name} job`);

  const agent = jobs.get("agent")!;
  // The runner's own GITHUB_TOKEN logs in to GHCR on the host; it never goes into the container.
  const agentCode = agent.replace(/^.*docker login ghcr\.io.*$/m, "");
  assert.deepEqual(mentions(agentCode, FORGE), []);
  assert.deepEqual(mentions(agent, MODEL_CREDENTIAL_VARS.slice(0, 2)).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.match(agent, /--stage agent/);

  for (const name of ["prepare", "publish"]) {
    const job = jobs.get(name)!;
    assert.deepEqual(mentions(job, MODEL_CREDENTIAL_VARS), [], `${name} job mentions a model credential`);
    assert.match(job, /-e GH_TOKEN/);
    assert.match(job, new RegExp(`--stage ${name}`));
  }
});

test("GitLab agent-stages.yml: the agent job's container gets no forge token; prepare and publish get no model credential", () => {
  const jobs = blocks(readFileSync("./.gitlab/agent-stages.yml", "utf8"), 0);
  const stage = (name: string) => {
    const job = jobs.get(`agent-${name}`);
    assert.ok(job, `no agent-${name} job`);
    const run = /run_stage (\w+)((?:.*\\\n)*.*)/.exec(job);
    assert.ok(run, `agent-${name} doesn't run_stage`);
    assert.equal(run[1], name);
    return run[2]!;
  };
  assert.deepEqual(mentions(stage("agent"), FORGE), []);
  assert.deepEqual(mentions(stage("agent"), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]).length, 2);
  for (const name of ["prepare", "publish"]) {
    assert.deepEqual(mentions(stage(name), MODEL_CREDENTIAL_VARS), [], `agent-${name} passes a model credential`);
    assert.match(stage(name), /-e AGENT_GITLAB_TOKEN/);
  }
  // run_stage passes only what each job lists (plus ISSUE): no --env-file, no `-e` of the whole env.
  const shared = jobs.get(".stage")!;
  assert.doesNotMatch(shared, /--env-file|--env /);
});

test("both platforms hand the caps to the stage that enforces them: MAX_BUDGET_USD to agent, MAX_CHAINED_RUNS to prepare and publish", () => {
  const gh = blocks(readFileSync("./.github/workflows/agent.yml", "utf8").split(/^jobs:\n/m)[1]!, 2);
  const gl = blocks(readFileSync("./.gitlab/agent-stages.yml", "utf8"), 0);
  for (const [name, vars] of [["prepare", ["MAX_CHAINED_RUNS"]], ["agent", ["MAX_BUDGET_USD"]], ["publish", ["MAX_CHAINED_RUNS"]]] as const) {
    for (const v of vars) {
      assert.match(gh.get(name)!, new RegExp(`-e ${v}\\b`), `agent.yml ${name} doesn't pass ${v}`);
      assert.match(gl.get(`agent-${name}`)!, new RegExp(`-e ${v}\\b`), `agent-stages.yml agent-${name} doesn't pass ${v}`);
    }
  }
  // Only publish (forge token only) relays, so only it gets actions: write to dispatch agent.yml.
  assert.match(gh.get("publish")!, /actions: write/);
  for (const name of ["prepare", "agent"]) assert.doesNotMatch(gh.get(name)!, /actions: write/, name);
  // GitLab runs the relay's api-sourced pipeline only when it says it's a relay.
  assert.match(readFileSync("./.gitlab/ci/agent.yml", "utf8"), /\$CI_PIPELINE_SOURCE == "api" && \$ISSUE && \$AGENT_TRIGGER == "relay"/);
});

test("GitHub chain workflows: the PR-code ones get no secret; the one holding the forge token runs from the default branch", () => {
  for (const f of ["chain-test", "chain-merged"]) {
    const text = readFileSync(`./.github/workflows/${f}.yml`, "utf8");
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ""), /secrets\./, `${f}.yml must not reference any secret`);
    assert.match(text, /^\s+branches: \["agent\/issue-\*"\]/m);
  }
  assert.match(readFileSync("./.github/workflows/chain-test.yml", "utf8"), /persist-credentials: false/);
  const chain = readFileSync("./.github/workflows/chain.yml", "utf8");
  assert.deepEqual(mentions(chain, MODEL_CREDENTIAL_VARS), []);
  // Only workflow_run (always the default branch's copy of this file) and manual runs: never a
  // pull_request/pull_request_target trigger, which would run a PR-controlled workflow file.
  assert.doesNotMatch(chain, /^\s+pull_request/m);
  assert.match(chain, /workflows: \[chain-test, chain-merged\]/);
  assert.match(chain, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(chain, /MERGE_SHA: \$\{\{ github\.event\.workflow_run\.name == 'chain-test'/);
});

test("GitLab chain-stages.yml: the MR's code runs in a container handed no variables; no job passes a model credential", () => {
  const text = readFileSync("./.gitlab/chain-stages.yml", "utf8");
  const jobs = blocks(text, 0);
  const run = /docker run[^\n]*/.exec(jobs.get("chain-test")!)![0];
  assert.doesNotMatch(run, /\s-e\s|--env/);
  for (const name of ["chain-test", "chain-merge", "chain-advance"]) {
    assert.ok(jobs.has(name), `no ${name} job`);
    assert.deepEqual(mentions(jobs.get(name)!, MODEL_CREDENTIAL_VARS), [], `${name} mentions a model credential`);
  }
  assert.match(jobs.get("chain-merge")!, /MERGE_SHA="\$MR_SHA" node bin\/advance-chain\.ts/);
  assert.doesNotMatch(jobs.get("chain-advance")!, /MERGE_SHA/);
});

test("no CI pipeline runs the live model eval (npm run eval:live is manual, and refuses in PR/MR pipelines)", () => {
  const files = [
    ...readdirSync("./.github/workflows").map((f) => `./.github/workflows/${f}`),
    "./.gitlab-ci.yml",
    ...readdirSync("./.gitlab", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".yml")).map((f) => `./.gitlab/${f}`),
  ];
  assert.ok(files.length > 5);
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /eval:live|eval-live|src\/eval/, f);
});

// Opt-in workspace persistence (bin/persist.sh). The bucket credential lives only in the host
// steps that run persist.sh; with PERSISTENCE_BUCKET unset, those steps are skipped and the
// cache handoff and the chown before each `docker run` are exactly what they were.
const PERSIST_CREDS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "PERSISTENCE_GCS_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG"];

// A job's steps, each from its `- ` line to the next.
const steps = (job: string) => job.split(/^ {6}- /m).slice(1);
const ifOf = (step: string) => /^\s+if: (.*)$/m.exec(step)?.[1] ?? "";

test("GitHub agent.yml persistence: the bucket credential is only in persist.sh steps, which run no container; cache steps only run with it off", () => {
  const jobs = blocks(readFileSync("./.github/workflows/agent.yml", "utf8").split(/^jobs:\n/m)[1]!, 2);
  for (const name of ["prepare", "agent", "publish"]) {
    const all = steps(jobs.get(name)!);
    const persist = all.filter((s) => /persist\.sh" (restore|save)/.test(s));
    assert.deepEqual(persist.map((s) => /persist\.sh" (\w+)/.exec(s)![1]), ["restore", "save"], `${name}: one restore, one save`);
    for (const s of all) {
      const creds = mentions(s, PERSIST_CREDS);
      if (persist.includes(s)) {
        assert.deepEqual(creds.sort(), ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "PERSISTENCE_GCS_KEY"], `${name}: ${s.split("\n")[0]}`);
        assert.doesNotMatch(s, /docker (run|create)|\s-e\s/, `${name}: a credentialed step runs a container`);
        assert.deepEqual(mentions(s, [...MODEL_CREDENTIAL_VARS, ...FORGE]), [], `${name}: persist step holds another secret`);
        assert.match(ifOf(s), /env\.PERSISTENCE_BUCKET != ''/);
      } else {
        assert.deepEqual(creds, [], `${name}: ${s.split("\n")[0]} mentions a bucket credential`);
      }
      if (/uses: actions\/cache/.test(s)) assert.match(ifOf(s), /env\.PERSISTENCE_BUCKET == ''/, `${name}: ${s.split("\n")[0]}`);
    }
    // Sync, trim, unmount and upload even after a failed or cancelled run.
    assert.match(ifOf(persist[1]!), /^always\(\) && /);
    const order = all.map((s) => (persist[0] === s ? "restore" : persist[1] === s ? "save" : /"\$IMAGE" --stage /.test(s) ? "run" : "")).filter(Boolean);
    assert.deepEqual(order, ["restore", "run", "save"], name);
  }
  assert.match(steps(jobs.get("publish")!).find((s) => /persist\.sh" restore/.test(s))!, /restore agent-work --read-only/);
});

// The `run:` script of a job's `docker run … --stage <name>` step, executed against a fake
// `docker` and `sudo` that log their argv.
function runStageStep(job: string, stage: string, env: Record<string, string>) {
  const step = steps(job).find((s) => s.includes(`"$IMAGE" --stage ${stage}`))!;
  const script = step.split(/^ {8}run: \|\n/m)[1]!.split("\n").filter((l) => l.startsWith("          ") || !l.trim()).map((l) => l.slice(10)).join("\n");
  const root = mkdtempSync(join(tmpdir(), "agent-flywheel-ci-test-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "docker $*" >> "${root}/log"\n[ "$4" != id ] || echo 1000\n`);
    writeFileSync(join(bin, "sudo"), `#!/bin/sh\necho "sudo $*" >> "${root}/log"\n`);
    chmodSync(join(bin, "docker"), 0o755);
    chmodSync(join(bin, "sudo"), 0o755);
    writeFileSync(join(root, "log"), "");
    const res = spawnSync("bash", ["-e", "-c", script], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, IMAGE: "img", ISSUE: "1", GITHUB_OUTPUT: join(root, "out"), ...env },
    });
    assert.equal(res.status, 0, res.stderr);
    return readFileSync(join(root, "log"), "utf8").split("\n").filter(Boolean);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("GitHub agent.yml: persistence off chowns agent-work to the image's user as before; on, runs the container as the runner user, no chown", () => {
  const jobs = blocks(readFileSync("./.github/workflows/agent.yml", "utf8").split(/^jobs:\n/m)[1]!, 2);
  const me = `${process.getuid!()}:${process.getgid!()}`;
  for (const stage of ["prepare", "agent", "publish"]) {
    const off = runStageStep(jobs.get(stage)!, stage, { PERSISTENCE_BUCKET: "" });
    assert.ok(off.includes("sudo chown -R 1000:1000 agent-work"), `${stage}: ${off.join("\n")}`);
    const run = off.find((l) => l.includes("--stage"))!;
    assert.match(run, /^docker run --rm -e /, `${stage}: nothing added to the docker run when off`);
    assert.doesNotMatch(run, /--user/);

    const on = runStageStep(jobs.get(stage)!, stage, { PERSISTENCE_BUCKET: "s3://bucket" });
    assert.ok(!on.some((l) => l.startsWith("sudo")), `${stage}: no sudo with persistence`);
    assert.match(on.find((l) => l.includes("--stage"))!, new RegExp(`^docker run --rm --user ${me} -e `));
  }
});

test("GitLab agent-stages.yml persistence: no container is handed a bucket credential; every job saves before it exits, with after_script as a backstop", () => {
  const text = readFileSync("./.gitlab/agent-stages.yml", "utf8");
  const jobs = blocks(text, 0);
  for (const name of ["prepare", "agent", "publish"]) {
    const job = jobs.get(`agent-${name}`)!;
    const run = /run_stage (\w+)((?:.*\\\n)*.*)/.exec(job)![2]!;
    assert.deepEqual(mentions(run, PERSIST_CREDS), [], `agent-${name} hands a bucket credential to its container`);
    assert.match(job, /persist_restore[^\n]*\n\s+run_stage /, `agent-${name} restores right before its run`);
    assert.match(job, /persist_save\n\s+exit "\$code"/, `agent-${name} saves before it exits`);
  }
  assert.match(jobs.get("agent-publish")!, /persist_restore --read-only/);
  const shared = jobs.get(".stage")!;
  assert.match(shared, /after_script:\n(?:\s+#.*\n)?\s+- '\[ ! -f persist\.sh \] \|\| bash persist\.sh save work'/);
  // Exit 3 (can't loop-mount) is the only restore failure that falls back to the cache.
  assert.match(shared, /if \[ "\$rc" = 3 \]; then\n\s+echo "PERSISTENCE_BUCKET is set, but this runner can't loop-mount/);
  assert.deepEqual(mentions(text.replace(/^.*docker login.*$/m, ""), PERSIST_CREDS), []);
});

test("persist-cleanup.yml: deletes a closed issue's image holding only the bucket credential, inside the issue's concurrency group", () => {
  const text = readFileSync("./.github/workflows/persist-cleanup.yml", "utf8");
  assert.match(text, /issues:\n\s+types: \[closed\]/);
  assert.match(text, /group: agent-issue-\$\{\{ github\.event\.issue\.number \}\}/);
  assert.match(text, /if: vars\.PERSISTENCE_BUCKET != ''/);
  assert.match(text, /run: bash bin\/persist\.sh delete/);
  assert.deepEqual(mentions(text, [...MODEL_CREDENTIAL_VARS, ...FORGE]), []);
  assert.doesNotMatch(text, /docker run/);
  // The arbitrary-uid smoke test only gates :latest for repos that opted in.
  const smoke = steps(blocks(readFileSync("./.github/workflows/build.yml", "utf8").split(/^jobs:\n/m)[1]!, 2).get("smoke")!);
  const asUser = smoke.find((s) => s.includes("--user"))!;
  assert.equal(ifOf(asUser), "vars.PERSISTENCE_BUCKET != ''");
  assert.match(asUser, /docker run --rm --user "\$\(id -u\):\$\(id -g\)" /);
});
