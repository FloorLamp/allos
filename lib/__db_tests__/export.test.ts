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
import { db } from "@/lib/db";
import { seedProfile, type SeededProfile } from "./fixtures";

let a: SeededProfile;
let b: SeededProfile;

beforeAll(() => {
  a = seedProfile("EXPA");
  b = seedProfile("EXPB");
  // The shared fixture doesn't seed the clinical / heart-rate datasets, so add a
  // tagged row per profile to prove the new dataset queries are profile-scoped.
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
      `INSERT INTO encounters (profile_id, date, type) VALUES (?, '2024-01-02', ?)`
    ).run(p.profileId, `${p.tag} Office Visit`);
    db.prepare(
      `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
       VALUES (?, '2024-01-02T08:00', ?, 3, 'health-connect')`
    ).run(p.profileId, bpm);
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
// same shape, incl. the folded activities/supplements JS), stay profile-scoped, and
// that count() equals the true row total — the contract DataExport relies on.
describe("bounded count()/page() readers (issue #113)", () => {
  it("count() equals the full row total, per profile, incl. JOIN datasets", () => {
    for (const key of [
      "medical_records",
      "activities",
      "supplements",
      "intake_log",
      "hr_minutes",
      "allergies",
    ]) {
      expect(countFor(key, a.profileId)).toBe(rowsFor(key, a.profileId).length);
      expect(countFor(key, b.profileId)).toBe(rowsFor(key, b.profileId).length);
    }
  });

  it("page() returns the same window (order + shape) as slicing rows()", () => {
    for (const key of ["medical_records", "activities", "supplements"]) {
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

  it("the supplements page folds the dose schedule like the full export", () => {
    const page = pageFor("supplements", a.profileId, 50, 0);
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
    // profile's items here. The merged `supplements` dataset is one row per item
    // with its dose schedule folded into a `schedule` summary.
    const items = rowsFor("supplements", a.profileId);
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
    expect(getDataset("supplements")!.deletable).not.toBe(false);
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
      (d) => d.deletable !== false && !DELETE_POLICY[d.key]
    ).map((d) => d.key);
    expect(missing).toEqual([]);
  });

  it("no browse-only (deletable:false) dataset has a DELETE_POLICY entry", () => {
    const stray = DATASETS.filter(
      (d) => d.deletable === false && DELETE_POLICY[d.key]
    ).map((d) => d.key);
    expect(stray).toEqual([]);
  });

  it("immunizations is deletable and now covered by DELETE_POLICY", () => {
    expect(getDataset("immunizations")!.deletable).not.toBe(false);
    expect(DELETE_POLICY.immunizations).toBeDefined();
  });
});
