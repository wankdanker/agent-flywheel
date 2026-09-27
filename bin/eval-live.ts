// CLI: `npm run eval:live`, the opt-in live model evaluation (src/eval.ts). Spends real money:
// needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, and no CI job runs it. Writes a JSON
// report; exit 0 every fixture reached its expected outcome, 1 some didn't, 2 bad config.
import { stripEmptyEnv } from "../src/run.ts";
import { runEval } from "../src/eval.ts";

stripEmptyEnv(process.env);

let code: number;
try {
  code = (await runEval()).code;
} catch (err) {
  console.error("[error]", err);
  code = 1;
}
process.exit(code);
