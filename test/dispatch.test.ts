// When an issue event starts a run (src/dispatch.ts), and that both platforms' gates agree with
// it: one fixture matrix of issue states × comment bodies × commenters, run through
//   - decideComment itself,
//   - GitHub: agent.yml's prepare `if` (evaluated here with a small interpreter for the subset of
//     Actions expressions it uses) followed by the prepare stage's recheckTrigger, fed the
//     AGENT_TRIGGER/AGENT_COMMENT the workflow hands it,
//   - GitLab: bin/dispatch-gitlab.ts on a saved note payload, against a fake members API,
// each compared with the policy as stated in the issue (#15), written out independently below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideComment, isContinueCommand, recheckTrigger, triggerFromEnv } from "../src/dispatch.ts";
import { BOT_MARKER } from "../src/tracker.ts";

test("isContinueCommand: the first nonblank line, exactly, case-sensitive", () => {
  for (const body of [
    "/agent continue",
    "/agent continue  ",
    "\n\n  \n/agent continue\nand fix the docs this time",
    "\r\n/agent continue\r\nplease",
    "   /agent continue",
  ]) assert.equal(isContinueCommand(body), true, JSON.stringify(body));
  for (const body of [
    "",
    "Thanks!",
    "/Agent Continue",
    "/agent  continue",
    "/agent continued",
    "/agent continue please",
    "please /agent continue",
    "> /agent continue",
    "```\n/agent continue\n```",
    "    /agent continue",
    "\t/agent continue",
    "Thanks!\n/agent continue",
    "`/agent continue`",
  ]) assert.equal(isContinueCommand(body), false, JSON.stringify(body));
});

// ---- the fixture matrix ----

const STATES: Record<string, string[]> = {
  unstarted: ["agent"],
  working: ["agent", "agent/working"],
  blocked: ["agent", "agent/blocked"],
  review: ["agent", "agent/review"],
  "queued (no agent label yet)": ["agent/queued"],
  "blocked without agent": ["agent/blocked"],
};

const BODIES: Record<string, { body: string; command: boolean }> = {
  thanks: { body: "Thanks!", command: false },
  mention: { body: "@someone can you take a look at the PR?", command: false },
  command: { body: "/agent continue", command: true },
  "command + directive": { body: "\n/agent continue\nAlso update the README.", command: true },
  "wrong case": { body: "/Agent Continue", command: false },
  quoted: { body: "> /agent continue\n\nNo, not yet.", command: false },
  fenced: { body: "```\n/agent continue\n```\nThat's the command.", command: false },
  inline: { body: "I'd rather not /agent continue yet.", command: false },
  "bot marker": { body: `Blocked.\n\n${BOT_MARKER}`, command: false },
  "bot marker + command": { body: `/agent continue\n\n${BOT_MARKER}`, command: true },
};

type Fixture = { name: string; labels: string[]; body: string; command: boolean; trusted: boolean; open: boolean; onPullRequest: boolean };

const fixtures: Fixture[] = [];
for (const [s, labels] of Object.entries(STATES)) {
  for (const [b, { body, command }] of Object.entries(BODIES)) {
    for (const trusted of [true, false]) {
      fixtures.push({ name: `${s} / ${b} / ${trusted ? "trusted" : "untrusted"}`, labels, body, command, trusted, open: true, onPullRequest: false });
    }
  }
}
for (const body of ["/agent continue", "Thanks!"]) {
  fixtures.push({ name: `closed / ${body}`, labels: STATES.blocked!, body, command: isContinueCommand(body), trusted: true, open: false, onPullRequest: false });
  fixtures.push({ name: `PR comment / ${body}`, labels: STATES.blocked!, body, command: isContinueCommand(body), trusted: true, open: true, onPullRequest: true });
}

// The policy, straight from the issue.
const expected = (f: Fixture) =>
  f.open && !f.onPullRequest && f.labels.includes("agent") && f.trusted && !f.body.includes(BOT_MARKER) &&
  (f.command || f.labels.includes("agent/blocked"));

