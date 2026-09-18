// DB INTEGRATION TIER — every raw DELETE site against `metric_samples`, listed by a
// scan, with what frees a follow-up link on each one (#5409, Ladder ruling 34).
//
// A care-plan follow-up can name a `metric_samples` row through the
// `source_metric_sample_id` / `resolved_by_metric_sample_id` pair
// (20260916-care-plan-metric-sample-links), declared ON DELETE SET NULL. Two things
// free that link when the row goes:
//
//   seam      the hand seam `unlinkFollowUpsForMetricSample` (lib/followup-write.ts)
//             runs BEFORE the delete and nulls `source_kind` together with the id —
//             the whole de-link, the way the other source kinds are freed.
//   backstop  no seam precedes the delete; the declared action nulls the id and
//             leaves `source_kind` standing (the dangling discriminator migration 184
//             repairs). It keeps the delete from throwing; it cannot finish the de-link.
//
// THE LIST BELOW IS RECOMPUTED, NOT SURVEYED. A hand survey of what deletes this
// table is what the #5880 review found wanting, so the sites are read out of the
// production sources by the same walker the body-metrics delete guard uses
// (lib/__tests__/sql-scan.ts), and a site this list does not name fails the test
// naming it. `reaches: false` records why an interpolated target cannot resolve to
// this table, exactly as that guard records it.
//
// THE SEAM IS ASSERTED BEHAVIOURALLY, NOT HERE. For each `seam` site the executed
// check is in lib/__db_tests__/breathing-rate-sleep-window.test.ts, describe
// "deleting the carried sample frees the WHOLE link":
//   - "nulls the discriminator with the id on the ordinary delete path" — the
//     captureDelete root delete (readings-table Delete, Data → Manage selected rows);
//   - "frees it on Data → Manage's Delete all, which takes no capture" — the wipe in
//     `deleteAllDatasetRows`;
//   - "positive control: the backstop alone leaves the discriminator standing" — what
//     every `backstop` site leaves behind.
// What THIS file executes is the other half: that the set of sites is the frozen one,
// that each `backstop` really is one (every inbound link into the table is SET NULL,
// read from the live schema, so no raw delete here can throw), and that the two
// `reaches: false` / capture-branch claims hold against the registries they cite.
//
// SYNTHETIC ONLY: no fixtures, no PHI — this reads source files and the schema catalog.

import { describe, expect, it } from "vitest";
import { rawDb as db } from "@/lib/db";
import { undoKindForTable } from "@/lib/dataset-undo";
import { UNDO_KINDS } from "@/lib/undo-delete";
import {
  blockingInboundLinks,
  inboundDeleteLinks,
} from "@/lib/migrations/cascade-delete";
import { readSource, relPath, sourceFiles } from "../__tests__/sql-scan";
import { stripComments } from "../__tests__/strip-comments";

const TABLE = "metric_samples";

interface Finding {
  file: string;
  // Normalized SQL fragment, bounded by the literal/statement end or MAX_SQL.
  sql: string;
}

// The extraction is the body-metrics guard's, with this table in the pattern: a
// statement runs to the end of the string literal it is written in, or to the first
// `;` inside it, capped so a pathological file cannot flood an assertion message.
const MAX_SQL = 300;

