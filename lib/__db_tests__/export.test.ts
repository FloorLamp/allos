// DB INTEGRATION TIER — Data → Manage/Export dataset smoke + scoping tests.
//
// lib/export.ts's DATASETS row queries are otherwise only source-scanned (the
// pure profile-scoping test) and never EXECUTED, so a typo'd JOIN or wrong column
// on a newly added clinical/HR dataset would pass every gate and only fail at
// runtime on the Data page. These tests seed two profiles into a real (throwaway)
// SQLite DB and assert each new dataset's rows query (a) returns only the querying
// profile's rows — including through the intake_items JOIN — and (b) shapes a CSV
// whose header matches the declared columns. The db singleton is redirected at a
// per-file temp DB by lib/__db_tests__/setup.ts before this file is imported.

import { describe, it, expect, beforeAll } from "vitest";
import {
  DATASETS,
  DELETE_POLICY,
  getDataset,
  PROVIDER_LINK_SELECTS,
  readsSelect,
  toCsv,
} from "@/lib/export";
import { OWNED_TABLES } from "@/lib/owned-tables";
import { ownedChildTables } from "@/lib/profile-delete";
import {
  execArgs,
  prepareArgs,
  readSource,
  relPath,
  sourceFiles,
} from "../__tests__/sql-scan";
import { PENDING_COLUMNS } from "@/lib/export-manifest";
import { db } from "@/lib/db";
import { seedProfile, seedSchemaRow, type SeededProfile } from "./fixtures";

let a: SeededProfile;
let b: SeededProfile;