test("fixtures cover every state with ordinary replies, commands and non-commands", () => {
  assert.ok(fixtures.some((f) => expected(f) && !f.command), "a reply that resumes");
  assert.ok(fixtures.some((f) => expected(f) && f.command && f.labels.includes("agent/review")), "a forced rerun of a review issue");
  assert.ok(fixtures.some((f) => !expected(f) && f.labels.includes("agent/working") && f.trusted && !f.command), "an ignored comment on working");
});

test("decideComment matches the policy on every fixture", () => {
  for (const f of fixtures) {
    const d = decideComment(f);
    assert.equal(d.run, expected(f), `${f.name}: ${d.reason}`);
    if (d.run) assert.equal(d.trigger, f.command ? "command" : "comment", f.name);
  }
});

test("recheckTrigger: a queued run only starts if its reason still holds", () => {
  assert.equal(recheckTrigger(undefined, []).run, true);
  assert.equal(recheckTrigger("manual", ["agent/review"]).run, true);
  assert.equal(recheckTrigger("label", ["agent"]).run, true);
  assert.equal(recheckTrigger("label", []).run, false);
  assert.equal(recheckTrigger("command", ["agent", "agent/working"]).run, true);
  assert.equal(recheckTrigger("command", ["agent/review"]).run, false);
  assert.equal(recheckTrigger("comment", ["agent", "agent/blocked"]).run, true);
  for (const s of ["agent/working", "agent/review", "agent/queued"]) assert.equal(recheckTrigger("comment", ["agent", s]).run, false, s);
  assert.equal(recheckTrigger("comment", ["agent"]).run, false);
});

test("triggerFromEnv: a comment trigger is upgraded to a command only by a strict command body", () => {
  assert.equal(triggerFromEnv({}), undefined);
  assert.equal(triggerFromEnv({ AGENT_TRIGGER: "comment", AGENT_COMMENT: "/agent continue" }), "command");
  assert.equal(triggerFromEnv({ AGENT_TRIGGER: "comment", AGENT_COMMENT: "> /agent continue" }), "comment");
  assert.equal(triggerFromEnv({ AGENT_TRIGGER: "comment" }), "comment");
  assert.equal(triggerFromEnv({ AGENT_TRIGGER: "label", AGENT_COMMENT: "/agent continue" }), "label");
  assert.throws(() => triggerFromEnv({ AGENT_TRIGGER: "Comment" }), /AGENT_TRIGGER/);
});

// ---- GitHub: agent.yml's gate, evaluated ----

// Just enough of GitHub Actions' expression language for agent.yml's gates: literals, property
// paths (with `.*.` object filters), ! == != && || (which yield an operand, as in Actions),
// parentheses, and contains/startsWith/fromJSON (string comparisons ignore case, as in Actions).
function evaluate(src: string, ctx: Record<string, unknown>): unknown {
  const tokens = src.match(/'(?:[^']|'')*'|==|!=|&&|\|\||[!().,*]|[A-Za-z_][\w-]*|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const eat = (t?: string) => {
    const tok = tokens[i++];
    if (t !== undefined && tok !== t) throw new Error(`expected ${t}, got ${tok} in ${src}`);
    return tok!;
  };
  const truthy = (v: unknown) => !(v === null || v === undefined || v === false || v === 0 || v === "");
  const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v);
  const fns: Record<string, (...a: any[]) => unknown> = {
    contains: (hay, needle) => Array.isArray(hay)
      ? hay.some((x) => lower(x) === lower(needle))
      : String(hay ?? "").toLowerCase().includes(String(needle ?? "").toLowerCase()),
    startsWith: (s, p) => String(s ?? "").toLowerCase().startsWith(String(p ?? "").toLowerCase()),
    fromJSON: (s) => JSON.parse(s),
  };
  const or = (): unknown => {
    let v = and();
    while (peek() === "||") { eat(); const r = and(); v = truthy(v) ? v : r; }
    return v;
  };
  const and = (): unknown => {
    let v = unary();
    while (peek() === "&&") { eat(); const r = unary(); v = truthy(v) ? r : v; }
    return v;
  };
  const unary = (): unknown => {
    if (peek() === "!") { eat(); return !truthy(unary()); }
    const l = primary();
    if (peek() === "==" || peek() === "!=") { const op = eat(); const r = primary(); return (lower(l) === lower(r)) === (op === "=="); }
    return l;
  };
  const primary = (): unknown => {
    const t = eat();
    if (t === "(") { const v = or(); eat(")"); return v; }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (t === "true" || t === "false") return t === "true";
    if (peek() === "(") {
      eat("(");
      const args: unknown[] = [];
      while (peek() !== ")") { args.push(or()); if (peek() === ",") eat(","); }
      eat(")");
      return fns[t]!(...args);
    }
    let v: any = ctx[t];
    while (peek() === ".") {
      eat(".");
      const k = eat();
      v = k === "*" ? (Array.isArray(v) ? v : []) : Array.isArray(v) ? v.map((x) => x?.[k]) : v?.[k] ?? null;
    }
    return v;
  };
  const v = or();
  if (i !== tokens.length) throw new Error(`trailing tokens in ${src}: ${tokens.slice(i).join(" ")}`);
  return v;
}

