// Rewrite lib/migrations/manifest.json from the migration files on disk (#3579).
//
//   npm run gen:migration-manifest
//
// Run it when a merge conflicts on the manifest — merge order is migration order,
// so that is often. Every hash is recomputed, none is carried forward: all the
// pre-existing hashes coming back identical is what proves no shipped migration
// moved during the merge. Key order is preserved and new entries appended.
//
// It REFUSES when a shipped migration's hash changed, rather than writing the new
// one. That case is an edited shipped migration (lib/migrations/AGENTS.md), and
// rewriting the manifest to match would turn the violation into a clean file.

import fs from "node:fs";
import {
  hashMigrations,
  MANIFEST_PATH,
  planManifest,
  readManifest,
  serializeManifest,
} from "../lib/migrations/manifest";

const previous = readManifest();
const plan = planManifest(previous, hashMigrations());

/* eslint-disable no-console */
if (plan.changed.length > 0) {
  console.error(
    `REFUSING to write lib/migrations/manifest.json: ${plan.changed.length} ` +
      `SHIPPED migration(s) hash differently than the committed manifest:\n` +
      plan.changed.map((f) => `  ${f}`).join("\n") +
      `\n\nShipped migrations are APPEND-ONLY. Restore the file(s) and append a ` +
      `corrective migration instead. Writing these hashes would launder the edit ` +
      `the manifest exists to catch.`
  );
  process.exit(1);
}

const next = serializeManifest(plan.next);
const count = Object.keys(plan.next).length;
const unchanged = fs.readFileSync(MANIFEST_PATH, "utf8") === next;
fs.writeFileSync(MANIFEST_PATH, next);

for (const f of plan.removed) console.log(`dropped entry (no such file): ${f}`);
for (const f of plan.added) console.log(`added entry: ${f}`);
console.log(
  unchanged
    ? `lib/migrations/manifest.json already current (${count} hashes recomputed)`
    : `wrote lib/migrations/manifest.json (${count} entries)`
);
