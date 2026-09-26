// src/smoke.ts with a fake model proxy and a fake query(): what it hands the SDK, and which
// outcomes count as a pass. The real-model run itself only happens in CI, against the image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLACEHOLDER_API_KEY } from "../src/model-proxy.ts";
import { smoke, type SmokeDeps } from "../src/smoke.ts";

const ENV = { ANTHROPIC_API_KEY: "sk-ant-real-key-12345", GH_TOKEN: "ghp_forge", AGENT_GITLAB_TOKEN: "glpat-forge", PLUGIN_DIR: "/tmp/plugin" };

function fakes(messages: any[], opts: { requests?: number; throws?: Error } = {}) {
  const seen = { options: undefined as any, limits: undefined as any, closed: false };
  const deps: SmokeDeps = {
    startModelProxy: async (_cred, limits) => {
      seen.limits = limits;
      return { url: "http://127.0.0.1:1", requestCount: () => opts.requests ?? 1, close: async () => { seen.closed = true; } };
    },
    query: ({ options }) => {
      seen.options = options;
      return (async function* () {
        for (const m of messages) yield m;
        if (opts.throws) throw opts.throws;
      })();
    },
  };
  return { deps, seen };
}

const success = { type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1, total_cost_usd: 0.0001 };

test("passes on a success result through the proxy, with one turn, no tools, and no real or forge credentials", async () => {
  const { deps, seen } = fakes([success]);
  assert.equal(await smoke({ ...deps, env: { ...ENV, SMOKE_MODEL: "claude-haiku-4-5", CLAUDE_MODEL: "claude-opus-5-5" } }), 0);
  assert.equal(seen.options.maxTurns, 1);
  assert.deepEqual(seen.options.tools, []);
  assert.equal(seen.options.model, "claude-haiku-4-5");
  assert.equal(seen.options.env.ANTHROPIC_API_KEY, PLACEHOLDER_API_KEY);
  assert.equal(seen.options.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:1");
  assert.equal(seen.options.env.GH_TOKEN, undefined);
  assert.equal(seen.options.env.AGENT_GITLAB_TOKEN, undefined);
  assert.deepEqual(seen.options.plugins, [{ type: "local", path: "/tmp/plugin" }]);
  assert.ok(seen.closed);
});

test("falls back to CLAUDE_MODEL and parses proxy limits the same way run.ts does", async () => {
  const { deps, seen } = fakes([success]);
  assert.equal(await smoke({ ...deps, env: { ...ENV, CLAUDE_MODEL: "claude-sonnet-5", MODEL_PROXY_MAX_REQUESTS: "5" } }), 0);
  assert.equal(seen.options.model, "claude-sonnet-5");
  assert.deepEqual(seen.limits, { maxRequests: 5, maxLifetimeMs: undefined, requestTimeoutMs: undefined });
});

test("fails on an error result, no result, a thrown query, or zero proxied requests", async () => {
  for (const [messages, opts] of [
    [[{ ...success, subtype: "error_during_execution", is_error: true }], {}],
    [[{ ...success, is_error: true, result: "API Error: 401" }], {}],
    [[], {}],
    [[], { throws: new Error("claude exited with code 1") }],
    [[success], { requests: 0 }],
  ] as const) {
    const { deps, seen } = fakes([...messages], opts);
    assert.equal(await smoke({ ...deps, env: ENV }), 1);
    assert.ok(seen.closed);
  }
});

test("exits 2 without a model credential", async () => {
  const { deps, seen } = fakes([success]);
  assert.equal(await smoke({ ...deps, env: { GH_TOKEN: "x" } }), 2);
  assert.equal(seen.options, undefined);
});

test("gives up after SMOKE_TIMEOUT_MS instead of waiting out the CLI's retries", async () => {
  const seen: any = {};
  const deps: SmokeDeps = {
    startModelProxy: async () => ({ url: "http://127.0.0.1:1", requestCount: () => 3, close: async () => {} }),
    query: ({ options }) => {
      const signal = (options.abortController as AbortController).signal;
      seen.signal = signal;
      return (async function* () {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      })();
    },
  };
  assert.equal(await smoke({ ...deps, env: { ...ENV, SMOKE_TIMEOUT_MS: "20" } }), 1);
  assert.ok(seen.signal.aborted);
});
