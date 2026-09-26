// A tiny reverse proxy that sits between the sandboxed agent process and the real
// Anthropic API. The trusted preparation stage (bin/run-ticket.ts) reads the real
// ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN from its own env, starts this proxy holding
// that credential, and then launches the agent with only a placeholder credential and
// ANTHROPIC_BASE_URL pointed at this proxy (see sandboxEnv). Repository-controlled code
// running as the model's Bash tool therefore can't read the real credential out of its
// own process env — it can only reach the model through this proxy, which enforces the
// request-count/time/timeout limits below.
//
// This narrows "the agent's own sandbox can read the API key" down to "the agent's own
// sandbox can spend up to these limits worth of model calls", which is the residual risk
// documented in the README. It does not add a second OS-level sandbox: the proxy and the
// agent subprocess still share the same container, same user, same filesystem.
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

export const DEFAULT_UPSTREAM = "https://api.anthropic.com";
// Never a real key shape; the proxy always overwrites this before forwarding, but the
// CLI's own startup checks require *something* present to pick the x-api-key auth path.
export const PLACEHOLDER_API_KEY = "sk-ant-agent-flywheel-placeholder-not-a-real-key";

// Required on /v1/messages when authenticating with a Claude Code OAuth token.
export const OAUTH_BETA = "oauth-2025-04-20";

export type Credential = { header: "x-api-key"; value: string } | { header: "authorization"; value: string };

// Whichever real credential the trusted process was handed, read once at startup.
export function credentialFromEnv(env: NodeJS.ProcessEnv = process.env): Credential {
  if (env.ANTHROPIC_API_KEY) return { header: "x-api-key", value: env.ANTHROPIC_API_KEY };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { header: "authorization", value: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}` };
  throw new Error("model-proxy: no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in env");
}

export const FORGE_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "AGENT_GH_TOKEN", "AGENT_GITLAB_TOKEN", "GITLAB_TOKEN", "CI_JOB_TOKEN"];

// The env the sandboxed agent subprocess actually gets: real credentials stripped, a
// placeholder key standing in for them, and requests routed through the proxy.
export function sandboxEnv(env: NodeJS.ProcessEnv, proxyUrl: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.CLAUDE_CODE_OAUTH_TOKEN;
  delete out.ANTHROPIC_AUTH_TOKEN;
  // Forge tokens too: only the trusted publisher (src/publish.ts) pushes, opens the PR/MR
  // or edits the issue, after the agent's session is over.
  for (const k of FORGE_TOKEN_VARS) delete out[k];
  out.ANTHROPIC_API_KEY = PLACEHOLDER_API_KEY;
  out.ANTHROPIC_BASE_URL = proxyUrl;
  return out;
}

export type ModelProxyLimits = {
  maxRequests?: number; // total forwarded requests over the proxy's lifetime
  maxLifetimeMs?: number; // wall-clock budget, independent of MAX_TURNS
  requestTimeoutMs?: number; // per-request budget waiting on the upstream response
};

export const DEFAULT_LIMITS: Required<ModelProxyLimits> = {
  maxRequests: 2000,
  maxLifetimeMs: 2 * 60 * 60 * 1000,
  requestTimeoutMs: 120_000,
};

export type ModelProxy = {
  url: string;
  requestCount(): number;
  close(): Promise<void>;
};

export type ModelProxyOptions = {
  host?: string; // default 127.0.0.1: never reachable outside this container/process
  port?: number; // default 0 (ephemeral)
  upstream?: string;
};

function stripAuthHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out = { ...headers };
  delete out["x-api-key"];
  delete out.authorization;
  return out;
}

export function startModelProxy(
  credential: Credential,
  limits: ModelProxyLimits = {},
  opts: ModelProxyOptions = {},
): Promise<ModelProxy> {
  // Per field, not a spread: bin/run-ticket.ts passes `undefined` for unset env vars, and a
  // spread would let that undefined overwrite the default (setTimeout(undefined) then throws).
  const maxRequests = limits.maxRequests ?? DEFAULT_LIMITS.maxRequests;
  const maxLifetimeMs = limits.maxLifetimeMs ?? DEFAULT_LIMITS.maxLifetimeMs;
  const requestTimeoutMs = limits.requestTimeoutMs ?? DEFAULT_LIMITS.requestTimeoutMs;
  const upstream = new URL(opts.upstream ?? DEFAULT_UPSTREAM);
  const forward = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const deadline = Date.now() + maxLifetimeMs;
  let count = 0;

  const server = createServer((req, res) => {
    if (Date.now() > deadline) {
      res.writeHead(503, { "content-type": "text/plain" }).end("model-proxy: time budget exceeded");
      return;
    }
    if (count >= maxRequests) {
      res.writeHead(429, { "content-type": "text/plain" }).end("model-proxy: request budget exceeded");
      return;
    }
    count++;

    const headers = { ...stripAuthHeaders(req.headers), [credential.header]: credential.value, host: upstream.host };
    // The sandboxed CLI only ever sees a placeholder API key, so it never adds the beta flag
    // the API requires for OAuth bearer tokens; we add it when the real credential is one.
    if (credential.header === "authorization") {
      const beta = [headers["anthropic-beta"]].flat().filter(Boolean).join(",");
      if (!beta.includes(OAUTH_BETA)) headers["anthropic-beta"] = beta ? `${beta},${OAUTH_BETA}` : OAUTH_BETA;
    }
    const upstreamReq = forward(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        path: req.url,
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.setTimeout(requestTimeoutMs, () => upstreamReq.destroy(new Error("model-proxy: upstream timeout")));
    upstreamReq.on("error", (err) => {
      if (res.headersSent) { res.destroy(); return; }
      const timedOut = /timeout/i.test(err.message);
      res.writeHead(timedOut ? 504 : 502, { "content-type": "text/plain" }).end(`model-proxy: ${err.message}`);
    });
    req.pipe(upstreamReq);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
      resolve({
        url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
        requestCount: () => count,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