// A delete that names the table, or one whose table is interpolated and therefore
// unreadable from source. Case-insensitive on purpose.
const DELETE_RE = /\bDELETE\s+FROM\s+(?:metric_samples\b|\$\{)/gi;

// The match must START a SQL string, not merely appear inside one — error messages in
// lib/migrations/cascade-delete.ts spell "delete from ${table}" in prose.
const STATEMENT_START = "`\"';(";

function scanFile(rel: string, src: string): Finding[] {
  if (!/\bDELETE\s+FROM\s+(?:metric_samples\b|\$\{)/i.test(src)) return [];
  const text = stripComments(src);
  const out: Finding[] = [];
  for (const m of text.matchAll(DELETE_RE)) {
    let j = (m.index ?? 0) - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j >= 0 && !STATEMENT_START.includes(text[j])) continue;
    const opener = j >= 0 ? text[j] : "";
    const rest = text.slice(m.index);
    let end = Math.min(rest.length, MAX_SQL);
    const close = "`\"'".includes(opener) ? rest.indexOf(opener) : -1;
    if (close >= 0 && close < end) end = close;
    const semi = rest.indexOf(";");
    if (semi >= 0 && semi < end) end = semi;
    out.push({
      file: rel,
      sql: rest.slice(0, end).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

type Site = Finding &
  (
    | { reaches: true; frees: "seam" | "backstop"; why: string }
    | { reaches: false; why: string }
  );

// Matched EXACTLY on file and statement text, never by prefix: two statements in one
// file that share a prefix are two sites with two answers.
const SITES: Site[] = [
  {
    file: "app/(app)/data/manage-actions.ts",
    sql: "DELETE FROM ${resolved.table} WHERE id IN (${placeholders}) AND profile_id = ?",
    reaches: true,
    frees: "seam",
    why: "Data → Manage, selected rows. For this table `undoKindForTable` answers a kind (DATASET_UNDO_KIND, asserted below), so the capture branch above this statement returns first and the delete that runs is undo-delete-db's root delete, with the seam inside captureDelete.",
  },
  {
    file: "app/(app)/data/manage-actions.ts",
    sql: "DELETE FROM ${resolved.table} WHERE profile_id = ?",
    reaches: true,
    frees: "seam",
    why: "Data → Manage, Delete all. Takes no capture; `deleteAllDatasetRows` runs `unlinkFollowUpsForMetricSample` over this profile's linked samples before the wipe.",
  },
  {
    file: "lib/undo-delete-db.ts",
    sql: "DELETE FROM ${root.table} WHERE id = ? AND profile_id = ?",
    reaches: true,
    frees: "seam",
    why: "captureDelete's root delete — the readings table's Delete and Data → Manage's selected rows. The `ownedTable === \"metric_samples\"` branch runs the seam inside the same writeTx before this statement.",
  },
  {
    file: "lib/undo-delete-db.ts",
    sql: "DELETE FROM ${child.table} WHERE id = ? AND profile_id = ?",
    reaches: false,
    why: "captureDelete's explicit child delete, over `spec.entities.slice(1)`. The undo registry names `metric_samples` as the `metric-sample` root's own entity and as no later entity of any kind — asserted below from UNDO_KINDS.",
  },
  {
    file: "lib/import-persist.ts",
    sql: "DELETE FROM ${t.table} WHERE ${t.key} = ? AND ${footprintScope(t)}",
    reaches: true,
    frees: "backstop",
    why: "A person undoing an import. IMPORT_FOOTPRINT_TABLES (lib/import-footprint.ts) registers `metric_samples` for the growth metrics it imports; no seam precedes this delete.",
  },
  {
    file: "lib/profile-delete.ts",
    sql: "DELETE FROM ${child.table} WHERE ${cond.sql}",
    reaches: true,
    frees: "backstop",
    why: "A person deleting a whole profile: every profile-owned table is erased, this one among them, through its parents. No seam precedes it.",
  },
  {
    file: "lib/profile-delete.ts",
    sql: "DELETE FROM ${t} WHERE profile_id = ?",
    reaches: true,
    frees: "backstop",
    why: "The same profile delete, sweeping the tables that carry a profile_id of their own. No seam precedes it.",
  },
  {
    file: "lib/migrations/cascade-delete.ts",
    sql: "DELETE FROM ${q(table)} AS t0 WHERE ${root.sql}",
    reaches: true,
    frees: "backstop",
    why: "The migration-posture delete helper's parent delete. It deletes whatever table it is handed; foreign keys are OFF where it runs, so it reads each inbound link out of PRAGMA foreign_key_list and performs the declared SET NULL itself — the action, applied by hand.",
  },
  {
    file: "lib/migrations/cascade-delete.ts",
    sql: "DELETE FROM ${q(link.table)} AS ${alias} WHERE ${childPredicate.sql}",
    reaches: true,
    frees: "backstop",
    why: "The same helper, removing the CASCADE child rows of the row it was handed. Same posture, same hand-applied action.",
  },
  {
    file: "lib/migrations/cascade-delete.ts",
    sql: "DELETE FROM ${q(table)} WHERE ${notNull} AND NOT EXISTS",
    reaches: true,
    frees: "backstop",
    why: "The same helper's trailing pass over rows whose parent has just been removed. Same posture, same hand-applied action.",
  },
  {
    file: "lib/integrations/normalize.ts",
    sql: "DELETE FROM metric_samples WHERE id = ? AND profile_id = ?",
    reaches: true,
    frees: "backstop",
    why: "Health Connect's day-bucket supersede (`supersedeMetricSampleOverlaps`), scoped to that source and to the tiling day-bucket metrics. No seam precedes it.",
  },
  {
    file: "lib/integrations/sleep-overlap-db.ts",
    sql: "DELETE FROM metric_samples WHERE id = ? AND profile_id = ?",
    reaches: true,
    frees: "backstop",
    why: "The #3628 same-origin sleep collapse: the losing `sleep_min` session and the stage rows it owns. No seam precedes it.",
  },
  {
    file: "lib/offline/writes.ts",
    sql: "DELETE FROM metric_samples WHERE profile_id = ? AND metric = ? AND source = 'manual' AND origin IS NULL AND date = ? AND started_at <> ?",
    reaches: true,
    frees: "backstop",
    why: "The offline queue's replay of a manual sleep duration: `metric = ?` is bound to SLEEP_METRIC and the row is the person's own manual one. No seam precedes it.",
  },
  {
    file: "lib/migrations/versions/20260911-stool-events.ts",
    sql: "DELETE FROM metric_samples WHERE metric = 'bristol_stool_type'",
    reaches: true,
    frees: "backstop",
    why: "A shipped migration, frozen by the hash manifest: it removes the `bristol_stool_type` samples it has just moved to their own table, at a position where `metric_samples` had no inbound delete link (FROZEN_UNGUARDED_DELETES in migration-child-links.test.ts records it). No seam precedes it.",
  },
  {
    file: "lib/day-counter-ledger.ts",
    sql: "DELETE FROM ${spec.table} WHERE ${where} AND ${spec.amountColumn} <= 0",
    reaches: false,
    why: "A day counter falling to zero. The table comes from DAY_COUNTER_SPECS, whose entries are daily-total ledgers — no reading store is reachable.",
  },
  {
    file: "lib/assessment-reclass-db.ts",
    sql: "DELETE FROM ${definitionTable} WHERE name = ? COLLATE NOCASE AND source = 'ai'",
    reaches: false,
    why: "An AI-authored definition being reclassified away. `definitionTable` is a clinical DEFINITION table, never a reading store.",
  },
];

const key = (f: Finding) => `${f.file}\n    ${f.sql}`;

describe("every raw DELETE site against metric_samples is listed, with what frees a follow-up link (#5409)", () => {
  const found = sourceFiles().flatMap((file) =>
    scanFile(relPath(file), readSource(file))
  );

  it("keeps the seam files inside the walker's discovery scope", () => {
    const scanned = new Set(sourceFiles().map(relPath));
    for (const f of [
      "app/(app)/data/manage-actions.ts",
      "lib/undo-delete-db.ts",
      "lib/migrations/versions/20260911-stool-events.ts",
    ]) {
      expect(scanned.has(f), `${f} is not in the scan's discovery scope`).toBe(
        true
      );
    }
  });

  it("finds exactly the frozen set of sites", () => {
    const listed = new Set(SITES.map(key));
    const unlisted = found.filter((f) => !listed.has(key(f))).map(key);
    expect(
      unlisted,
      "a DELETE that can reach `metric_samples` is not listed above. Add it with " +
        '`frees: "seam"` (run unlinkFollowUpsForMetricSample before it, and ' +
        "assert that in breathing-rate-sleep-window.test.ts) or `frees: " +
        '"backstop"` (state why no seam is needed), or `reaches: false` with ' +
        "why the target cannot resolve to this table:\n  " +
        unlisted.join("\n  ")
    ).toEqual([]);

    const present = new Set(found.map(key));
    const stale = SITES.map(key).filter((k) => !present.has(k));
    expect(
      stale,
      "a listed site no longer exists or its statement text changed; update the " +
        "entry rather than leaving a record of a delete that is not there:\n  " +
        stale.join("\n  ")
    ).toEqual([]);
  });

  it("every `backstop` really is one: each inbound link into the table is SET NULL", () => {
    // Read from the live migrated schema, which is what makes this executed rather
    // than claimed: a blocking link added later turns every `backstop` entry above
    // into a potential throw, and this is where that shows.
    expect(blockingInboundLinks(db, TABLE)).toEqual([]);
    const links = inboundDeleteLinks(db, TABLE);
    expect(links.map((l) => l.action)).toEqual(
      links.map(() => "set-null" as const)
    );
    // Positive control: the pair this file exists for is present, so the two
    // assertions above are not passing over a table nothing references.
    expect(
      links.map((l) => `${l.table}.${l.columns.join(",")}`).sort()
    ).toEqual([
      "care_plan_items.resolved_by_metric_sample_id",
      "care_plan_items.source_metric_sample_id",
    ]);
  });

  it("the selected-rows delete takes the capture branch for this table", () => {
    // Which is what routes it through captureDelete's root delete and its seam,
    // rather than the raw statement below the branch.
    expect(undoKindForTable(TABLE)).toBe("metric-sample");
  });

  it("no undo kind deletes a metric_samples row as an explicit child", () => {
    // captureDelete's `${child.table}` delete runs over entities after the root's.
    const asChild = Object.entries(UNDO_KINDS).flatMap(([kind, spec]) =>
      spec.entities
        .slice(1)
        .filter((e) => e.table === TABLE)
        .map((e) => `${kind}.${e.entity}`)
    );
    expect(asChild).toEqual([]);
  });
});
