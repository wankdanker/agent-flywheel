// CLI: the image's smoke test (`entrypoint.sh --smoke`). One real model turn through the
// same proxy/env path as bin/run-ticket.ts; see src/smoke.ts. Exit 0 pass, 1 fail, 2 bad config.
import { stripEmptyEnv } from "../src/run.ts";
import { smoke } from "../src/smoke.ts";

stripEmptyEnv(process.env);

let code: number;
try {
  code = await smoke();
} catch (err) {
  console.error("[error]", err);
  code = 1;
}
process.exit(code);