beforeAll(() => {
  a = seedProfile("EXPA");
  b = seedProfile("EXPB");
  // The shared fixture doesn't seed the clinical / heart-rate datasets, so add a
  // tagged row per profile to prove the new dataset queries are profile-scoped.
  // One shared (global) provider, referenced by each profile's encounter, so the
  // `providers` dataset — the one whose reads are bounded by an id list rather than
  // by a statement — has rows to compare against its declared select.
  const providerId = Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, dedup_key)
         VALUES ('Quest Labs', 'organization', 'quest-labs|organization')`
      )
      .run().lastInsertRowid
  );
  for (const { p, bpm, mgdl } of [
    { p: a, bpm: 60, mgdl: 92 },
    { p: b, bpm: 99, mgdl: 141 },
  ]) {
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, reaction, severity, status)
       VALUES (?, ?, 'hives', 'moderate', 'active')`
    ).run(p.profileId, `${p.tag} Penicillin`);
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status) VALUES (?, ?, 'active')`
    ).run(p.profileId, `${p.tag} Hypertension`);
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, provider_id)
       VALUES (?, '2024-01-02', ?, ?)`
    ).run(p.profileId, `${p.tag} Office Visit`, providerId);
    db.prepare(
      `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
       VALUES (?, '2024-01-02T08:00', ?, 3, 'health-connect')`
    ).run(p.profileId, bpm);
    // The second composite-key dataset, seeded for the same reason hr_minutes is:
    // both are profile-OWNED with no `id` anywhere in the table, and the scoping loop
    // below compares rows rather than ids precisely so that shape gets a real case
    // instead of an exemption. Distinct mgdl per profile, so the two rows differ.
    db.prepare(
      `INSERT INTO glucose_trace (profile_id, ts, mgdl, source)
       VALUES (?, '2024-01-02T08:00', ?, 'health-connect')`
    ).run(p.profileId, mgdl);
    // Two of the four datasets this PR gave `bundle_id` had no seeded row on either
    // profile, so the per-dataset scoping loop below would have been silent about
    // exactly the columns the change touches.
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, duration_min)
       VALUES (?, ?, '2024-01-02', 20)`
    ).run(p.profileId, `${p.tag} Breathwork`);
    db.prepare(
      `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
       VALUES (?, ?, '2024-01-02', '2024-01-02T12:00:00Z')`
    ).run(p.profileId, `${p.tag.toLowerCase()}-lunch`);
    // The substance ledger #5026 phase 2 added, SEEDED rather than named in
    // SCOPING_UNSEEDED: its select and its countSql are new statements with new
    // profile filters, which is exactly what the loop below exists to watch, and an
    // unseeded dataset is one the loop is silent about. Distinct substance per
    // profile, so the two rows are distinguishable and a leak has something to be.
    db.prepare(
      `INSERT INTO substance_log_events (profile_id, substance, date, recorded_at)
       VALUES (?, ?, '2024-01-02', '2024-01-02T21:00:00Z')`
    ).run(p.profileId, `${p.tag} Nicotine`);
  }
});

const rowsFor = (key: string, profileId: number) =>
  getDataset(key)!.rows(profileId);
const pageFor = (
  key: string,
  profileId: number,
  limit: number,
  offset: number
) => getDataset(key)!.page(profileId, limit, offset);

// Issue #113: the Data page reads bounded pages (count + page) instead of the full
// dataset. These assert the bounded readers agree with the full rows() (same order,
// same shape, incl. the folded activities/intake-items JS), stay profile-scoped, and
// that count() equals the true row total — the contract DataExport relies on.
describe("bounded count()/page() readers (issue #113)", () => {
  // count() == rows().length is no longer asserted here. It was six hand-listed keys
  // on both profiles; the per-dataset case in "every dataset's rows() and page() are
  // profile-scoped (#5117)" makes the identical assertion, on both profiles, for
  // every seeded dataset — all six of these among them, JOIN datasets included.
  // The window and folding claims below are NOT subsumed and stay: page() agreeing
  // with rows().slice() is an ordering contract the scoping loop never asks about.

  it("page() returns the same window (order + shape) as slicing rows()", () => {
    for (const key of ["medical_records", "activities", "intake_items"]) {
      const all = rowsFor(key, a.profileId);
      // A window that straddles the data (offset 1, small limit).
      const window = pageFor(key, a.profileId, 2, 1);
      expect(window).toEqual(all.slice(1, 3));
    }
  });

  it("the activities page folds exercise sets like the full export", () => {
    // shapeActivities must run for the bounded page too (not just rows()).
    const all = rowsFor("activities", a.profileId);
    const first = pageFor("activities", a.profileId, 1, 0);
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual(all[0]);
    expect(first[0]).toHaveProperty("exercises");
  });

  it("the intake-items page folds the dose schedule like the full export", () => {
    const page = pageFor("intake_items", a.profileId, 50, 0);
    const vitD = page.find((r) => String(r.name) === "EXPA Vitamin D")!;
    expect(vitD).toBeDefined();
    expect(String(vitD.schedule)).toContain("morning");
    // Never leaks the other profile's items into this profile's page.
    expect(page.some((r) => String(r.name).startsWith("EXPB"))).toBe(false);
  });

  it("page() is profile-scoped (no cross-profile rows in a large window)", () => {
    const idsB = new Set(
      rowsFor("medical_records", b.profileId).map((r) => r.id)
    );
    const pageA = pageFor("medical_records", a.profileId, 1000, 0);
    expect(pageA.length).toBeGreaterThan(0);
    expect(pageA.some((r) => idsB.has(r.id))).toBe(false);
  });
});

describe("export datasets are profile-scoped", () => {
  it("metric_samples returns only the querying profile's samples", () => {
    const rowsA = rowsFor("metric_samples", a.profileId);
    expect(rowsA.length).toBeGreaterThan(0);
    const idsA = new Set(rowsA.map((r) => r.id));
    const rowsB = rowsFor("metric_samples", b.profileId);
    expect(rowsB.length).toBeGreaterThan(0);
    // No id from B's samples appears in A's rows (and vice-versa).
    expect(rowsB.some((r) => idsA.has(r.id))).toBe(false);
  });

  it("allergies / conditions / encounters rows are scoped by profile_id", () => {
    expect(rowsFor("allergies", a.profileId)).toHaveLength(1);
    expect(rowsFor("allergies", a.profileId)[0].substance).toBe(
      "EXPA Penicillin"
    );
    expect(rowsFor("allergies", b.profileId)[0].substance).toBe(
      "EXPB Penicillin"
    );
    expect(rowsFor("conditions", a.profileId)[0].name).toBe(
      "EXPA Hypertension"
    );
    expect(rowsFor("encounters", a.profileId)[0].type).toBe(
      "EXPA Office Visit"
    );
  });

  it("supplements (with folded dose schedule) + log scope through the intake_items JOIN", () => {
    // The fixture seeds one supplement (Vitamin D) + one medication (Lisinopril),
    // each with a single dose, per profile — a leak would surface the other
    // profile's items here. The merged `intake_items` dataset is one row per item
    // with its dose schedule folded into a `schedule` summary.
    const items = rowsFor("intake_items", a.profileId);
    expect(items).toHaveLength(2);
    expect(items.every((r) => String(r.name).startsWith("EXPA"))).toBe(true);
    expect(items.some((r) => String(r.name).startsWith("EXPB"))).toBe(false);
    // The Vitamin D dose (morning / 1 cap) is folded into the schedule column.
    const vitD = items.find((r) => String(r.name) === "EXPA Vitamin D")!;
    expect(String(vitD.schedule)).toContain("morning");
    expect(String(vitD.schedule)).toContain("1 cap");

    const log = rowsFor("intake_log", a.profileId);
    expect(log).toHaveLength(1);
    expect(String(log[0].item)).toBe("EXPA Vitamin D");
  });

  // The `carries no id` half of this case is gone (#5296). Whether a dataset emits an
  // `id` is a property of its SELECT, and asserting it here is the property the
  // scoping loop was corrected to stop trusting: an aliased `id AS row_id` used to buy
  // a dataset an exemption and delete its case. hr_minutes is scoped by the same
  // row-content comparison every other dataset gets; what is left here is the seeded
  // bpm, which says WHICH profile's row came back.
  it("hr_minutes (composite key, browse-only) returns its own profile's row", () => {
    const rowsA = rowsFor("hr_minutes", a.profileId);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].bpm).toBe(60);
  });
});

describe("new dataset CSV shape", () => {
  it("metric_samples emits a header + one line per row", () => {
    const ds = getDataset("metric_samples")!;
    const rows = ds.rows(a.profileId);
    const csv = toCsv(ds.columns, rows);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(ds.columns.join(","));
    expect(lines.length).toBe(1 + rows.length);
  });

  it("allergies CSV header matches the declared columns", () => {
    const ds = getDataset("allergies")!;
    const csv = toCsv(ds.columns, ds.rows(a.profileId));
    expect(csv.startsWith(ds.columns.join(",") + "\n")).toBe(true);
  });
});

describe("dataset delete affordance", () => {
  it("child/composite datasets are non-deletable; core datasets are deletable", () => {
    const del = (k: string) => DATASETS.find((d) => d.key === k)!.deletable;
    expect(del("intake_log")).toBe(false);
    expect(del("hr_minutes")).toBe(false);
    // Undefined (the default) means deletable — the clinical + sample datasets,
    // plus the merged supplements/medications dataset (item-level rows).
    expect(getDataset("intake_items")!.deletable).not.toBe(false);
    expect(getDataset("allergies")!.deletable).not.toBe(false);
    expect(getDataset("conditions")!.deletable).not.toBe(false);
    expect(getDataset("encounters")!.deletable).not.toBe(false);
    expect(getDataset("metric_samples")!.deletable).not.toBe(false);
    // #5026 phase 2: the substance COUNTER and its EVENT ledger are one fact in two
    // tables, and the manage delete is a plain id + profile_id statement that can only
    // move one of them — so both are browse-only, together. Named here rather than left
    // to the sync invariants below, which only check that the flag and the policy
    // AGREE: re-adding both entries would satisfy them and reopen the split.
    expect(del("substance_daily_totals")).toBe(false);
    expect(del("substance_log_events")).toBe(false);
  });
});

// Class-guarding invariant: the delete-button UI (DataExport renders Edit/Delete
// whenever deletable !== false) and the manage-actions delete policy must agree.
// A deletable dataset with no DELETE_POLICY entry renders a delete button whose
// action resolves to "Unknown dataset" and silently no-ops (the pre-existing
// immunizations bug); a browse-only dataset with a stray policy entry would offer
// a delete the UI never surfaces. Both directions fail here instead of in prod.
describe("DATASETS ⇄ DELETE_POLICY stay in sync", () => {
  it("every deletable dataset has a matching DELETE_POLICY entry", () => {
    const missing = DATASETS.filter(
      (d) => d.deletable !== false && !(d.key in DELETE_POLICY)
    ).map((d) => d.key);
    expect(missing).toEqual([]);
  });

  it("no browse-only (deletable:false) dataset has a DELETE_POLICY entry", () => {
    const stray = DATASETS.filter(
      (d) => d.deletable === false && d.key in DELETE_POLICY
    ).map((d) => d.key);
    expect(stray).toEqual([]);
  });

  it("immunizations is deletable and now covered by DELETE_POLICY", () => {
    expect(getDataset("immunizations")!.deletable).not.toBe(false);
    expect(DELETE_POLICY.immunizations).toBeDefined();
  });
});

// THE DECLARED SELECT IS THE STATEMENT THE EXPORT RUNS (#5117).
//
// `ExportDataset.select` is what the column guard
// (lib/__db_tests__/export-completeness.test.ts) prepares to decide which columns the
// export carries. That makes it a measurement of a DECLARATION unless something binds
// it to the reads: `activities`, `intake_items` and `providers` hand-write their
// rows()/page() SQL, so dropping a column from one of them while `select` keeps it
// used to ship a JSON without the column and a CSV header promising it, with every
// export spec green.
//
// This compares the KEYS the readers actually emit against the result columns the
// declared select emits — the same names toCsv keys on. A dataset with no seeded rows
// has no keys to read, so the check is silent about it; that is why the two lists
// below exist, and why the last case fails on a dataset that is bound by neither.
// The cells a dataset builds after the read are declared ON the dataset (`jsBuilt` in
// lib/export.ts) and read from there by both guards — this one and the CSV header
// check in lib/__db_tests__/export-completeness.test.ts. A second list here, never
// cross-checked against that one, is how a declared cell no reader builds stays green.
const jsBuiltColumns = (ds: (typeof DATASETS)[number]) =>
  (ds.jsBuilt ?? []).map((c) => c.column);

// The datasets tableDataset() does NOT build — they hand-write their reads instead of
// taking q(select)/qPage(select) from it — so the binding has to be PROVEN on seeded
// rows rather than held by construction. It was three; `activities` and `intake_items`
// came off it when tableDataset grew the `shape` hook their child-table fold needed
// (#5324). `providers` cannot follow: its declared select's one `?` stands for the
// runtime id LIST, not the profile id, so q(select) would bind a profile id into
// `id IN (?)`.
const HAND_AUTHORED_READS = ["providers"];

describe("the declared select is the statement the export runs (#5117)", () => {
  const expectedKeys = (ds: (typeof DATASETS)[number]) =>
    new Set([
      ...db
        .prepare(ds.select)
        .columns()
        .map((c) => c.name),
      ...jsBuiltColumns(ds),
    ]);

  // A dataset that folds a child table in builds its rows as an object LITERAL
  // (shapeActivities), so dropping a column from the read leaves the key in place and
  // the value `undefined` — the key set alone cannot see it. A shipped cell is a value
  // or SQL NULL; `undefined` means a shaper read a field the statement never selected.
  //
  // THE LIMIT OF THIS RULE, stated where it lives: `undefined` catches a MISSING
  // value, never a WRONG one. A shaper that wrote `notes: a.title` passes here and
  // ships the wrong column; only reading the shaper, or a per-dataset value assertion,
  // sees that. The claim these cases support is about which KEYS the export emits.
  const unselectedCells = (rows: Record<string, unknown>[], key: string) => {
    const bad: string[] = [];
    for (const row of rows) {
      for (const [k, v] of Object.entries(row)) {
        if (v === undefined) bad.push(`${key}.${k}`);
      }
    }
    return [...new Set(bad)];
  };

  it("rows() emits exactly what the declared select selects", () => {
    for (const ds of DATASETS) {
      const rows = ds.rows(a.profileId);
      if (rows.length === 0) continue; // nothing seeded — see the case below
      expect(new Set(Object.keys(rows[0])), `${ds.key}.rows()`).toEqual(
        expectedKeys(ds)
      );
      expect(
        unselectedCells(rows, ds.key),
        `\n${ds.key}.rows() ships cells its statement never selected — the JSON has no value and the CSV header still promises the column:\n`
      ).toEqual([]);
    }
  });

  it("page() emits exactly what the declared select selects", () => {
    for (const ds of DATASETS) {
      const page = ds.page(a.profileId, 25, 0);
      if (page.length === 0) continue;
      expect(new Set(Object.keys(page[0])), `${ds.key}.page()`).toEqual(
        expectedKeys(ds)
      );
      expect(
        unselectedCells(page, ds.key),
        `\n${ds.key}.page() ships cells its statement never selected:\n`
      ).toEqual([]);
    }
  });

  it("the hand-authored datasets really are exercised above", () => {
    // Without rows the two cases above are vacuous for exactly the datasets that can
    // drift, so the seeding is part of the check, not setup for it.
    for (const key of HAND_AUTHORED_READS) {
      expect(getDataset(key)!.rows(a.profileId).length, key).toBeGreaterThan(0);
      expect(
        getDataset(key)!.page(a.profileId, 25, 0).length,
        key
      ).toBeGreaterThan(0);
    }
  });

  it("every dataset is bound to its select — by construction or by the case above", () => {
    // tableDataset() sets `readsSelect`, and its rows/page ARE q(select)/qPage(select).
    // Anything else must be in HAND_AUTHORED_READS, which the seeded comparison covers.
    const unbound = DATASETS.filter(
      (d) => !readsSelect(d) && !HAND_AUTHORED_READS.includes(d.key)
    ).map((d) => d.key);
    expect(
      unbound,
      `\nThese datasets hand-write their reads and nothing proves the reads match their declared select.\nSeed them in this file and add them to HAND_AUTHORED_READS:\n${unbound.join("\n")}\n`
    ).toEqual([]);
    // …and nothing is listed that tableDataset now builds.
    const stale = HAND_AUTHORED_READS.filter((key) => {
      const ds = getDataset(key);
      return ds && readsSelect(ds);
    });
    expect(stale, `built by tableDataset now — remove from the list`).toEqual(
      []
    );
  });

  it("every declared JS-built cell is actually built, on a seeded row", () => {
    // A `jsBuilt` entry says a column reaches the CSV even though no SELECT emits it.
    // Unchecked, that is a hatch: name any column and any builder — a function that
    // exists nowhere included — and the CSV header check above goes quiet while every
    // row ships an empty cell under the name. So the claim is run: seeded rows, the
    // column present, and its value not `undefined`.
    const missing: string[] = [];
    for (const ds of DATASETS) {
      for (const cell of ds.jsBuilt ?? []) {
        const rows = ds.rows(a.profileId);
        const page = ds.page(a.profileId, 25, 0);
        if (rows.length === 0 || page.length === 0) {
          missing.push(
            `${ds.key}.${cell.column}: no seeded row to build it on — seed ${ds.key} in this file`
          );
          continue;
        }
        // WHAT THIS ESTABLISHES, exactly: the cell is on every row the export
        // emits, with a value rather than `undefined`. It does NOT establish that
        // the value came from `cell.by` — the two guards that reached for that (a
        // regex over `String(reader)`, and a source-text read of lib/export.ts for a
        // declaration of that name) both existed because `by` was a STRING that
        // could name nothing at all. It is the function reference now (#5324), so
        // what is left is the behavioural half, which is the half worth running.
        for (const [reader, got] of [
          ["rows()", rows],
          ["page()", page],
        ] as const) {
          const built = got.every(
            (r) => cell.column in r && r[cell.column] !== undefined
          );
          if (!built) {
            missing.push(
              `${ds.key}.${cell.column}: ${ds.key}.${reader} does not put it on every row — ${cell.by.name}() is not building it`
            );
          }
        }
      }
    }
    expect(
      missing,
      `\nDeclared as built in JS after the read (jsBuilt in lib/export.ts), but not actually emitted:\n${missing.join("\n")}\n`
    ).toEqual([]);
  });
});

// EVERY DATASET, NOT A HAND-PICKED SUBSET (#5117). The profile-scoping scan reads
// `q(sql)`/`qPage(sql)` as non-literals, so its ALLOW_NON_LITERAL and ALLOW_COMPOSED
// entries for lib/export.ts do not read the dataset SELECTs at all — they point HERE
// for the per-dataset claim, and until this loop existed that claim was a sentence
// about a subset. Measured on the pre-loop tree: replacing `WHERE profile_id = ?`
// with `WHERE ? IS NOT NULL` in the `body_metrics`, `practice_logs` or
// `food_log_events` select left profile-scoping.test.ts, export.test.ts and
// export-completeness.test.ts all green.
//
// The comparison is by ROW CONTENT, and it used to be by `id`. That mattered: whether
// a row carries an `id` is a property of the SELECT, decided in lib/export.ts — the
// same file a leak is written in — so the exempt list below could be made true by the
// leak it was meant to catch. Aliasing `id AS row_id`, adding `row_id` to `columns`
// and dropping the WHERE admitted the dataset as "an id comparison cannot judge it",
// deleted its case, and shipped a real cross-profile leak with the whole db tier
// green. A's rows and B's rows are the same statement run twice, so a row that
// reaches both is a row one of them should never have seen — and that question needs
// no `id` at all. `hr_minutes` and `glucose_trace`, composite-keyed with no `id` in
// the table, therefore get ordinary cases here instead of exemptions.

// Rows as comparable values. Both profiles run the same prepared statement, so the
// keys and their order are identical and string equality is row equality.
const fingerprints = (ds: (typeof DATASETS)[number], profileId: number) =>
  ds.rows(profileId).map((r) => JSON.stringify(r));

// The one thing a row comparison cannot judge: a dataset over a GLOBAL table, where
// both profiles seeing the SAME row is the design. The property that admits an entry
// is read off OWNED_TABLES + ownedChildTables(db) — the ownership the profile-delete
// sweep walks and the profile-scoping scan derives from the schema — so an entry
// here has to be bought by changing what the instance considers profile-owned, in
// another file, against a test that checks that set against the schema source.
const SCOPING_GLOBAL: { key: string; why: string }[] = [
  {
    key: "providers",
    why: "the one GLOBAL dataset. A provider row belongs to the instance, not to a profile, and both profiles' encounters reference the SAME row on purpose — identical rows here are the design. What scopes it is the id list referencedProviderIds(profileId) gathers, and every arm of that walk gets its own seeded case below, built out of PROVIDER_LINK_SELECTS itself; that the reader runs the declared statement is the select-binding case above",
  },
];

// EVERY OTHER DATASET IS SEEDED, NOT LISTED (#5314). This used to be
// SCOPING_UNSEEDED, 37 names the loop below was silent about: the shared fixture
// seeds no row for them, both profiles came back empty, and `WHERE profile_id = ?`
// could be deleted from any of those 37 statements with nothing observing it. A
// shorter list would have grown back, so there is no list — the row is DERIVED from
// the dataset:
//
//   - WHICH column distinguishes the two profiles is read off the dataset's own
//     select (a text or numeric column of ds.table that the select emits and that is
//     not a key, an FK or profile_id), because the loop compares row CONTENT: two
//     rows that differ only by `id` would let an id-shaped leak through.
//   - EVERYTHING ELSE the row needs comes from seedSchemaRow, which fills required
//     columns from the schema and reaches profile_id through the parent FK for a
//     child table.
//
// So a dataset added tomorrow arrives with its case already written, and one this
// cannot seed THROWS naming itself — an unseedable dataset is the defect, not an
// exemption.
type PhysicalColumn = { name: string; type: string; pk: number };

// Columns of ds.table this dataset actually emits, minus the ones that cannot carry a
// per-profile difference: keys renumber, FKs point at a parent already scoped, and
// profile_id is the thing under test.
function distinguishableColumns(ds: (typeof DATASETS)[number]): string[] {
  const emitted = new Set(
    db
      .prepare(ds.select)
      .columns()
      .filter((c) => c.table === ds.table && c.column)
      .map((c) => c.column!)
  );
  const fks = new Set(
    (db.pragma(`foreign_key_list(${ds.table})`) as { from: string }[]).map(
      (f) => f.from
    )
  );
  const cols = db.pragma(`table_info(${ds.table})`) as PhysicalColumn[];
  const usable = cols.filter(
    (c) =>
      emitted.has(c.name) &&
      !c.pk &&
      c.name !== "profile_id" &&
      !fks.has(c.name)
  );
  // Text first: a free-form text column is the one least likely to be CHECK'd to a
  // closed set of values, and the fallback below tries the rest in turn anyway.
  return [
    ...usable.filter((c) => /CHAR|CLOB|TEXT/i.test(c.type)),
    ...usable.filter((c) => !/CHAR|CLOB|TEXT/i.test(c.type)),
  ].map((c) => c.name);
}

// The rows the derivation above cannot produce, because a MULTI-COLUMN CHECK ties
// several columns together and no single made-up value satisfies it. This is a list
// of ROWS, not of exemptions: a dataset here still gets its case, and its row still
// has to differ between the profiles or the case reds. Keep it as short as the
// schema forces.
const SCOPING_SEEDS: Record<string, (tag: string) => Record<string, unknown>> =
  {
    // CHECK ties `kind` to exactly one of goal_key / condition_id / biomarker_key, with
    // `direction` allowed only on the biomarker arm.
    intake_item_purposes: (tag) => ({
      kind: "goal",
      goal_key: `${tag.toLowerCase()}-purpose`,
      condition_id: null,
      biomarker_key: null,
      direction: null,
    }),
  };

// One row of `ds`, belonging to `p`, whose emitted content differs from the other
// profile's. Candidate columns are tried in turn because a CHECK constraint can
// refuse a made-up value; the FIRST that inserts is the one used, and running out is
// an error naming the dataset.
function seedForScoping(
  ds: (typeof DATASETS)[number],
  p: SeededProfile,
  ordinal: number
): void {
  const explicit = SCOPING_SEEDS[ds.key];
  if (explicit) {
    seedSchemaRow(ds.table, explicit(p.tag), p.profileId);
    return;
  }
  const refusals: string[] = [];
  for (const column of distinguishableColumns(ds)) {
    const type = (
      db.pragma(`table_info(${ds.table})`) as PhysicalColumn[]
    ).find((c) => c.name === column)!.type;
    const value = /CHAR|CLOB|TEXT/i.test(type) ? `${p.tag} scope` : ordinal;
    try {
      seedSchemaRow(ds.table, { [column]: value }, p.profileId);
      return;
    } catch (e) {
      refusals.push(`${column}=${String(value)}: ${(e as Error).message}`);
    }
  }
  throw new Error(
    `${ds.key}: could not seed a row on ${ds.table} that differs between profiles. Seed one by hand in this file's beforeAll.\n${refusals.join("\n")}`
  );
}

