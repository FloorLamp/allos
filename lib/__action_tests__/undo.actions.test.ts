// SERVER-ACTION TIER — the batch undo loop isolates a poisoned token (#202).
//
// undoDeletes restores a whole batch of undo tokens. A single token whose restore
// THROWS must not abort the loop and leave the batch partially restored — each token
// is wrapped so a failure is skipped and the rest still restore. This drives the real
// undoDeletes against the throwaway temp DB with the auth boundary mocked (setup.ts).

import { describe, it, expect, vi } from "vitest";
import { undoDeletes } from "@/app/(app)/undo/actions";
import { captureDelete } from "@/lib/undo-delete-db";
import { db } from "@/lib/db";
import { createLogin, createProfile, actAs } from "./harness";

// A valid body-metric delete token for the given profile (restores cleanly).
function captureBodyMetric(profileId: number, date: string): number {
  const id = Number(
    db
      .prepare(
        "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 80)"
      )
      .run(profileId, date).lastInsertRowid
  );
  return captureDelete("body-metric", profileId, id)!;
}

// A holding row whose restore is GUARANTEED to throw: a captured 'activity' whose
// `type` violates the table CHECK, so the re-insert raises a constraint error out of
// restoreDeletedRow — the "poisoned token".
function poisonToken(profileId: number): number {
  const payload = JSON.stringify({
    v: 1,
    kind: "activity",
    rows: {
      activity: [
        {
          id: 1,
          profile_id: profileId,
          date: "2020-01-01",
          type: "not-a-valid-type", // violates CHECK (type IN ('strength','cardio','sport'))
          title: "POISON",
        },
      ],
      sets: [],
    },
  });
  return Number(
    db
      .prepare(
        "INSERT INTO deleted_rows (profile_id, kind, label, payload) VALUES (?, 'activity', 'activity', ?)"
      )
      .run(profileId, payload).lastInsertRowid
  );
}

describe("undoDeletes (batch)", () => {
  it("restores the healthy tokens even when one in the batch throws", async () => {
    const admin = createLogin({ role: "admin" });
    const p = createProfile("BATCH-UNDO");
    actAs(admin, p);

    const t1 = captureBodyMetric(p.id, "2020-03-01");
    const poison = poisonToken(p.id);
    const t3 = captureBodyMetric(p.id, "2020-03-02");

    // Silence the expected per-token error log for the poisoned token.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await undoDeletes([t1, poison, t3]);
    errSpy.mockRestore();

    // Two of the three restored; the poisoned one was isolated (not aborting the loop).
    expect(res.restored).toBe(2);

    // Both healthy body metrics are back under the profile.
    const restored = db
      .prepare(
        "SELECT COUNT(*) c FROM body_metrics WHERE profile_id = ? AND date IN ('2020-03-01','2020-03-02')"
      )
      .get(p.id) as { c: number };
    expect(restored.c).toBe(2);

    // Their holding rows are consumed; the poisoned holding row survives (its
    // transaction rolled back, so it can be inspected / retried, never silently lost).
    expect(
      (
        db
          .prepare("SELECT COUNT(*) c FROM deleted_rows WHERE id IN (?, ?)")
          .get(t1, t3) as { c: number }
      ).c
    ).toBe(0);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) c FROM deleted_rows WHERE id = ?")
          .get(poison) as { c: number }
      ).c
    ).toBe(1);
  });
});
