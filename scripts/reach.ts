// Print what a symbol reaches (#5680): every path from a function in `lib/` to a
// rendered `app/` module, a Server Action, a served route or a notification send.
//
//   npx tsx scripts/reach.ts lib/queries/usual-routine.ts usualRoutineDayOffers
//   npx tsx scripts/reach.ts lib/queries/upcoming/intake-safety.ts scheduledDoseRows
//   npx tsx scripts/reach.ts lib/queries/usual-routine.ts usualRoutineDayOffers --json
//
// The symbol may be file-local. A reviewer diffs the terminal list against a PR's
// consumer table; lib/__tests__/reach.test.ts pins the sets that feed notifications;
// the merge gate (scripts/orchestration/merge-gate.mjs) reads the `--json` shape
// as a child process, because a `.mjs` cannot import this TypeScript directly.
// Edges, terminals and blind spots are documented in scripts/reach-graph.ts.
import { formatReach, hops, reach, terminalSet } from "./reach-graph";

const json = process.argv.includes("--json");
const args = process.argv.slice(2).filter((a) => a !== "--json");
if (args.length !== 2 || args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Usage: npx tsx scripts/reach.ts <module> <symbol> [--json]",
      "",
      "Walks the import/call graph outward from <symbol> (declared in <module>,",
      "repo-relative, exported or file-local) and prints the tree of consumers with",
      "file:line, tagging each terminal: render (app/**/*.tsx), action",
      "(app/**/*actions.ts export), route (app/**/route.ts), send (a call to a",
      "notification sender). Ends with the deduplicated terminal set.",
      "--json prints { start, terminals, hops } instead, for a script to read.",
    ].join("\n")
  );
  process.exit(args.length === 2 ? 0 : args.length === 0 ? 1 : 0);
}

if (json) {
  // One line of stderr on failure, so the gate can quote it as its reason.
  try {
    const result = reach(args[0], args[1]);
    console.log(
      JSON.stringify({
        start: result.start,
        terminals: terminalSet(result),
        hops: hops(result),
      })
    );
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const result = reach(args[0], args[1]);
console.log(formatReach(result));
const set = terminalSet(result);
console.log(`\nTerminals (${set.length}):`);
for (const t of set) console.log(`  ${t}`);
