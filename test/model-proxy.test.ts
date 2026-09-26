import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { credentialFromEnv, sandboxEnv, startModelProxy, OAUTH_BETA, PLACEHOLDER_API_KEY } from "../src/model-proxy.ts";

// A stand-in for api.anthropic.com: records the headers/body it received and replies
// with a fixed body, optionally after a delay (to exercise the request timeout).
function fakeUpstream(onRequest: (req: IncomingMessage) => void, delayMs = 0): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    onRequest(req);
    setTimeout(() => res.writeHead(200, { "content-type": "text/plain" }).end("ok"), delayMs);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test("credentialFromEnv prefers ANTHROPIC_API_KEY and uses x-api-key", () => {
  const cred = credentialFromEnv({ ANTHROPIC_API_KEY: "real-key", CLAUDE_CODE_OAUTH_TOKEN: "real-token" });
  assert.deepEqual(cred, { header: "x-api-key", value: "real-key" });
});

test("credentialFromEnv falls back to CLAUDE_CODE_OAUTH_TOKEN as a bearer token", () => {
  const cred = credentialFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: "real-token" });
  assert.deepEqual(cred, { header: "authorization", value: "Bearer real-token" });
});

test("credentialFromEnv throws when no credential is present", () => {
  assert.throws(() => credentialFromEnv({}));
});

test("sandboxEnv strips real credentials and points the sandbox at the proxy", () => {
  const real = {
    ANTHROPIC_API_KEY: "real-key", CLAUDE_CODE_OAUTH_TOKEN: "real-token", PATH: "/usr/bin",
    GH_TOKEN: "ghs_x", GITHUB_TOKEN: "ghs_y", AGENT_GH_TOKEN: "ghp_z", AGENT_GITLAB_TOKEN: "glpat-x", CI_JOB_TOKEN: "job",
  };
  const out = sandboxEnv(real, "http://127.0.0.1:4141");

  assert.equal(out.ANTHROPIC_API_KEY, PLACEHOLDER_API_KEY);
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(out.ANTHROPIC_BASE_URL, "http://127.0.0.1:4141");
  // No forge token either: the agent can't push, open a PR/MR or edit the issue.
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "AGENT_GH_TOKEN", "AGENT_GITLAB_TOKEN", "CI_JOB_TOKEN"]) assert.equal(out[k], undefined, k);
  assert.equal(out.PATH, "/usr/bin"); // unrelated env still passed through
  assert.equal(real.ANTHROPIC_API_KEY, "real-key"); // original untouched
});

test("proxy swaps whatever auth header the sandboxed client sent for the real credential", async () => {
  let seen: IncomingMessage | undefined;
  const upstream = await fakeUpstream((req) => { seen = req; });
  const proxy = await startModelProxy({ header: "x-api-key", value: "REAL-SECRET" }, {}, { upstream: upstream.url });

  const res = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": PLACEHOLDER_API_KEY, "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(res.status, 200);
  assert.equal(seen?.headers["x-api-key"], "REAL-SECRET");
  assert.equal(proxy.requestCount(), 1);

  await proxy.close();
  upstream.server.close();
});

test("proxy falls back to default limits when run-ticket passes undefined for unset env vars", async () => {
  // Regression: `{ ...DEFAULT_LIMITS, ...limits }` let these undefineds win, and the first
  // request then crashed the whole run in upstreamReq.setTimeout(undefined).
  const upstream = await fakeUpstream(() => {});
  const proxy = await startModelProxy(
    { header: "x-api-key", value: "REAL-SECRET" },
    { maxRequests: undefined, maxLifetimeMs: undefined, requestTimeoutMs: undefined },
    { upstream: upstream.url },
  );

  assert.equal((await fetch(proxy.url, { method: "POST" })).status, 200);

  await proxy.close();
  upstream.server.close();
});

test("proxy adds the OAuth beta flag when the real credential is an OAuth bearer token", async () => {
  let seen: IncomingMessage | undefined;
  const upstream = await fakeUpstream((req) => { seen = req; });
  const proxy = await startModelProxy({ header: "authorization", value: "Bearer REAL" }, {}, { upstream: upstream.url });

  await fetch(proxy.url, { method: "POST", headers: { "anthropic-beta": "some-other-beta" } });

  assert.equal(seen?.headers.authorization, "Bearer REAL");
  assert.equal(seen?.headers["anthropic-beta"], `some-other-beta,${OAUTH_BETA}`);

  await proxy.close();
  upstream.server.close();
});

test("proxy enforces maxRequests without forwarding over-budget requests upstream", async () => {
  let upstreamHits = 0;
  const upstream = await fakeUpstream(() => { upstreamHits++; });
  const proxy = await startModelProxy(
    { header: "x-api-key", value: "REAL-SECRET" },
    { maxRequests: 2 },
    { upstream: upstream.url },
  );

  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await fetch(proxy.url, { method: "POST" })).status);

  assert.deepEqual(statuses, [200, 200, 429]);
  assert.equal(upstreamHits, 2);

  await proxy.close();
  upstream.server.close();
});

test("proxy enforces its lifetime limit", async () => {
  const upstream = await fakeUpstream(() => {});
  const proxy = await startModelProxy(
    { header: "x-api-key", value: "REAL-SECRET" },
    { maxLifetimeMs: 10 },
    { upstream: upstream.url },
  );

  await delay(30);
  const res = await fetch(proxy.url, { method: "POST" });
  assert.equal(res.status, 503);

  await proxy.close();
  upstream.server.close();
});

test("proxy enforces its per-request timeout against a slow upstream", async () => {
  const upstream = await fakeUpstream(() => {}, 200);
  const proxy = await startModelProxy(
    { header: "x-api-key", value: "REAL-SECRET" },
    { requestTimeoutMs: 20 },
    { upstream: upstream.url },
  );

  const res = await fetch(proxy.url, { method: "POST" });
  assert.equal(res.status, 504);

  await proxy.close();
  upstream.server.close();
});
