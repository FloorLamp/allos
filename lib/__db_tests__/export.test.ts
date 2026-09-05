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
import { DATASETS, DELETE_POLICY, getDataset, toCsv } from "@/lib/export";
import { OWNED_TABLES } from "@/lib/owned-tables";
import { ownedChildTables } from "@/lib/profile-delete";
import { stripComments } from "../__tests__/strip-comments";
import { PENDING_COLUMNS } from "@/lib/export-manifest";
import { db } from "@/lib/db";
import { seedProfile, type SeededProfile } from "./fixtures";

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
  for (const { p, bpm } of [
    { p: a, bpm: 60 },
    { p: b, bpm: 99 },
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
  }
});

const rowsFor = (key: string, profileId: number) =>
  getDataset(key)!.rows(profileId);
const countFor = (key: string, profileId: number) =>
  getDataset(key)!.count(profileId);
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
  it("count() equals the full row total, per profile, incl. JOIN datasets", () => {
    for (const key of [
      "medical_records",
      "activities",
      "intake_items",
      "intake_log",
      "hr_minutes",
      "allergies",
    ]) {
      expect(countFor(key, a.profileId)).toBe(rowsFor(key, a.profileId).length);
      expect(countFor(key, b.profileId)).toBe(rowsFor(key, b.profileId).length);
    }
  });

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

  it("hr_minutes (composite key, browse-only) is scoped and carries no id", () => {
    const rowsA = rowsFor("hr_minutes", a.profileId);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].bpm).toBe(60);
    expect(rowsA[0].id).toBeUndefined();
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