const workflow = readFileSync("./.github/workflows/agent.yml", "utf8");
// A `key: >-` folded scalar's text, from the block starting at `from`.
function folded(from: string, key: string): string {
  const start = workflow.indexOf(from);
  const lines = workflow.slice(start).split("\n");
  const at = lines.findIndex((l) => l.trimStart().startsWith(`${key}: >-`));
  const indent = lines[at]!.search(/\S/);
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break;
    body.push(l.trim());
  }
  return body.join(" ");
}
const gate = folded("\n  prepare:", "if");
const group = folded("\nconcurrency:", "group");
const triggerExpr = /AGENT_TRIGGER: \$\{\{ (.*) \}\}/.exec(workflow)![1]!;
const commentExpr = /AGENT_COMMENT: \$\{\{ (.*) \}\}/.exec(workflow)![1]!;

test("agent.yml: the concurrency group repeats the prepare job's `if` exactly", () => {
  const cond = /^\$\{\{ \((.*)\)\s+&& format\('agent-issue-\{0\}'/.exec(group)?.[1];
  assert.ok(cond, group);
  assert.equal(cond.replace(/\s+/g, " "), gate.replace(/\s+/g, " "));
});

const commentEvent = (f: Fixture) => ({
  event_name: "issue_comment",
  event: {
    issue: {
      number: 7, state: f.open ? "open" : "closed", labels: f.labels.map((name) => ({ name })),
      ...(f.onPullRequest ? { pull_request: { url: "https://api.github.com/repos/a/b/pulls/7" } } : {}),
    },
    comment: { body: f.body, author_association: f.trusted ? "MEMBER" : "CONTRIBUTOR" },
  },
});

// What a GitHub run does with an event: the job's `if`, then (if it passes) prepare's re-check
// with the env the workflow gives it, against the same labels (nothing changed in between).
function githubRuns(github: Record<string, unknown>, labels: string[]) {
  if (!evaluate(gate, { github, inputs: {} })) return false;
  const env = { AGENT_TRIGGER: String(evaluate(triggerExpr, { github })), AGENT_COMMENT: String(evaluate(commentExpr, { github }) ?? "") };
  return recheckTrigger(triggerFromEnv(env), labels).run;
}

test("GitHub: agent.yml's gate plus prepare's re-check match the policy on every comment fixture", () => {
  for (const f of fixtures) assert.equal(githubRuns(commentEvent(f), f.labels), expected(f), f.name);
});

test("GitHub: the gate alone already queues nothing for a comment that doesn't mention the command", () => {
  // So an ordinary comment never even displaces a pending run in the issue's concurrency group.
  for (const f of fixtures.filter((f) => !/\/agent continue/i.test(f.body))) {
    assert.equal(Boolean(evaluate(gate, { github: commentEvent(f), inputs: {} })), expected(f), f.name);
  }
});

test("GitHub: adding `agent` starts the initial run; other label events and manual dispatch", () => {
  const labeled = (name: string, labels: string[]) => ({ event_name: "issues", event: { label: { name }, issue: { number: 7, labels: labels.map((n) => ({ name: n })) } } });
  assert.equal(githubRuns(labeled("agent", ["agent"]), ["agent"]), true);
  for (const s of ["agent/working", "agent/blocked", "agent/review", "agent/queued", "bug"]) {
    assert.equal(githubRuns(labeled(s, ["agent", s]), ["agent", s]), false, s);
  }
  // workflow_dispatch runs whatever the issue's state.
  for (const labels of Object.values(STATES)) assert.equal(githubRuns({ event_name: "workflow_dispatch", event: {} }, labels), true);
});

// ---- GitLab: bin/dispatch-gitlab.ts on saved payloads ----

const TRUSTED_USER = 1, UNTRUSTED_USER = 2;

async function withMembersApi<T>(fn: (apiUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    const m = /\/members\/all\/(\d+)$/.exec(req.url ?? "");
    if (m && Number(m[1]) === TRUSTED_USER) return void res.end(JSON.stringify({ access_level: 30 }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v4`);
  } finally {
    server.close();
  }
}

function dispatch(apiUrl: string, payload: unknown, extraEnv: Record<string, string> = {}): Promise<{ out: string; log: string }> {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-"));
  const file = join(dir, "payload.json");
  writeFileSync(file, JSON.stringify(payload ?? {}));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/dispatch-gitlab.ts"], {
      env: {
        PATH: process.env.PATH, TRIGGER_PAYLOAD: file, CI_REGISTRY_IMAGE: "registry.example/agent",
        CI_API_V4_URL: apiUrl, CI_PROJECT_ID: "3", AGENT_GITLAB_TOKEN: "glpat-test", ...extraEnv,
      },
    });
    let out = "", log = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      code === 0 ? resolve({ out, log }) : reject(new Error(`dispatch exited ${code}: ${log}`));
    });
  });
}

const titled = (labels: string[]) => labels.map((title) => ({ title }));
const notePayload = (f: Fixture) => ({
  object_kind: "note",
  user: { id: f.trusted ? TRUSTED_USER : UNTRUSTED_USER },
  object_attributes: { noteable_type: "Issue", note: f.body },
  issue: { iid: 7, state: f.open ? "opened" : "closed", labels: titled(f.labels) },
});

test("GitLab: the dispatcher matches the policy on every comment fixture, and logs why", async () => {
  // GitLab has no PR comments on issues (MR notes have another noteable_type).
  const cases = fixtures.filter((f) => !f.onPullRequest);
  await withMembersApi(async (api) => {
    for (let at = 0; at < cases.length; at += 8) {
      await Promise.all(cases.slice(at, at + 8).map(async (f) => {
        const { out, log } = await dispatch(api, notePayload(f));
        const runs = /agent-issue-7:/.test(out);
        assert.equal(runs, expected(f), `${f.name}\n${log}`);
        if (runs) assert.match(out, new RegExp(`AGENT_TRIGGER: "${f.command ? "command" : "comment"}"`), f.name);
        else assert.match(log, /\[dispatch\] event not actionable: \S/, f.name);
      }));
    }
  });
});

test("GitLab: adding `agent` starts the initial run; state-label edits don't; a manual run always does", async () => {
  const issueEvent = (action: string, labels: string[], previous?: string[]) => ({
    object_kind: "issue",
    object_attributes: { iid: 7, state: "opened", action },
    labels: titled(labels),
    ...(previous ? { changes: { labels: { previous: titled(previous), current: titled(labels) } } } : {}),
  });
  await withMembersApi(async (api) => {
    for (const [payload, runs] of [
      [issueEvent("open", ["agent"]), true],
      [issueEvent("update", ["agent"], []), true],
      [issueEvent("update", ["agent", "agent/working"], ["agent"]), false],
      [issueEvent("update", ["agent", "agent/review"], ["agent", "agent/working"]), false],
      [issueEvent("update", ["agent", "agent/blocked"], ["agent", "agent/working"]), false],
    ] as const) {
      const { out } = await dispatch(api, payload);
      assert.equal(/agent-issue-7:/.test(out), runs, JSON.stringify(payload));
      if (runs) assert.match(out, /AGENT_TRIGGER: "label"/);
    }
    const { out } = await dispatch(api, undefined, { ISSUE: "7" });
    assert.match(out, /agent-issue-7:/);
    assert.match(out, /AGENT_TRIGGER: "manual"/);
  });
});
