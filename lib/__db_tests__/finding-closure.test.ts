// DB INTEGRATION TIER (not the pure suite in lib/__tests__).
//
// Issue #1305 — the findings-closure loop. withFindingClosure snapshots the declared
// builders' ACTIVE findings, runs the write, re-runs the builders, and reports what the
// write CLEARED — the DB re-run half the pure differ can't see. One fixture per satisfier
// (same standing as the #448 builder fixtures): seed a state where the finding fires,
// drive the write, assert the cleared list names it — and that a suppressed finding is NOT
// announced (active-set awareness).
//
// Runs via `npm run test:db` (vitest.db.config.ts); the `db` singleton is a throwaway temp
// DB per file (lib/__db_tests__/setup.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { withFindingClosure } from "@/lib/finding-closure";
import { closureFindingSnapshot } from "@/lib/rule-findings";
import {
  fitnessCheckSignalKey,
  FITNESS_CHECK_PREFIX,
} from "@/lib/fitness-retest";
import { DATA_QUALITY_PREFIX, dataQualityDedupeKey } from "@/lib/data-quality";
import { saveFitnessEntry } from "@/lib/fitness-assessment";
import { setUserBirthdate } from "@/lib/settings";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

function seedCheck(profileId: number, date: string) {
  db.prepare(
    "INSERT INTO fitness_assessments (profile_id, date) VALUES (?, ?)"
  ).run(profileId, date);
}

describe("withFindingClosure — fitness retest satisfier (#1305)", () => {
  it("clears the overdue fitness-check finding when a new test is recorded", () => {
    const { profileId, anchor } = makeProfile("closure-fitness-due");
    const last = shiftDateStr(anchor, -120); // > 90-day default → retest due
    seedCheck(profileId, last);

    const { cleared } = withFindingClosure(
      profileId,
      [FITNESS_CHECK_PREFIX],
      (pid, todayISO) =>
        closureFindingSnapshot(pid, [FITNESS_CHECK_PREFIX], todayISO),
      () =>
        saveFitnessEntry(profileId, {
          date: anchor,
          testKey: "grip",
          value: 45,
        })
    );
    expect(cleared.map((f) => f.dedupeKey)).toEqual([
      fitnessCheckSignalKey(last),
    ]);
  });

  it("clears nothing when the check was not overdue (no active finding)", () => {
    const { profileId, anchor } = makeProfile("closure-fitness-recent");
    seedCheck(profileId, shiftDateStr(anchor, -30)); // inside the cadence window
    const { cleared } = withFindingClosure(
      profileId,
      [FITNESS_CHECK_PREFIX],
      (pid, todayISO) =>
        closureFindingSnapshot(pid, [FITNESS_CHECK_PREFIX], todayISO),
      () =>
        saveFitnessEntry(profileId, {
          date: anchor,
          testKey: "grip",
          value: 45,
        })
    );
    expect(cleared).toEqual([]);
  });

  it("does NOT announce a finding that was already dismissed (active-set awareness)", () => {
    const { profileId, anchor } = makeProfile("closure-fitness-dismissed");
    const last = shiftDateStr(anchor, -120);
    seedCheck(profileId, last);
    // Dismiss the retest finding first — it's no longer VISIBLE, so satisfying it must
    // not toast (satisfaction ≠ dismissal; diff the ACTIVE set).
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
       VALUES (?, ?, ?)`
    ).run(profileId, fitnessCheckSignalKey(last), `${anchor}T00:00:00Z`);

    const { cleared } = withFindingClosure(
      profileId,
      [FITNESS_CHECK_PREFIX],
      (pid, todayISO) =>
        closureFindingSnapshot(pid, [FITNESS_CHECK_PREFIX], todayISO),
      () =>
        saveFitnessEntry(profileId, {
          date: anchor,
          testKey: "grip",
          value: 45,
        })
    );
    expect(cleared).toEqual([]);
  });
});

describe("withFindingClosure — data-quality satisfier (#1305)", () => {
  it("clears the missing-birthdate gap when a birthdate is set (leaving other gaps)", () => {
    const { profileId } = makeProfile("closure-dq-birthdate");
    // A fresh profile with no birthdate/sex fires both structural gaps.
    const { cleared } = withFindingClosure(
      profileId,
      [DATA_QUALITY_PREFIX],
      (pid, todayISO) =>
        closureFindingSnapshot(pid, [DATA_QUALITY_PREFIX], todayISO),
      () => setUserBirthdate(profileId, "1990-01-01")
    );
    const keys = cleared.map((f) => f.dedupeKey);
    expect(keys).toContain(dataQualityDedupeKey("birthdate"));
    // The sex gap is untouched by a birthdate write — it stays active, not "cleared".
    expect(keys).not.toContain(dataQualityDedupeKey("sex"));
  });
});
