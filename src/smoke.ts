// The image's smoke test (`entrypoint.sh --smoke`, i.e. bin/smoke.ts): one real model turn
// through the exact path an issue run takes — the same env handling, model proxy and
// sandboxEnv as src/run.ts, then the SDK's native `claude` binary, then the real API — with
// no forge token, no clone and no issue. CI runs it against a freshly built `:sha-<short>`
// image and only moves `:latest` if it passes (see README "Image versions and rollback"),
// because unit tests mock query() and the upstream and so can't catch a break here (#28).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as realQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { sandboxEnv } from "./model-proxy.ts";
import { ConfigError, DEFAULT_PLUGIN_DIR, requireModelCredential, startProxyFromEnv, type RunDeps } from "./run.ts";

export const SMOKE_PROMPT = "Reply with just the word OK.";

// Never needed here, and CI shouldn't pass them; dropped anyway so the model can't see them.
const FORGE_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "AGENT_GH_TOKEN", "AGENT_GITLAB_TOKEN"];

// The CLI retries failed model requests (a 401 included) for a long time; a broken auth path
// must fail the build promptly rather than sit there until the CI job's own timeout.
export const DEFAULT_SMOKE_TIMEOUT_MS = 180_000;

export type SmokeDeps = {
  env?: NodeJS.ProcessEnv;
  startModelProxy?: RunDeps["startModelProxy"];
  query?: (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SDKMessage>;
};

// 0 the model answered through the proxy, 1 it didn't, 2 bad config.
export async function smoke(deps: SmokeDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const query = deps.query ?? (realQuery as unknown as NonNullable<SmokeDeps["query"]>);
  try {
    requireModelCredential(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  const proxy = await startProxyFromEnv(env, deps.startModelProxy);
  const agentEnv = sandboxEnv(env, proxy.url);
  for (const k of FORGE_TOKENS) delete agentEnv[k];

  const timeoutMs = env.SMOKE_TIMEOUT_MS ? Number(env.SMOKE_TIMEOUT_MS) : DEFAULT_SMOKE_TIMEOUT_MS;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(new Error(`smoke test timed out after ${timeoutMs}ms`)), timeoutMs);

  let result: Extract<SDKMessage, { type: "result" }> | undefined;
  try {
    for await (const msg of query({
      prompt: SMOKE_PROMPT,
      options: {
        cwd: mkdtempSync(join(tmpdir(), "smoke-")),
        // Cheap by default: SMOKE_MODEL, else whatever issue runs use.
        model: env.SMOKE_MODEL || env.CLAUDE_MODEL,
        maxTurns: 1,
        tools: [],
        env: agentEnv,
        // Same plugin and permission mode as a real run, so a broken plugin or a refusal to
        // bypass permissions (e.g. running as root) fails here too.
        plugins: [{ type: "local", path: env.PLUGIN_DIR ?? DEFAULT_PLUGIN_DIR }],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        abortController,
      },
    })) {
      if (msg.type === "assistant") {
        for (const b of msg.message.content) if (b.type === "text") console.log(`[claude] ${b.text}`);
      }
      if (msg.type === "result") result = msg;
    }
  } catch (err) {
    console.error("[smoke] FAIL: query failed:", abortController.signal.aborted ? abortController.signal.reason : err);
    return 1;
  } finally {
    clearTimeout(timer);
    console.log(`[model-proxy] forwarded ${proxy.requestCount()} request(s)`);
    await proxy.close().catch((err) => console.error("[cleanup] model proxy close failed:", err));
  }

  if (!result) {
    console.error("[smoke] FAIL: no result message");
    return 1;
  }
  if (result.subtype !== "success" || result.is_error) {
    console.error(`[smoke] FAIL: result ${result.subtype}${"result" in result ? `: ${result.result}` : ""}`);
    return 1;
  }
  // A success that never went through our proxy didn't test the path issue runs take.
  if (proxy.requestCount() === 0) {
    console.error("[smoke] FAIL: the model answered without a request through the model proxy");
    return 1;
  }
  console.log(`[smoke] OK: turns=${result.num_turns} cost=$${result.total_cost_usd.toFixed(4)}`);
  return 0;
}
