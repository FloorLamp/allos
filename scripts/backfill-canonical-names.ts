// One-off maintenance backfill for canonical biomarker names.
//
// Before extraction snapped model output onto the known vocabulary, freeform
// spellings slipped through (e.g. "25-OH Vitamin D" instead of the canonical
// "Vitamin D, 25-Hydroxy") and were registered as source='ai' vocabulary rows.
// This re-snaps existing medical_records.canonical_name onto the surviving
// canonical entries, then removes the orphaned alias rows that snapping made
// redundant.
//
//   npm run backfill:canonical          # dry run: print what would change
//   npm run backfill:canonical -- --apply
//
// Load .env / .env.local so the script respects the same config as the app.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { db } from "../lib/db";
import { reconcileFlags } from "../lib/queries";
import {
  normalizeCanonicalKey,
  buildCanonicalIndex,
} from "../lib/canonical-name";

const apply = process.argv.includes("--apply");

// Vocabulary to snap TO, ordered so curated/seeded names win over ai-coined
// ones when several collapse to the same normalized key (buildCanonicalIndex
// keeps the first entry per key). Any non-'ai' source is treated as curated.
const vocabRows = db
  .prepare(
    `SELECT name, source FROM canonical_biomarkers
     ORDER BY (source = 'ai') ASC, name COLLATE NOCASE`
  )
  .all() as { name: string; source: string }[];

const index = buildCanonicalIndex(vocabRows.map((r) => r.name));

// 1) Re-snap existing records onto the winning canonical spelling.
const records = db
  .prepare(
    `SELECT DISTINCT canonical_name AS name FROM medical_records
     WHERE canonical_name IS NOT NULL AND TRIM(canonical_name) != ''`
  )
  .all() as { name: string }[];

const renames: { from: string; to: string }[] = [];
for (const { name } of records) {
  const winner = index.get(normalizeCanonicalKey(name));
  if (winner && winner !== name) renames.push({ from: name, to: winner });
}

// 2) Find orphaned alias vocabulary rows: source='ai', a loser to a different
// winning entry, and (after re-snapping) referenced by no record.
const aliasRows = vocabRows.filter((r) => {
  if (r.source !== "ai") return false;
  const winner = index.get(normalizeCanonicalKey(r.name));
  return !!winner && winner !== r.name;
});

const refCount = db.prepare(
  `SELECT COUNT(*) AS c FROM medical_records WHERE canonical_name = ? COLLATE NOCASE`
);
const updateRecords = db.prepare(
  `UPDATE medical_records SET canonical_name = ? WHERE canonical_name = ? COLLATE NOCASE`
);
const deleteAlias = db.prepare(
  `DELETE FROM canonical_biomarkers WHERE name = ? COLLATE NOCASE`
);

function run() {
  let movedRows = 0;
  for (const { from, to } of renames) {
    const info = updateRecords.run(to, from);
    movedRows += info.changes;
  }
  // Recount references AFTER re-snapping, so an alias only counts as orphaned
  // when nothing points at it anymore.
  const orphans = aliasRows.filter(
    (r) => (refCount.get(r.name) as { c: number }).c === 0
  );
  for (const r of orphans) deleteAlias.run(r.name);
  return { movedRows, orphans };
}

console.log(
  `Canonical name backfill (${apply ? "APPLY" : "dry run"})\n` +
    `  vocabulary: ${vocabRows.length} names ` +
    `(${vocabRows.filter((r) => r.source === "ai").length} ai-sourced)\n`
);

if (renames.length === 0 && aliasRows.length === 0) {
  console.log("Nothing to backfill — all canonical names already consistent.");
  process.exit(0);
}

console.log(`Records to re-snap (${renames.length} distinct names):`);
for (const { from, to } of renames) console.log(`  "${from}" -> "${to}"`);

console.log(
  `\nAlias vocabulary rows eligible for removal (${aliasRows.length}):`
);
for (const r of aliasRows)
  console.log(`  "${r.name}" -> "${index.get(normalizeCanonicalKey(r.name))}"`);

if (!apply) {
  console.log("\nDry run — re-run with `-- --apply` to write these changes.");
  process.exit(0);
}

const tx = db.transaction(run);
const { movedRows, orphans } = tx();

// Freeform names may have carried out-of-range flags computed against the wrong
// (or missing) canonical band; re-derive flags now that rows are regrouped. The
// canonical-name re-snap is vocabulary maintenance shared across profiles, so
// reconcile each profile's records (flags depend on the profile's sex).
const profiles = db.prepare("SELECT id FROM profiles").all() as {
  id: number;
}[];
for (const pr of profiles) reconcileFlags(pr.id);

console.log(
  `\nApplied: re-snapped ${movedRows} record row(s); ` +
    `removed ${orphans.length} orphaned alias row(s); reconciled flags.`
);
