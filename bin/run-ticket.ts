// CLI: work one issue, configured entirely by env. Exit codes let whatever
// invokes us (CI, a human) branch on the outcome. The run itself is src/run.ts's main(),
// importable so tests can drive it with a fake tracker and agent engine.
import { main } from "../src/run.ts";

// CI and `docker --env-file` hand us unset optional vars as "", which would read as set.
for (const [k, v] of Object.entries(process.env)) if (v === "") delete process.env[k];

let code: number;
try {
  code = await main();
} catch (err) {
  // Only reachable before the issue was set to `working` (e.g. fetching the ticket failed):
  // main() owns every failure after that and always leaves a terminal label behind.
  console.error("[error]", err);
  code = 1;
}
process.exit(code);
