// SERVER-ACTION TIER — clearEditLock (issue #659).
//
// The "resume sync updates" affordance clears the user-edit lock (`edited = 0`) on a
// hand-edited imported row so the next sync resumes updating it. Proves the action is
// profile-scoped (a foreign profile's row is untouched), whitelists the table (an
// unknown type is rejected), and that a cleared row is once again writable by the
// keyed upsert — the round-trip the badge promises.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { clearEditLock } from "@/app/(app)/data/review-actions";
import { upsertBodyMetrics } from "@/lib/integrations/normalize";
import { seedActor, createProfile, fd } from "./harness";

const SRC = "withings";
const DATE = "2026-05-05";

function addLockedBodyMetric(profileId: number, weight: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg, source, edited)
         VALUES (?, ?, ?, ?, 1)`
      )
      .run(profileId, DATE, weight, SRC).lastInsertRowid
  );
}

function readRow(id: number): { weight_kg: number; edited: number | null } {
  return db
    .prepare("SELECT weight_kg, edited FROM body_metrics WHERE id = ?")
    .get(id) as { weight_kg: number; edited: number | null };
}

describe("clearEditLock", () => {
  it("clears the lock and the next sync resumes updating the row", async () => {
    const { profile } = seedActor();
    const id = addLockedBodyMetric(profile.id, 79);

    // While locked, a re-sync with a fresh value is held out (counted `edited`).
    const before = upsertBodyMetrics(
      profile.id,
      [{ date: DATE, weight_kg: 80 }],
      SRC
    );
    expect(before).toMatchObject({ edited: 1, updated: 0 });
    expect(readRow(id).weight_kg).toBe(79);

    const res = await clearEditLock(fd({ table: "body_metrics", id }));
    expect(res).toEqual({ ok: true });
    expect(readRow(id).edited).toBe(0);

    // Now the same push updates the row (the provider's value wins).
    const after = upsertBodyMetrics(
      profile.id,
      [{ date: DATE, weight_kg: 80 }],
      SRC
    );
    expect(after).toMatchObject({ updated: 1, edited: 0 });
    expect(readRow(id).weight_kg).toBe(80);
  });

  it("does not touch a row owned by another profile (scoping)", async () => {
    const { login, profile } = seedActor();
    const other = createProfile("Other", login.id);
    const foreignId = addLockedBodyMetric(other.id, 70);

    // Acting as `profile`, try to clear the OTHER profile's lock.
    const res = await clearEditLock(
      fd({ table: "body_metrics", id: foreignId })
    );
    expect(res).toEqual({ ok: false, error: "Record not found." });
    expect(readRow(foreignId).edited).toBe(1); // untouched
  });

  it("rejects an unknown table (whitelist)", async () => {
    seedActor();
    const res = await clearEditLock(fd({ table: "sessions", id: 1 }));
    expect(res).toEqual({ ok: false, error: "Unknown record type." });
  });
});
