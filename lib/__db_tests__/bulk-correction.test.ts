// DB TIER — bulk corrections (issue #1603): the apply/undo round-trip against a
// real schema. Proves apply is one compare-and-set write that sets the #133 edit
// lock only where it should (source-owned, not-already-locked rows), snapshots
// the inverse into deleted_rows, refuses on drift; and that undo restores
// `before` only where the current value still equals `after` (rows edited since
// are skipped, never clobbered) and clears `edited` only where THIS correction
// set it. Also covers the metric_samples and activities stores and profile
// scoping (a foreign profile's rows never enter a run).

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { correctionSignature, planCorrection } from "@/lib/bulk-correction";
import {
  applyBulkCorrection,
  listCorrectionSources,
  readCorrectionRows,
  undoBulkCorrection,
  type CorrectionFilter,
} from "@/lib/bulk-correction-db";

const RANGE: CorrectionFilter = {
  from: "2026-03-01",
  to: "2026-03-31",
  source: "withings",
};

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addWeight(
  profileId: number,
  date: string,
  kg: number,
  source: string | null,
  edited = 0
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg, source, edited)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(profileId, date, kg, source, edited).lastInsertRowid
  );
}

function weightRow(id: number): { weight_kg: number; edited: number } {
  return db
    .prepare("SELECT weight_kg, edited FROM body_metrics WHERE id = ?")
    .get(id) as { weight_kg: number; edited: number };
}

// Preview-then-apply exactly as the action does: read, plan, sign, apply.
function applyRun(
  profileId: number,
  filter: CorrectionFilter,
  op: Parameters<typeof planCorrection>[2]
) {
  const rows = readCorrectionRows(profileId, "weight", filter);
  const plan = planCorrection("weight", rows, op);
  if (!plan.ok) throw new Error("fixture plan out of range");
  return applyBulkCorrection(
    profileId,
    "weight",
    filter,
    op,
    correctionSignature(plan.changes)
  );
}