describe("every dataset's rows() and page() are profile-scoped (#5117)", () => {
  const skipped = new Set(SCOPING_GLOBAL.map((e) => e.key));
  const checked = DATASETS.filter((ds) => !skipped.has(ds.key)).map(
    (ds) => ds.key
  );

  // Fill the gaps the shared fixture leaves, so every case below has both profiles'
  // rows to compare (#5314). Datasets seeded above keep the rows they already have.
  beforeAll(() => {
    for (const ds of DATASETS) {
      if (skipped.has(ds.key)) continue;
      let ordinal = 0;
      for (const p of [a, b]) {
        ordinal += 1;
        if (ds.rows(p.profileId).length === 0) seedForScoping(ds, p, ordinal);
      }
    }
  });

  it.each(checked)("%s carries none of the other profile's rows", (key) => {
    const ds = getDataset(key)!;
    const rowsB = new Set(fingerprints(ds, b.profileId));
    // The fixture has to REACH the state the assertion forbids: with no B row there
    // is nothing that could leak, and every assertion below would pass on an empty
    // set.
    expect(
      rowsB.size,
      `${key}: nothing seeded for the other profile`
    ).toBeGreaterThan(0);
    const rowsA = fingerprints(ds, a.profileId);
    const pageA = ds.page(a.profileId, 1000, 0).map((r) => JSON.stringify(r));
    expect(rowsA.length, `${key}.rows()`).toBeGreaterThan(0);
    expect(pageA.length, `${key}.page()`).toBeGreaterThan(0);
    // A failure here is a leak — unless the fixture seeded a row that is identical
    // on BOTH profiles, in which case it is telling you the case cannot see one:
    // make the two profiles' rows distinguishable rather than exempting the dataset.
    expect(
      rowsA.filter((r) => rowsB.has(r)),
      `${key}.rows() returned the other profile's rows`
    ).toEqual([]);
    expect(
      pageA.filter((r) => rowsB.has(r)),
      `${key}.page() returned the other profile's rows`
    ).toEqual([]);
    // count() runs its OWN statement — tableDataset's `countSql`, not the select the
    // two assertions above cover — and it discloses row VOLUME: it feeds
    // manifest.json's datasetCounts and the Data page total. Leaking the countSql of
    // body_metrics, practice_logs and food_log_events at once left the whole db tier
    // green. Both profiles, because a count that dropped its filter agrees with
    // neither.
    for (const p of [a, b]) {
      expect(
        ds.count(p.profileId),
        `${key}.count() disagrees with ${key}.rows() — a count that counts another profile's rows discloses their volume`
      ).toBe(ds.rows(p.profileId).length);
    }
  });

  it("the datasets the loop skips are exactly the ones named", () => {
    const exempt = new Set(SCOPING_GLOBAL.map((e) => e.key));
    const unseeded = DATASETS.filter((ds) => !exempt.has(ds.key))
      .filter(
        (ds) =>
          ds.rows(a.profileId).length === 0 || ds.rows(b.profileId).length === 0
      )
      .map((ds) => ds.key);
    // NOT a list to append to (#5314). Every dataset the export can emit is seeded on
    // both profiles and gets a case; the only skip is a GLOBAL table, asserted exact
    // below against schema-derived ownership.
    expect(
      unseeded,
      `\nDatasets the loop above is silent about — they have no row on one of the two profiles, so their case cannot fail. seedForScoping() above should have filled this in:\n${unseeded.join("\n")}\n`
    ).toEqual([]);
    // A global dataset must still be SEEDED — otherwise its exemption is really the
    // unseeded one wearing a reason, and the reason stops being true unnoticed.
    for (const e of SCOPING_GLOBAL) {
      expect(e.why.trim().length).toBeGreaterThan(0);
      for (const p of [a, b]) {
        const rows = getDataset(e.key)!.rows(p.profileId);
        expect(rows.length, e.key).toBeGreaterThan(0);
        // Its count() is watched here too — a global dataset skips the case above,
        // so this is the only place it is read. `providers` has no countSql: its
        // count re-runs referencedProviderIds, so what this catches is that count
        // and rows drift apart, not a dropped predicate.
        expect(getDataset(e.key)!.count(p.profileId), `${e.key}.count()`).toBe(
          rows.length
        );
      }
    }
    // …and this list is asserted EXACT too, on the ONE property that admits an entry:
    // a seeded dataset whose TABLE is not profile-owned, so both profiles reading the
    // same row is the design. Seeded + a reason was true of every dataset, so a line
    // added here used to delete that dataset's case in silence. The property is read
    // off OWNED_TABLES + ownedChildTables(db) — schema-derived, and load-bearing for
    // profile deletion — never off what a SELECT emits, so an edit in lib/export.ts
    // cannot make its own exemption true.
    const profileScoped = new Set([
      ...OWNED_TABLES,
      ...ownedChildTables(db).keys(),
    ]);
    const exemptable = DATASETS.filter(
      (ds) =>
        ds.rows(a.profileId).length > 0 &&
        ds.rows(b.profileId).length > 0 &&
        !profileScoped.has(ds.table)
    ).map((ds) => ds.key);
    expect(
      exemptable.sort(),
      `\nSeeded datasets over a GLOBAL table. SCOPING_GLOBAL must name exactly these — every other seeded dataset gets a case:\n${exemptable.join("\n")}\n`
    ).toEqual(SCOPING_GLOBAL.map((e) => e.key).sort());
    expect(checked.length).toBeGreaterThan(0);
  });
});

