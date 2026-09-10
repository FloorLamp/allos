// Print what a symbol reaches (#5680): every path from a function in `lib/` to a
// rendered `app/` module, a Server Action, a served route or a notification send.
//
//   npx tsx scripts/reach.ts lib/queries/usual-routine.ts usualRoutineDayOffers
//   npx tsx scripts/reach.ts lib/queries/upcoming/intake-safety.ts scheduledDoseRows
//
// The symbol may be file-local. A reviewer diffs the terminal list against a PR's
// consumer table; lib/__tests__/reach.test.ts pins the sets that feed notifications.
// Edges, terminals and blind spots are documented in scripts/reach-graph.ts.
import { formatReach, reach, terminalSet } from "./reach-graph";

const args = process.argv.slice(2);
if (args.length !== 2 || args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Usage: npx tsx scripts/reach.ts <module> <symbol>",
      "",
      "Walks the import/call graph outward from <symbol> (declared in <module>,",
      "repo-relative, exported or file-local) and prints the tree of consumers with",
      "file:line, tagging each terminal: render (app/**/*.tsx), action",
      "(app/**/*actions.ts export), route (app/**/route.ts), send (a call to a",
      "notification sender). Ends with the deduplicated terminal set.",
    ].join("\n")
  );
  process.exit(args.length === 2 ? 0 : args.length === 0 ? 1 : 0);
}

const result = reach(args[0], args[1]);
console.log(formatReach(result));
const set = terminalSet(result);
console.log(`\nTerminals (${set.length}):`);
for (const t of set) console.log(`  ${t}`);