// The datasets that do NOT carry the `readsSelect` marker — they hand-write their
// reads instead of taking q(select)/qPage(select) from tableDataset — so the binding
// has to be PROVEN on seeded rows rather than held by construction.
const HAND_AUTHORED_READS = ["activities", "intake_items", "providers"];

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
      (d) => !d.readsSelect && !HAND_AUTHORED_READS.includes(d.key)
    ).map((d) => d.key);
    expect(
      unbound,
      `\nThese datasets hand-write their reads and nothing proves the reads match their declared select.\nSeed them in this file and add them to HAND_AUTHORED_READS:\n${unbound.join("\n")}\n`
    ).toEqual([]);
    // …and nothing is listed that tableDataset now builds.
    const stale = HAND_AUTHORED_READS.filter(
      (key) => getDataset(key)?.readsSelect
    );
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
        for (const [reader, got, fn] of [
          ["rows()", rows, ds.rows],
          ["page()", page, ds.page],
        ] as const) {
          const built = got.every(
            (r) => cell.column in r && r[cell.column] !== undefined
          );
          if (!built) {
            missing.push(
              `${ds.key}.${cell.column}: ${ds.key}.${reader} does not put it on every row — ${cell.by}() is not building it`
            );
          }
          // …and `by` names THE builder, not merely a function of that name.
          // export-completeness.test.ts reads lib/export.ts as text and can only ask
          // whether such a function is declared — renaming this to `shapeSupplements`,
          // a real function building a different cell, passes there. Here the reader
          // itself is in hand, so the call can be looked for in its own source.
          //
          // WHAT THIS ESTABLISHES, exactly: the reader's CODE names `by(`. Comments
          // are stripped first (the shared scanner, #3595 — they are part of
          // `String(fn)`, and one line mentioning the function by name satisfied this
          // while the reader called something else). It still does not establish that
          // the emitted cell CAME from that call — the `built` check above is what
          // says the cell is there, and the two together are what the declaration is
          // worth.
          if (
            !new RegExp(`\\b${cell.by}\\s*\\(`).test(stripComments(String(fn)))
          ) {
            missing.push(
              `${ds.key}.${cell.column}: ${ds.key}.${reader} never calls ${cell.by}() — jsBuilt names a function that does not build this cell`
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
// The comparison is by ROW ID: A's rows() and A's page() may carry no id that belongs
// to B. Two things a dataset can be that an id comparison cannot judge, and both are
// NAMED below rather than filtered out — a silent skip would move the very problem
// this loop exists to close one level up.

// Ids that are legitimately shared, or not there at all.
const SCOPING_ID_EXEMPT: { key: string; why: string }[] = [
  {
    key: "hr_minutes",
    why: "a composite-key browse dataset: its rows carry no `id` to compare (asserted above), so its scoping is pinned on the seeded bpm by the case above instead",
  },
  {
    key: "providers",
    why: "the one GLOBAL dataset. A provider row belongs to the instance, not to a profile, and both profiles' encounters reference the SAME row on purpose — a shared id here is the design. What scopes it is the id list referencedProviderIds(profileId) walks, and that the reader runs the declared statement is the select-binding case above",
  },
];

// Datasets the shared fixture seeds no row for, on either profile. The loop has
// nothing to compare for these and is therefore silent about them, so they are
// written down and the list is asserted EXACT: seeding one means deleting its name
// here, and a dataset that stops being seeded has to be added rather than quietly
// dropping out of the sweep.
const SCOPING_UNSEEDED = [
  "activity_routes",
  "activity_telemetry",
  "activity_laps",
  "activity_segment_efforts",
  "medical_record_revisions",
  "injuries",
  "niggles",
  "endurance_plans",
  "cycles",
  "mood_logs",
  "dose_schedule_versions",
  "glucose_trace",
  "procedures",
  "genomic_variants",
  "imaging_studies",
  "dental_procedures",
  "skin_lesions",
  "optical_prescriptions",
  "family_history",
  "care_goals",
  "appointments",
  "preventive_events",
  "preventive_overrides",
  "preventive_record_decisions",
  "protocols",
  "milestones",
  "equipment",
  "frequency_targets",
  "food_daily_totals",
  "substance_daily_totals",
  "protein_daily_totals",
  "fasts",
  "symptom_logs",
  "situations",
  "medication_courses",
  "intake_item_ingredients",
  "intake_item_purposes",
  "intake_item_side_effects",
];

describe("every dataset's rows() and page() are profile-scoped (#5117)", () => {
  const skipped = new Set([
    ...SCOPING_ID_EXEMPT.map((e) => e.key),
    ...SCOPING_UNSEEDED,
  ]);
  const checked = DATASETS.filter((ds) => !skipped.has(ds.key)).map(
    (ds) => ds.key
  );

  it.each(checked)(
    "%s carries no row belonging to the other profile",
    (key) => {
      const ds = getDataset(key)!;
      const idsB = new Set(ds.rows(b.profileId).map((r) => r.id));
      // The fixture has to REACH the state the assertion forbids: with no B row there
      // is no id that could leak, and every assertion below would pass on an empty set.
      expect(
        idsB.size,
        `${key}: nothing seeded for the other profile`
      ).toBeGreaterThan(0);
      const rowsA = ds.rows(a.profileId);
      const pageA = ds.page(a.profileId, 1000, 0);
      expect(rowsA.length, `${key}.rows()`).toBeGreaterThan(0);
      expect(pageA.length, `${key}.page()`).toBeGreaterThan(0);
      expect(
        rowsA.filter((r) => idsB.has(r.id)).map((r) => r.id),
        `${key}.rows() returned the other profile's rows`
      ).toEqual([]);
      expect(
        pageA.filter((r) => idsB.has(r.id)).map((r) => r.id),
        `${key}.page() returned the other profile's rows`
      ).toEqual([]);
    }
  );

  it("the datasets the loop skips are exactly the ones named", () => {
    const exempt = new Set(SCOPING_ID_EXEMPT.map((e) => e.key));
    const unseeded = DATASETS.filter((ds) => !exempt.has(ds.key))
      .filter(
        (ds) =>
          ds.rows(a.profileId).length === 0 || ds.rows(b.profileId).length === 0
      )
      .map((ds) => ds.key);
    expect(
      unseeded,
      `\nDatasets the loop above is silent about. Seed one in this file and delete its name from SCOPING_UNSEEDED, or add a newly unseeded one to it:\n${unseeded.join("\n")}\n`
    ).toEqual(SCOPING_UNSEEDED);
    // An id-exempt dataset must still be SEEDED — otherwise its exemption is really
    // the unseeded one wearing a reason, and the reason stops being true unnoticed.
    for (const e of SCOPING_ID_EXEMPT) {
      expect(e.why.trim().length).toBeGreaterThan(0);
      expect(
        getDataset(e.key)!.rows(a.profileId).length,
        e.key
      ).toBeGreaterThan(0);
      expect(
        getDataset(e.key)!.rows(b.profileId).length,
        e.key
      ).toBeGreaterThan(0);
    }
    // …and this list is asserted EXACT too, on the property that ADMITS an entry —
    // a seeded dataset the id comparison cannot judge, which is one whose rows carry
    // no `id`, or whose table belongs to the instance rather than to a profile (not
    // owned and not an owned table's FK child). Seeded + a reason was true of every
    // dataset, so a line added here used to delete that dataset's case in silence.
    // The property is read off the row shape and the schema, never off the ids
    // themselves, so a leak cannot make its own exemption true.
    const profileScoped = new Set([
      ...OWNED_TABLES,
      ...ownedChildTables(db).keys(),
    ]);
    const exemptable = DATASETS.filter(
      (ds) =>
        ds.rows(a.profileId).length > 0 &&
        ds.rows(b.profileId).length > 0 &&
        (!("id" in ds.rows(a.profileId)[0]) || !profileScoped.has(ds.table))
    ).map((ds) => ds.key);
    expect(
      exemptable.sort(),
      `\nDatasets an id comparison cannot judge. SCOPING_ID_EXEMPT must name exactly these — every other seeded dataset gets a case:\n${exemptable.join("\n")}\n`
    ).toEqual(SCOPING_ID_EXEMPT.map((e) => e.key).sort());
    expect(checked.length).toBeGreaterThan(0);
  });
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
});
