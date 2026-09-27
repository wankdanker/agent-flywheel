// Runs one scenario (test/fixtures/<name>/) end to end with no network, Docker or credentials:
// the real main() or the real prepare → agent → publish stages, the real githubTracker or
// gitlabTracker talking to an in-memory forge (fake-forge.ts), and a fake agent engine in place
// of the model. The engine is a scripted stand-in for the SDK's query(): it reads the prompt
// worker.ts built, then "calls" worker.ts's real MCP tool handlers (validating the input
// against each tool's own schema, as the SDK does, so malformed calls are rejected the same
// way), then ends the session the way the script says.
//
// The SDK mock has to be installed before anything imports src/worker.ts, so this module never
// imports it (or run.ts/stages.ts) statically: runScenario() imports them on first use. A test
// file using this must not statically import them either.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { mock } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CLONE_URL, FakeForge, GITLAB_API, REPO, type Platform, type Seed } from "./fake-forge.ts";

// What the fake model does in its one session. `calls` go through the ticket tools in order;
// then the session throws `throw` (a provider error, say) or ends with `result`.
export type EngineScript = {
  calls?: { tool: string; input: unknown }[];
  result?: "success" | "error_max_turns" | "error_max_budget_usd";
  throw?: string;
};

export type Scenario = {
  description: string;
  platform: Platform;
  mode: "main" | "stages";
  issue: Seed;
  env?: Record<string, string>;
  engine: EngineScript;
  // What the publisher finds committed over the base branch (0: nothing to push).
  commits?: number;
  // Forge requests that fail: `path` is a regex over the URL path.
  forgeFailures?: { method: string; path: string; status: number; body?: string; times?: number; skip?: number }[];
};

export type Expected = {
  // Whether the model gets a session at all, and what it's shown: the trusted input.
  prompt: null | { includes: string[]; excludes: string[] };
  branch: string;
  base: string;
  outcome: string;
  // main(): [code]; stages: [prepare, agent, publish].
  exitCodes: number[];
  labels: string[];
  // Our comments in order, each matched by a regex; nothing else of ours may be posted.
  comments: string[];
  commentsExclude?: string[];
  clones?: number; // default 1; the prepare stage refuses an untrusted issue before cloning
  reviews: number;
  relays: number;
  pushes: number;
  toolErrors?: string[];
};

export type Fixture = { name: string; scenario: Scenario; expected: Expected };

export const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");

export function loadFixtures(dir = FIXTURES_DIR): Fixture[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      scenario: JSON.parse(readFileSync(join(dir, d.name, "scenario.json"), "utf8")),
      expected: JSON.parse(readFileSync(join(dir, d.name, "expected.json"), "utf8")),
    }));
}

// ---- The fake engine ----

type Session = { prompts: string[]; toolErrors: string[]; options?: any };
let script: EngineScript = {};
let session: Session = { prompts: [], toolErrors: [] };
let tools: any[] = [];

const sdk = await import("@anthropic-ai/claude-agent-sdk");
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    ...sdk,
    createSdkMcpServer: (opts: any) => {
      tools = opts.tools;
      return { type: "sdk", name: opts.name, instance: {} };
    },
    query: (params: any) => {
      async function* run() {
        for await (const m of params.prompt) {
          session.prompts.push(m.message.content);
          break;
        }
        session.options = params.options;
        for (const call of script.calls ?? []) {
          const t = tools.find((x) => x.name === call.tool);
          if (!t) {
            session.toolErrors.push(`no such tool: ${call.tool}`);
            continue;
          }
          const parsed = z.object(t.inputSchema).safeParse(call.input);
          if (!parsed.success) {
            session.toolErrors.push(`${call.tool}: invalid input`);
            continue;
          }
          const res = await t.handler(parsed.data, {});
          if (res.isError) session.toolErrors.push(`${call.tool}: ${res.content.map((c: any) => c.text).join(" ")}`);
        }
        if (script.throw) throw new Error(script.throw);
        yield { type: "result", subtype: script.result ?? "success", num_turns: (script.calls?.length ?? 0) + 1, total_cost_usd: 0.01 };
      }
      return run();
    },
  },
});

