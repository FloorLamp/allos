// The --help guard every JS/TS entry script in this directory calls first.
//
// Orchestrators probe unfamiliar scripts with `--help`, and until 2026-08-30
// none of these scripts answered it — the flag was silently ignored and the
// DEFAULT action ran instead. For a dry-run script that wastes a network
// round-trip; for the stateful ones (the check-in flight recorder, the
// dispatch ledger) it performs a real state transition the caller never asked
// for. So: probing must always be safe, and the header comment every script
// already carries IS the usage — this prints it and exits before anything
// else runs.
//
// Call it as the first statement after the import block, before any other
// module-level code, so no side effect (env loading aside) precedes it. The
// shell scripts carry an equivalent inline sed guard.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** On -h/--help: print the calling script's leading comment block, exit 0. */
export function helpGuard(argv, selfUrl) {
  if (!argv.includes("--help") && !argv.includes("-h")) return;
  const lines = fs.readFileSync(fileURLToPath(selfUrl), "utf8").split("\n");
  const out = [];
  for (const line of lines) {
    if (line.startsWith("#!")) continue;
    if (!line.startsWith("//")) break;
    out.push(line.replace(/^\/\/ ?/, ""));
  }
  console.log(out.join("\n").trimEnd());
  process.exit(0);
}
