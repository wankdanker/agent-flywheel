// CLI: work one issue, configured entirely by env. Exit codes let whatever
// invokes us (CI, a human) branch on the outcome. The run itself is src/run.ts's main(),
// importable so tests can drive it with a fake tracker and agent engine.
// `--stage prepare|agent|publish` runs just one third of it (src/stages.ts), for CI jobs that
// keep the forge token and the model credential apart; no `--stage` runs all three in one.
import { main, stripEmptyEnv } from "../src/run.ts";
import { STAGE_MAINS, STAGES, type Stage } from "../src/stages.ts";

stripEmptyEnv(process.env);

function stageArg(argv: string[]): Stage | undefined | null {
  const i = argv.findIndex((a) => a === "--stage" || a.startsWith("--stage="));
  if (i < 0) return argv.length ? null : undefined;
  const value = argv[i]!.includes("=") ? argv[i]!.slice("--stage=".length) : argv[i + 1];
  return (STAGES as readonly string[]).includes(value ?? "") ? (value as Stage) : null;
}

const stage = stageArg(process.argv.slice(2));
if (stage === null) {
  console.error(`usage: run-ticket.ts [--stage ${STAGES.join("|")}]`);
  process.exit(2);
}

let code: number;
try {
  code = await (stage ? STAGE_MAINS[stage]() : main());
} catch (err) {
  // Only reachable before the issue was set to `working` (e.g. fetching the ticket failed):
  // main() and the stages own every failure after that and always leave a terminal label behind
  // (the prepare stage leaves `working` on success, for the publish stage to settle).
  console.error("[error]", err);
  code = 1;
}
process.exit(code);
