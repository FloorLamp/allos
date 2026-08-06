// DB INTEGRATION TIER — cycle-row delete → undo round-trip (#2127).
//
// A recorded period is the single-row undo shape substance-history already
// registers, and the row FEEDS derived state: cycle-length history, regularity,
// and the next-period forecast all recompute off it. This proves the delete goes
// through the capture (one transaction, one undo token), that the restore brings
// back the SAME row shape (new id, everything else byte-equal), and that the
// forecast recomputes to its pre-delete answer — the consequence the issue names.

import { describe, it, expect, beforeEach } from "vitest";
import { db, writeTx } from "@/lib/db";
import { restoreDeletedRow } from "@/lib/undo-delete-db";
import {
  createCycleRow,
  deleteCycleRow,
  getCycleForecast,
  listCyclePeriods,
} from "@/lib/cycle-store";

let profileId: number;

beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Cycle Undo')").run()
      .lastInsertRowid
  );
});

const holdingCount = () =>
  (
    db
      .prepare(
        "SELECT COUNT(*) c FROM deleted_rows WHERE profile_id = ? AND kind = 'cycle'"
      )
      .get(profileId) as { c: number }
  ).c;

function seedHistory(): number {
  // Four completed, regular 28-day periods → three cycle gaps, the forecast's
  // sufficiency floor (FORECAST_MIN_CYCLES = 3); absolute dates are fine here
  // (the forecast is pure over the rows + `today`).
  createCycleRow(profileId, "2026-04-03", "2026-04-07", "medium", null);
  createCycleRow(profileId, "2026-05-01", "2026-05-05", "medium", null);
  createCycleRow(profileId, "2026-05-29", "2026-06-02", "medium", null);
  return createCycleRow(
    profileId,
    "2026-06-26",
    "2026-06-30",
    "light",
    "  keep this note  ".trim()
  );
}

describe("deleteCycleRow → undo (#2127)", () => {
  it("captures the row, and undo restores the same row shape (new id)", () => {
    const id = seedHistory();
    const before = db
      .prepare("SELECT * FROM cycles WHERE id = ? AND profile_id = ?")
      .get(id, profileId) as Record<string, unknown>;

    const outcome = deleteCycleRow(profileId, id);
    expect(outcome.kind).toBe("deleted");
    if (outcome.kind !== "deleted") return;
    expect(listCyclePeriods(profileId).map((p) => p.id)).not.toContain(id);
    expect(holdingCount()).toBe(1);

    expect(restoreDeletedRow(profileId, outcome.undoId)).toBe(true);
    const restored = db
      .prepare(
        "SELECT * FROM cycles WHERE profile_id = ? AND period_start = '2026-06-26'"
      )
      .get(profileId) as Record<string, unknown>;
    expect(restored).toBeDefined();
    // Same row shape: every column except the (new) autoincrement id.
    const strip = ({ id: _id, ...rest }: Record<string, unknown>) => rest;
    expect(strip(restored)).toEqual(strip(before));
    expect(restored.id).not.toBe(before.id);
    // The holding row is consumed — the token is single-use.
    expect(holdingCount()).toBe(0);
  });

  it("the forecast recomputes to its pre-delete state after undo", () => {
    const id = seedHistory();
    const today = "2026-07-10";
    const before = getCycleForecast(profileId, today);
    expect(before.kind).toBe("forecast");

    const outcome = deleteCycleRow(profileId, id);
    expect(outcome.kind).toBe("deleted");
    if (outcome.kind !== "deleted") return;
    // With the newest period gone the projection moves — the deletion really did
    // change every prediction, which is why it must be reversible.
    expect(getCycleForecast(profileId, today)).not.toEqual(before);

    expect(restoreDeletedRow(profileId, outcome.undoId)).toBe(true);
    expect(getCycleForecast(profileId, today)).toEqual(before);
  });

  it("a forged or foreign id reports not-found and captures nothing", () => {
    const id = seedHistory();
    expect(deleteCycleRow(profileId, 999999)).toEqual({ kind: "not-found" });

    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Cycle Other')").run()
        .lastInsertRowid
    );
    // Another profile's id: profile-scoped, nothing deleted, nothing captured.
    expect(deleteCycleRow(other, id)).toEqual({ kind: "not-found" });
    expect(listCyclePeriods(profileId).map((p) => p.id)).toContain(id);
    expect(holdingCount()).toBe(0);
  });

  it("the write stays inside one transaction with the capture", () => {
    // A delete issued inside an outer writeTx nests as a SAVEPOINT (#468) — this
    // simply proves the core is callable under the app's transaction discipline
    // and the capture + delete commit together.
    const id = seedHistory();
    const outcome = writeTx(() => deleteCycleRow(profileId, id));
    expect(outcome.kind).toBe("deleted");
    expect(holdingCount()).toBe(1);
  });
});