describe("applyBulkCorrection", () => {
  it("applies the plan, locks source-owned rows, and snapshots the inverse", () => {
    const pid = newProfile("bulkfix apply");
    const a = addWeight(pid, "2026-03-01", 176.4, "withings");
    const b = addWeight(pid, "2026-03-02", 170.2, "withings");
    // Already hand-corrected once — its lock is NOT ours, so undo must keep it.
    const c = addWeight(pid, "2026-03-03", 168, "withings", 1);
    // Outside the source filter: a manual row in the same date range.
    const manual = addWeight(pid, "2026-03-02", 80, null);
    // Outside the date range.
    const later = addWeight(pid, "2026-04-05", 172, "withings");

    const op = { kind: "multiply", factor: 0.5 } as const;
    const res = applyRun(pid, RANGE, op);
    expect(res).toMatchObject({ ok: true, applied: 3, locked: 2 });
    if (!res.ok) throw new Error("unreachable");

    expect(weightRow(a)).toEqual({ weight_kg: 88.2, edited: 1 });
    expect(weightRow(b)).toEqual({ weight_kg: 85.1, edited: 1 });
    expect(weightRow(c)).toEqual({ weight_kg: 84, edited: 1 });
    // The manual row and the out-of-range row are untouched.
    expect(weightRow(manual)).toEqual({ weight_kg: 80, edited: 0 });
    expect(weightRow(later)).toEqual({ weight_kg: 172, edited: 0 });

    // The inverse snapshot: kind, non-PHI label, per-row lockSet honesty.
    const held = db
      .prepare(
        `SELECT kind, label, payload FROM deleted_rows WHERE id = ? AND profile_id = ?`
      )
      .get(res.undoId, pid) as { kind: string; label: string; payload: string };
    expect(held.kind).toBe("bulk-correction");
    expect(held.label).toBe("body_metrics · weight_kg · 3 rows");
    const payload = JSON.parse(held.payload);
    expect(payload.changes).toEqual([
      { id: a, before: 176.4, after: 88.2, lockSet: true },
      { id: b, before: 170.2, after: 85.1, lockSet: true },
      { id: c, before: 168, after: 84, lockSet: false },
    ]);
  });

  it("locks manual rows never, but corrects them (no source to re-push from)", () => {
    const pid = newProfile("bulkfix manual");
    const id = addWeight(pid, "2026-03-05", 90, null);
    const res = applyRun(pid, { ...RANGE, source: null }, {
      kind: "add",
      amount: -2,
    });
    expect(res).toMatchObject({ ok: true, applied: 1, locked: 0 });
    expect(weightRow(id)).toEqual({ weight_kg: 88, edited: 0 });
  });

  it("refuses with a typed drift outcome when a row changed after preview (CAS)", () => {
    const pid = newProfile("bulkfix drift");
    const a = addWeight(pid, "2026-03-01", 176.4, "withings");
    addWeight(pid, "2026-03-02", 170.2, "withings");

    const op = { kind: "multiply", factor: 0.5 } as const;
    const rows = readCorrectionRows(pid, "weight", RANGE);
    const plan = planCorrection("weight", rows, op);
    if (!plan.ok) throw new Error("unreachable");
    const staleSignature = correctionSignature(plan.changes);

    // A sync lands mid-preview: one value moves.
    db.prepare("UPDATE body_metrics SET weight_kg = 177.0 WHERE id = ?").run(a);

    const res = applyBulkCorrection(pid, "weight", RANGE, op, staleSignature);
    expect(res).toEqual({ ok: false, error: "drift" });
    // Nothing was applied.
    expect(weightRow(a).weight_kg).toBe(177);
  });

  it("refuses an empty run and an out-of-range transform", () => {
    const pid = newProfile("bulkfix empty");
    expect(
      applyBulkCorrection(
        pid,
        "weight",
        RANGE,
        { kind: "add", amount: 1 },
        "anything"
      )
    ).toEqual({ ok: false, error: "empty" });

    addWeight(pid, "2026-03-01", 3, "withings");
    expect(
      applyBulkCorrection(
        pid,
        "weight",
        RANGE,
        { kind: "add", amount: -5 },
        "anything"
      )
    ).toEqual({ ok: false, error: "out-of-range" });
  });

  it("never reaches across profiles (scoping)", () => {
    const pid = newProfile("bulkfix mine");
    const otherPid = newProfile("bulkfix other");
    addWeight(pid, "2026-03-01", 176.4, "withings");
    const foreign = addWeight(otherPid, "2026-03-02", 170, "withings");

    const res = applyRun(pid, RANGE, { kind: "multiply", factor: 0.5 });
    expect(res).toMatchObject({ ok: true, applied: 1 });
    expect(weightRow(foreign)).toEqual({ weight_kg: 170, edited: 0 });

    // And a foreign undo token is not-found for this profile.
    if (!res.ok) throw new Error("unreachable");
    expect(undoBulkCorrection(otherPid, res.undoId)).toEqual({
      ok: false,
      error: "not-found",
    });
  });
});

describe("undoBulkCorrection", () => {
  it("restores before-values, clears only the locks it set, skips drifted rows", () => {
    const pid = newProfile("bulkfix undo");
    const a = addWeight(pid, "2026-03-01", 176.4, "withings");
    const b = addWeight(pid, "2026-03-02", 170.2, "withings");
    const c = addWeight(pid, "2026-03-03", 168, "withings", 1); // pre-locked

    const res = applyRun(pid, RANGE, { kind: "multiply", factor: 0.5 });
    if (!res.ok) throw new Error("unreachable");

    // Row b is hand-edited AFTER the correction — undo must leave it alone.
    db.prepare(
      "UPDATE body_metrics SET weight_kg = 84.9, edited = 1 WHERE id = ?"
    ).run(b);

    const undo = undoBulkCorrection(pid, res.undoId);
    expect(undo).toEqual({ ok: true, restored: 2, skipped: 1 });

    // a: value back, OUR lock cleared. b: the later edit stands, lock stands.
    // c: value back, but its PRE-EXISTING lock is kept (lockSet was false).
    expect(weightRow(a)).toEqual({ weight_kg: 176.4, edited: 0 });
    expect(weightRow(b)).toEqual({ weight_kg: 84.9, edited: 1 });
    expect(weightRow(c)).toEqual({ weight_kg: 168, edited: 1 });

    // The holding row is consumed — a second undo finds nothing.
    expect(undoBulkCorrection(pid, res.undoId)).toEqual({
      ok: false,
      error: "not-found",
    });
  });

  it("refuses a deleted_rows token of another kind", () => {
    const pid = newProfile("bulkfix wrong kind");
    const undoId = Number(
      db
        .prepare(
          `INSERT INTO deleted_rows (profile_id, kind, label, payload)
           VALUES (?, 'activity', 'activity', '{}')`
        )
        .run(pid).lastInsertRowid
    );
    expect(undoBulkCorrection(pid, undoId)).toEqual({
      ok: false,
      error: "not-found",
    });
  });
});

