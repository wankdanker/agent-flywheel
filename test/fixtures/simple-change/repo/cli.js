#!/usr/bin/env node
// widgets: prints the widget list.
const widgets = ["sprocket", "gear", "cog"];

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("usage: widgets [--help]");
  process.exit(0);
}
for (const w of widgets) console.log(w);