// EVERY ARM OF THE PROVIDER WALK IS PROFILE-SCOPED (#5117).
//
// `providers` is GLOBAL, so the providers dataset's own SELECT has no profile filter
// to read and the profile-scoping scan's ALLOW_NON_LITERAL entry for
// `providersSelect(ph)` says exactly that. What the entry then CITES is
// referencedProviderIds() — the walk that decides which provider ids this profile may
// see. Nothing ran that claim, and it is the whole filter: turning one arm's
// `profile_id = ?` into `profile_id != ?` puts another profile's providers, an
// oncology centre by name, into this profile's export with both tiers green. A `why`
// that names a mechanism nothing exercises is worse than no `why`.
//
// The cases are built FROM the array referencedProviderIds iterates, not from a list
// beside it, so an arm cannot enter the walk without entering this loop: an eleventh
// link table arrives with its case already written.
describe("every PROVIDER_LINK_SELECTS arm is profile-scoped (#5117)", () => {
  const tableOf = (arm: string) => /\bFROM\s+(\w+)/i.exec(arm)?.[1];
  const colOf = (arm: string) =>
    /^\s*SELECT\s+(?:\w+\.)?(\w+)\s+AS\s+pid\b/i.exec(arm)?.[1];

  // A third profile, so the absence below is asserted against a profile that shares
  // nothing with the one the arm rows belong to.
  let leaky: SeededProfile;
  beforeAll(() => {
    leaky = seedProfile("PLNK");
  });

  const providerNames = (profileId: number) =>
    getDataset("providers")!
      .rows(profileId)
      .map((r) => r.name);

  it("reads the arm list off the walk itself", () => {
    // A parse that silently found nothing would make every case below vacuous.
    expect(PROVIDER_LINK_SELECTS.length).toBeGreaterThan(5);
    for (const arm of PROVIDER_LINK_SELECTS) {
      expect(tableOf(arm), arm).toBeTruthy();
      expect(colOf(arm), arm).toBeTruthy();
      // …and each arm is ONE simple SELECT. A compound arm would gain a case whose
      // seeding only ever reaches its first FROM, while the second half goes
      // unwatched — which is what makes it look covered.
      expect(
        arm.match(/\bSELECT\b/gi)?.length,
        `this arm is itself a compound — split it into separate arms: ${arm}`
      ).toBe(1);
    }
  });

  it.each(
    PROVIDER_LINK_SELECTS.map(
      (arm, i) => [i, tableOf(arm)!, colOf(arm)!] as const
    )
  )(
    "arm %i (%s.%s) keeps its own profile's providers out of another profile's export",
    (i, table, col) => {
      const name = `Arm ${i} Oncology Centre`;
      const providerId = Number(
        db
          .prepare(
            `INSERT INTO providers (name, type, dedup_key) VALUES (?, 'organization', ?)`
          )
          .run(name, `arm ${i} oncology|organization`).lastInsertRowid
      );
      seedSchemaRow(table, { [col]: providerId }, leaky.profileId);
      // The positive control runs through the SAME reader the absence is asserted
      // on: the seeded link really does carry this provider into its own profile's
      // export, so the absence next door is about the arm's filter and not about a
      // row that never reached the walk.
      expect(
        providerNames(leaky.profileId),
        `arm ${i} (${table}.${col}) never reached the providers export — the case below would pass on nothing`
      ).toContain(name);
      expect(
        providerNames(a.profileId),
        `arm ${i} (${table}.${col}) put another profile's provider in this profile's export`
      ).not.toContain(name);
    }
  );
});