// ---- Running a scenario ----

export type ScenarioResult = {
  forge: FakeForge;
  codes: number[];
  logs: string;
  prompt: string | undefined;
  toolErrors: string[];
  outcome: string;
  cloned: { branch: string; defaultBranch: string }[];
  pushes: { branch: string; defaultBranch: string }[];
};

type Mockable = { mock: { method: (obj: object, name: string, impl: Function) => unknown } };

export async function runScenario(t: Mockable, s: Scenario, forge = new FakeForge(s.platform, s.issue), workRoot?: string): Promise<ScenarioResult> {
  const { main } = await import("../../src/run.ts");
  const { prepareStage, agentStage, publishStage } = await import("../../src/stages.ts");

  for (const f of s.forgeFailures ?? []) forge.failNext(f.method, new RegExp(f.path), f.status, f.body, f.times, f.skip);
  t.mock.method(globalThis, "fetch", forge.fetch);
  script = s.engine;
  session = { prompts: [], toolErrors: [] };

  const root = workRoot ?? mkdtempSync(join(tmpdir(), "scenario-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const common: Record<string, string> = {
    AGENT_PLATFORM: s.platform, ISSUE: String(s.issue.number), AGENT_REPO_ALLOWLIST: REPO, WORK_DIR: join(root, "work"),
    MAX_TURNS: "30", HOME: home, PATH: process.env.PATH ?? "",
    ...(s.platform === "github" ? { GITHUB_REPOSITORY: REPO } : { CI_API_V4_URL: GITLAB_API, CI_PROJECT_PATH: REPO }),
    ...s.env,
  };
  const forgeEnv = s.platform === "github" ? { GH_TOKEN: forge.token } : { AGENT_GITLAB_TOKEN: forge.token };
  const modelEnv = { ANTHROPIC_API_KEY: "sk-ant-api03-fixture-not-a-real-key" };

  const cloned: ScenarioResult["cloned"] = [];
  const pushes: ScenarioResult["pushes"] = [];
  const deps = {
    prepareRepo: (o: { workDir: string; branch: string; defaultBranch: string }) => {
      cloned.push({ branch: o.branch, defaultBranch: o.defaultBranch });
      mkdirSync(join(o.workDir, ".git"), { recursive: true });
    },
    originUrl: () => CLONE_URL[s.platform],
    startModelProxy: async () => ({ url: "http://127.0.0.1:1", requestCount: () => session.prompts.length, close: async () => {} }),
    publisher: (o: { branch: string; defaultBranch: string }) => ({
      pushBranch: () => {
        pushes.push({ branch: o.branch, defaultBranch: o.defaultBranch });
        return { pushed: (s.commits ?? 1) > 0, head: "abc1234", commits: s.commits ?? 1 };
      },
    }),
  };

  const { result: codes, logs } = await quietly(async () =>
    s.mode === "main"
      ? [await main({ ...deps, env: { ...common, ...forgeEnv, ...modelEnv } })]
      : [
        await prepareStage({ ...deps, env: { ...common, ...forgeEnv } }),
        await agentStage({ ...deps, env: { ...common, ...modelEnv } }),
        await publishStage({ ...deps, env: { ...common, ...forgeEnv } }),
      ]);
  const outcome = [...logs.matchAll(/\[outcome\] (\w+):/g)].at(-1)?.[1] ?? "none";
  return { forge, codes, logs, prompt: session.prompts[0], toolErrors: session.toolErrors, outcome, cloned, pushes };
}

// The run's (intentionally chatty) CI log, captured instead of printed.
export async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const orig = { log: console.log, error: console.error };
  const lines: string[] = [];
  const capture = (...a: unknown[]) => void lines.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(" "));
  console.log = capture;
  console.error = capture;
  try {
    return { result: await fn(), logs: lines.join("\n") };
  } finally {
    Object.assign(console, orig);
  }
}