describe("metric_samples and activities stores", () => {
  it("round-trips an HRV correction with the unconditional sample lock", () => {
    const pid = newProfile("bulkfix hrv");
    const id = Number(
      db
        .prepare(
          `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
           VALUES (?, 'oura', 'hrv_ms', '2026-03-02', '2026-03-01T23:00:00Z', '2026-03-02T07:00:00Z', 48)`
        )
        .run(pid).lastInsertRowid
    );
    // A different metric on the same source/date must never enter the run.
    const otherMetric = Number(
      db
        .prepare(
          `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
           VALUES (?, 'oura', 'steps', '2026-03-02', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z', 9000)`
        )
        .run(pid).lastInsertRowid
    );

    const filter: CorrectionFilter = { ...RANGE, source: "oura" };
    const rows = readCorrectionRows(pid, "hrv", filter);
    expect(rows.map((r) => r.id)).toEqual([id]);
    const op = { kind: "add", amount: 5 } as const;
    const plan = planCorrection("hrv", rows, op);
    if (!plan.ok) throw new Error("unreachable");
    const res = applyBulkCorrection(
      pid,
      "hrv",
      filter,
      op,
      correctionSignature(plan.changes)
    );
    expect(res).toMatchObject({ ok: true, applied: 1, locked: 1 });
    if (!res.ok) throw new Error("unreachable");

    const sample = () =>
      db
        .prepare("SELECT value, edited FROM metric_samples WHERE id = ?")
        .get(id) as { value: number; edited: number };
    expect(sample()).toEqual({ value: 53, edited: 1 });
    expect(
      (
        db
          .prepare("SELECT value FROM metric_samples WHERE id = ?")
          .get(otherMetric) as { value: number }
      ).value
    ).toBe(9000);

    expect(undoBulkCorrection(pid, res.undoId)).toEqual({
      ok: true,
      restored: 1,
      skipped: 0,
    });
    expect(sample()).toEqual({ value: 48, edited: 0 });
  });

  it("corrects activity distances (the mi-as-km import) and undoes them", () => {
    const pid = newProfile("bulkfix distance");
    const id = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, distance_km, source)
           VALUES (?, '2026-03-10', 'cardio', 'Morning run', 5, 'strava')`
        )
        .run(pid).lastInsertRowid
    );
    const filter: CorrectionFilter = { ...RANGE, source: "strava" };
    const op = { kind: "multiply", factor: 1.609344 } as const;
    const rows = readCorrectionRows(pid, "distance", filter);
    const plan = planCorrection("distance", rows, op);
    if (!plan.ok) throw new Error("unreachable");
    const res = applyBulkCorrection(
      pid,
      "distance",
      filter,
      op,
      correctionSignature(plan.changes)
    );
    expect(res).toMatchObject({ ok: true, applied: 1, locked: 1 });
    if (!res.ok) throw new Error("unreachable");

    const row = () =>
      db
        .prepare("SELECT distance_km, edited FROM activities WHERE id = ?")
        .get(id) as { distance_km: number; edited: number };
    expect(row()).toEqual({ distance_km: 8.04672, edited: 1 });

    expect(undoBulkCorrection(pid, res.undoId)).toEqual({
      ok: true,
      restored: 1,
      skipped: 0,
    });
    expect(row()).toEqual({ distance_km: 5, edited: 0 });
  });
});

describe("listCorrectionSources", () => {
  it("groups per field by source with the run's span", () => {
    const pid = newProfile("bulkfix sources");
    addWeight(pid, "2026-03-01", 80, "withings");
    addWeight(pid, "2026-03-09", 81, "withings");
    addWeight(pid, "2026-03-05", 82, null);

    const sources = listCorrectionSources(pid);
    expect(sources.weight).toEqual([
      {
        source: "withings",
        count: 2,
        minDate: "2026-03-01",
        maxDate: "2026-03-09",
      },
      { source: null, count: 1, minDate: "2026-03-05", maxDate: "2026-03-05" },
    ]);
    expect(sources.hrv).toEqual([]);
  });
});