// PROVENANCE COLUMNS REACH THE ARCHIVE (#5117).
//
// `bundle_id` records that one act wrote several rows. Four exported tables carry it,
// and the archive ships each dataset twice: datasets/<key>.json is whatever rows()
// emits, datasets/<key>.csv is toCsv(ds.columns, rows). A column has to be in BOTH
// spellings to reach the person reading the archive — in the SELECT but not `columns`
// and the CSV drops it; in `columns` but not the SELECT and the CSV header promises a
// column that is empty on every row. Each dataset is checked in both.
const BUNDLE_ID_DATASETS = [
  "body_metrics",
  "practice_logs",
  "food_log_events",
  "intake_log",
];

// One bundle id per profile, stamped on all four tables. `bundle_id` is minted per
// act and never shared between profiles, so a value is an unambiguous label for whose
// row this is — which is what lets the same column answer the scoping question below.
const OWN_BUNDLE = "bundle-own-profile";
const OTHER_BUNDLE = "bundle-other-profile";

// The fixture already seeds a weigh-in and a dose log for each profile; the other two
// tables have no seeded row, so add one. Values are set here rather than through a
// writer because two of these four have no writer (see the last case).
const stampBundle = (profileId: number, bundle: string) => {
  db.prepare(`UPDATE body_metrics SET bundle_id = ? WHERE profile_id = ?`).run(
    bundle,
    profileId
  );
  db.prepare(
    `UPDATE intake_item_logs SET bundle_id = ?
       WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ?)`
  ).run(bundle, profileId);
  db.prepare(
    `INSERT INTO practice_logs (profile_id, practice, date, duration_min, bundle_id)
     VALUES (?, 'breathwork', '2024-01-02', 20, ?)`
  ).run(profileId, bundle);
  db.prepare(
    `INSERT INTO food_log_events
       (profile_id, group_key, date, recorded_at, bundle_id)
     VALUES (?, 'lunch', '2024-01-02', '2024-01-02T12:00:00Z', ?)`
  ).run(profileId, bundle);
};

