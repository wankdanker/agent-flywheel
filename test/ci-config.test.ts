// The CI side of the credential split (src/stages.ts): whatever each job's container is handed
// with `-e`, the agent job must get no forge token and the prepare/publish jobs no model
// credential. Plain text checks over the workflow files, since there's no YAML parser in our
// deps; they only need to find each job's block and the variable names in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
