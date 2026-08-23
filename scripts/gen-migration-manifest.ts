#!/usr/bin/env tsx
/**
 * THE WRITER `lib/migrations/manifest.json` DID NOT HAVE (#3579).
 *
 *   npm run gen:migration-manifest          # rewrite the manifest from disk
 *   npm run gen:migration-manifest -- --check   # verify without writing
 *
 * The manifest holds a sha-256 per shipped migration file and exists to prove
 * nobody edited a migration after it shipped. Until now it had a reader
 * (lib/__tests__/migration-immutability.test.ts) and no writer, so every migration
 * merge conflict — and they are frequent, because merge order IS migration order —
 * ended with somebody typing a hash in by hand. A hand-entered hash is a hash
 * nobody computed.
 *
 * RUN THIS AFTER RESOLVING A MIGRATION CONFLICT, and read the summary it prints:
 *
 *   - It recomputes EVERY entry from the bytes on disk, not just the new one.
 *     That is the proof. "n unchanged" is the sentence that says no shipped
 *     migration moved during the merge; a writer that only appends cannot say it.
 *   - It keys the manifest in REGISTRY order (versions/index.ts), so appending a
 *     migration is a one-line diff instead of a re-sort.
 *   - It REFUSES a tree where index.ts and versions/ disagree. A migration in one
 *     and not the other is a conflict resolved wrong, and mid-conflict is exactly
 *     when this script runs.
 *
 * The hash, the file set and the ordering all live in lib/migrations/manifest-source.ts,
 * which the immutability guard imports too. This script deliberately reimplements
 * none of them: a second spelling of the algorithm is a second source of truth for
 * the one thing the guard exists to check.
 */
import fs from "node:fs";

import {
  MANIFEST_PATH,
  MANIFEST_REL,
  buildManifest,
  readManifest,
  serializeManifest,
} from "../lib/migrations/manifest-source";

const check = process.argv.includes("--check");

const manifest = buildManifest();
const next = serializeManifest(manifest);
const previous: Record<string, string> = fs.existsSync(MANIFEST_PATH)
  ? readManifest()
  : {};
const current = fs.existsSync(MANIFEST_PATH)
  ? fs.readFileSync(MANIFEST_PATH, "utf8")
  : "";

const added = Object.keys(manifest).filter((f) => !(f in previous));
const removed = Object.keys(previous).filter((f) => !(f in manifest));
const rehashed = Object.keys(manifest).filter(
  (f) => f in previous && previous[f] !== manifest[f]
);
const unchanged = Object.keys(manifest).length - added.length - rehashed.length;

const lines = [
  `${Object.keys(manifest).length} migrations hashed from disk, in registry order.`,
  `  unchanged: ${unchanged}`,
  `  new:       ${added.length}${added.length ? ` (${added.join(", ")})` : ""}`,
  `  REHASHED:  ${rehashed.length}${rehashed.length ? ` (${rehashed.join(", ")})` : ""}`,
  `  dropped:   ${removed.length}${removed.length ? ` (${removed.join(", ")})` : ""}`,
];
console.log(lines.join("\n"));

// A REHASHED ENTRY IS THE ALARM, not a routine outcome. Shipped migrations are
// append-only, so a file whose bytes changed is either an edit to released history
// or a conflict resolved by editing the wrong side. Say so loudly in both modes —
// the generator's job is to compute hashes, not to launder an edit into one.
if (rehashed.length > 0) {
  console.error(
    `\nWARNING: ${rehashed.length} ALREADY-SHIPPED migration(s) hash differently ` +
      `than the checked-in manifest:\n  ${rehashed.join("\n  ")}\n` +
      `Shipped migrations are APPEND-ONLY. Unless you are deliberately restoring a ` +
      `file to its shipped bytes, this is an edit to released history — revert the ` +
      `file and append a corrective migration instead. Rewriting the manifest here ` +
      `would only make the edit invisible.`
  );
}

if (check) {
  if (current === next) {
    console.log(`\n${MANIFEST_REL} is up to date.`);
    process.exit(0);
  }
  console.error(
    `\n${MANIFEST_REL} is NOT what the bytes on disk produce. Run ` +
      `\`npm run gen:migration-manifest\` and commit the result.`
  );
  process.exit(1);
}

if (current === next) {
  console.log(`\n${MANIFEST_REL} already up to date — nothing written.`);
} else {
  fs.writeFileSync(MANIFEST_PATH, next, "utf8");
  console.log(`\nWrote ${MANIFEST_REL}.`);
}