describe("bundle_id reaches both spellings of every dataset that carries it (#5117)", () => {
  beforeAll(() => {
    stampBundle(a.profileId, OWN_BUNDLE);
    // BOTH profiles, because the scoping half below needs a row that is there to
    // leak: an assertion run against an empty other profile passes on an export that
    // returns every profile's rows.
    stampBundle(b.profileId, OTHER_BUNDLE);
  });

  it.each(BUNDLE_ID_DATASETS)(
    "%s ships bundle_id in both the dataset JSON and the dataset CSV",
    (key) => {
      const ds = getDataset(key)!;
      const rows = ds.rows(a.profileId);
      const row = rows.find((r) => r.bundle_id === OWN_BUNDLE);
      // datasets/<key>.json — the value the SELECT read, on the row it belongs to.
      expect(row, `${key}.rows() carries no bundle_id`).toBeDefined();
      // datasets/<key>.csv — the header names it and the cell carries it. bundle_id
      // is the last declared column of all four, so the line ends with its cell.
      const [header, line] = toCsv(ds.columns, [row!]).trimEnd().split("\n");
      expect(header.endsWith(",bundle_id"), header).toBe(true);
      expect(line.endsWith(`,${OWN_BUNDLE}`), line).toBe(true);
    }
  );

  // The column that carries provenance also answers "whose row is this?", so it is
  // what proves each of these four SELECTs is still profile-scoped. Nothing else in
  // the suite watches three of them: rewriting `WHERE profile_id = ?` to
  // `WHERE (profile_id = ? OR 1=1)` in the body_metrics, practice_logs or
  // food_log_events select leaves every other test in both tiers green, and every
  // profile's rows reach every profile's export.
  it.each(BUNDLE_ID_DATASETS)("%s exports no other profile's row", (key) => {
    const bundles = getDataset(key)!
      .rows(a.profileId)
      .map((r) => r.bundle_id);
    expect(bundles, `${key}.rows() is not empty`).toContain(OWN_BUNDLE);
    expect(
      bundles,
      `${key}.rows() returned the other profile's rows`
    ).not.toContain(OTHER_BUNDLE);
  });

  // Every production statement that writes `table`.`column`, by repo-relative path.
  // Read off the source through the shared scanner, because the claim PENDING_COLUMNS
  // makes is about WRITERS and there is no other way to ask about a writer that does
  // not exist. Scoped to the column's own table: `bundle_id` has real writers on
  // intake_item_logs and food_log_events, so an unscoped sweep for the name would be
  // red on the two entries that are true.
  const writersOf = (table: string, column: string) => {
    const wrote = new RegExp(
      `\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE)\\s+${table}\\b`,
      "i"
    );
    const names = new RegExp(`\\b${column}\\b`);
    const hits = new Set<string>();
    for (const file of sourceFiles()) {
      const src = readSource(file);
      for (const arg of [...prepareArgs(src), ...execArgs(src)]) {
        if (wrote.test(arg.text) && names.test(arg.text))
          hits.add(relPath(file));
      }
    }
    return [...hits].sort();
  };

  it("the columns nothing writes yet are named in the manifest (#5273)", () => {
    // `body_metrics.bundle_id` and `practice_logs.bundle_id` have no writer: a single
    // weigh-in or practice entry is one row, so nothing mints an act id for them. The
    // columns still ship, so two archives keep diffing cleanly when a writer lands —
    // and manifest.json names them, so the empty column reads as pending. The values
    // above were set by hand for exactly that reason.
    //
    // BOTH spellings, for the reason at the top of this block: a pending column named
    // only in `columns` is a CSV header promise with no JSON row behind it, which is
    // a worse thing to tell a person than saying nothing.
    for (const { dataset, column } of PENDING_COLUMNS) {
      const ds = getDataset(dataset)!;
      expect(ds.columns, `${dataset}.columns`).toContain(column);
      const rows = ds.rows(a.profileId);
      expect(rows.length, `${dataset} has no seeded row here`).toBeGreaterThan(
        0
      );
      expect(Object.keys(rows[0]), `${dataset}.rows()`).toContain(column);
    }
  });

  it("nothing production writes a column the manifest calls pending (#5296)", () => {
    // The two cases above check the column is PRESENT. Presence is not the claim
    // manifest.json makes to a person — "nothing writes them yet, so they are empty
    // on every row" is — and presence is true of every shipped column, so swapping
    // `bundle_id` for `weight_kg` passed both arms while telling a family their
    // weight is empty in the archive they just downloaded. This asks the claim.
    const written = PENDING_COLUMNS.map(({ dataset, column }) => ({
      at: `${getDataset(dataset)!.table}.${column}`,
      by: writersOf(getDataset(dataset)!.table, column),
    })).filter((e) => e.by.length > 0);
    expect(
      written,
      `\nmanifest.json calls these columns pending — "empty on every row" — and production writes them. Delete the PENDING_COLUMNS entry now its writer has landed:\n${written
        .map((e) => `${e.at} written by ${e.by.join(", ")}`)
        .join("\n")}\n`
    ).toEqual([]);
  });
});
