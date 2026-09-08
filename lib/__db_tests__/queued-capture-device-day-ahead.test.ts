// DB INTEGRATION TIER — a queued capture whose date is one day AHEAD of the profile's
// today (#4425 review finding).
//
// WHY THIS DATE IS REACHABLE, which is the whole point. It used to be reachable through
// the QUEUE: the dose capture stamped its day off the browser's zone while every core
// resolves the day through `today(profileId)`, the profile's zone, so a device east of
// that zone captured tomorrow. #4559 closed that route at the capture — the day is read
// in the profile's zone now, and the browser-zone helper is gone from the tree.
//
// The date is still reachable, because it never depended on that route: a queued intent
// is a wire value a device holds and can be replayed on any later day, and the dated
// forms post a day the person typed. The bound below is what makes either safe, so it
// stays exactly where #4425 put it.
//
// #4425 gave three replayed cores the shared not-future invariant, and only two of the
// three could report it. `upsertMoodLog` and `logBristolStool` answer the replay's own
// `if (!ok)` dead-letter. `insertVitals` did not: it IGNORES `recordReading`'s outcome
// in both of its loops, so the refusal had no channel — the sitting reported success
// and wrote nothing. The queue's contract (lib/offline/queue.ts) is that a refusal
// "dead-letters with its reason instead of vanishing"; that one vanished, and the fix
// is to judge the day at `insertVitals`' own door where the channel already exists.

import { afterEach, describe, it, expect, vi } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { TIER_FROZEN_INSTANT } from "./frozen-clock";
import { shiftDateStr, utcInstant } from "@/lib/date";
import {
  alreadyReplayed,
  applyIntent,
  insertVitals,
} from "@/lib/offline/writes";
import { buildIntent } from "@/lib/__tests__/queued-intent-fixture";
import type { FlowKind, IntentPayload } from "@/lib/offline/queue";
import { dayContextKey } from "@/lib/day-context-key";
import { DATED_REACH, TAP_REACH } from "@/lib/log-manifest";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function readingCount(profileId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ?")
      .get(profileId) as { n: number }
  ).n;
}

const mood = (valence: number) => ({
  valence,
  energy: null,
  anxiety: null,
  factors: [],
  note: null,
});

const VITALS_PAYLOAD = {
  systolic: "118",
  diastolic: "76",
  glucose: null,
  glucoseUnit: null,
  spo2: null,
  temperature: null,
  tempUnit: null,
  sleepHours: null,
  hrv: null,
  respiratoryRate: null,
  gripStrength: null,
  chairStand: null,
  balance: null,
  peakFlow: null,
};

describe("a capture dated ahead of the profile's day (#4425 review)", () => {
  // ALL THREE REPLAYED CORES THIS ISSUE GATED, in one table, because the failure is
  // per-core and the contract is shared: whatever a core refuses, the replay must
  // REPORT. `rejected` is the report — the reconnect channel says so and the entry is
  // kept for the person to re-enter. `done` over an empty table is the silent loss.
  // The row counted is the one that flow writes.
  it.each<[FlowKind, IntentPayload, (p: number) => number]>([
    [
      "mood",
      mood(4),
      (p) =>
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM mood_logs WHERE profile_id = ?")
            .get(p) as { n: number }
        ).n,
    ],
    [
      "stool",
      { type: 4, at: null },
      (p) =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ?"
            )
            .get(p) as { n: number }
        ).n,
    ],
    ["vitals", VITALS_PAYLOAD, readingCount],
  ])(
    "dead-letters a queued %s capture instead of losing it",
    (flow, payload, count) => {
      const p = newProfile(`device-ahead-${flow}`);
      const ahead = shiftDateStr(today(p), 1);

      const result = applyIntent(
        p,
        buildIntent(flow, ahead, payload, p, false)
      );

      expect(result.status).toBe("rejected");
      expect(count(p)).toBe(0);
    }
  );

  // The sitting is the one whose refusal had no channel, so it is also asserted at the
  // core's own door: `wrote: true` over an empty table is the exact shape the loops'
  // discarded outcomes produced.
  it("refuses a sitting at the door rather than reporting a success it did not write", () => {
    const p = newProfile("device-ahead-direct");
    const outcome = insertVitals(
      p,
      shiftDateStr(today(p), 1),
      { systolic: "120", diastolic: "80" },
      "page"
    );

    expect(outcome).toEqual({ wrote: false });
    expect(readingCount(p)).toBe(0);
  });

  // The converse, so the guard cannot pass by refusing everything: the same sitting on
  // the profile's own day still lands.
  it("still writes the same sitting on the profile's own day", () => {
    const p = newProfile("device-same-day");
    const outcome = insertVitals(
      p,
      today(p),
      { systolic: "120", diastolic: "80" },
      "page"
    );
    expect(outcome).toMatchObject({ wrote: true });
    expect(readingCount(p)).toBeGreaterThan(0);
  });
});

// THE ANCHOR IS THE CAPTURE, AND REPLAY MUST NOT MOVE IT (#4559). Reading the day in
// the profile's zone is only faithful if it is read AT THE TAP; a replay that re-derived
// it would land a Tuesday-night check-in on Wednesday for no reason but a slow
// reconnect, and the queue's own contract is that a late replay lands on the day the
// user logged it however long the queue sat.
//
// This is what a replay-side redesign would break, so it is pinned here rather than
// left as prose: the queue sits across the profile's midnight, and the day does not
// move. The double replay is the second half of the same property — `UNIQUE(profile_id,
// date)` upserts and the practice flow's day-idempotence all key on the replayed date,
// and an idempotence that holds only on the first replay is not idempotence.
describe("a capture replayed after the profile's day has moved (#4559)", () => {
  const CAPTURE = new Date("2026-08-29T23:50:00.000Z");
  // Twenty minutes later, and a different day in UTC — the profile's own midnight, not
  // the host's.
  const REPLAY = new Date("2026-08-30T00:10:00.000Z");

  afterEach(() => vi.setSystemTime(TIER_FROZEN_INSTANT));

  it("lands on the captured day, and lands there again on a second flush", () => {
    const p = newProfile("capture-anchor");
    setTimezone(p, "UTC");

    vi.setSystemTime(CAPTURE);
    const captureDay = today(p);
    const intent = buildIntent("mood", captureDay, mood(4), p, true, CAPTURE);

    vi.setSystemTime(REPLAY);
    // The fixture reaches the state the assertion is about: the profile's today has
    // genuinely moved past the captured day before either replay runs.
    expect(today(p)).not.toBe(captureDay);

    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    expect(applyIntent(p, intent)).toEqual({ status: "duplicate" });

    expect(
      db
        .prepare("SELECT date FROM mood_logs WHERE profile_id = ?")
        .all(p)
        .map((row) => (row as { date: string }).date)
    ).toEqual([captureDay]);
  });

  // BOTH SPELLINGS DRAIN THROUGH ONE QUEUE. The fix is at the CAPTURE, so a device
  // that has not reloaded still holds intents a pre-fix build stamped in the BROWSER's
  // zone — a day ahead of the profile's, whenever the device sits east of it. Those
  // replay beside intents the fixed capture stamped, and each entry gets its own
  // transaction, so the stale day has to dead-letter ITSELF and take nothing with it.
  // The pre-fix leg is the deliberate failure here: it is the only one asserted to be
  // refused, and the row below is what proves the refusal cost the other one nothing.
  it("dead-letters a pre-fix capture without costing the fixed one beside it", () => {
    const p = newProfile("mixed-queue");
    const day = today(p);
    const preFix = buildIntent("mood", shiftDateStr(day, 1), mood(2), p, false);
    const fixed = buildIntent("mood", day, mood(5), p, true);

    expect(applyIntent(p, preFix).status).toBe("rejected");
    expect(applyIntent(p, fixed)).toEqual({ status: "done" });

    expect(
      db
        .prepare("SELECT date, valence FROM mood_logs WHERE profile_id = ?")
        .all(p)
    ).toEqual([{ date: day, valence: 5 }]);
  });

  it("keeps a primary stool tap's T1 second after midnight", () => {
    const p = newProfile("stool-primary-instant");
    setTimezone(p, "UTC");
    vi.setSystemTime(CAPTURE);
    const date = today(p);
    const intent = buildIntent(
      "stool",
      date,
      { type: 4, at: null },
      p,
      true,
      CAPTURE
    );

    vi.setSystemTime(REPLAY);
    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    expect(
      db
        .prepare(
          `SELECT date, started_at FROM metric_samples
            WHERE profile_id = ? AND metric = 'bristol_stool'
            ORDER BY id DESC LIMIT 1`
        )
        .get(p)
    ).toEqual({ date, started_at: `${date}T23:50:00` });
  });

  it("requires and preserves a stated stool minute for a nonprimary day", () => {
    const p = newProfile("stool-nonprimary-instant");
    const date = shiftDateStr(today(p), -1);

    for (const at of [null, "", "25:00"]) {
      const intent = buildIntent("stool", date, { type: 4, at }, p, false);
      expect(applyIntent(p, intent)).toEqual({
        status: "rejected",
        reason: "Choose a time for a stool entry on a past day.",
      });
      expect(alreadyReplayed(p, intent.key)).toBe(false);
    }
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM metric_samples
            WHERE profile_id = ? AND metric = 'bristol_stool'`
        )
        .get(p)
    ).toEqual({ n: 0 });
    expect(
      applyIntent(
        p,
        buildIntent("stool", date, { type: 4, at: "08:10" }, p, false)
      )
    ).toEqual({ status: "done" });
    expect(
      db
        .prepare(
          `SELECT date, started_at FROM metric_samples
            WHERE profile_id = ? AND metric = 'bristol_stool'
            ORDER BY id DESC LIMIT 1`
        )
        .get(p)
    ).toEqual({ date, started_at: `${date}T08:10:00` });
  });

  it("keeps a statement-less Food capture on its T1 day and meal slot", () => {
    const p = newProfile("food-primary-slot");
    setTimezone(p, "UTC");
    vi.setSystemTime(CAPTURE);
    const date = today(p);
    const intent = buildIntent(
      "food",
      date,
      {
        entry: "serving",
        groupKey: "berries",
        mealSlot: "dinner",
        grams: null,
        eatenAt: null,
      },
      p,
      true,
      CAPTURE
    );

    vi.setSystemTime(REPLAY);
    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    expect(
      db
        .prepare(
          `SELECT date, recorded_at, meal_slot, occurred_at, time_source
             FROM food_log_events WHERE profile_id = ? AND group_key = 'berries'
             ORDER BY id DESC LIMIT 1`
        )
        .get(p)
    ).toEqual({
      date,
      recorded_at: utcInstant(CAPTURE),
      meal_slot: "dinner",
      occurred_at: null,
      time_source: null,
    });
  });

  it.each([
    ["a DST-gap minute", "America/New_York", "2026-03-08", "02:30"],
    ["a future minute", "UTC", "2026-08-29", "23:59"],
  ])(
    "rejects %s for a nonprimary stool before recording it",
    (_name, tz, date, at) => {
      const p = newProfile(`stool-refused-${_name}`);
      setTimezone(p, tz);
      vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
      const intent = buildIntent("stool", date, { type: 4, at }, p, false);

      expect(applyIntent(p, intent)).toEqual({
        status: "rejected",
        reason: "Choose a time for a stool entry on a past day.",
      });
      expect(alreadyReplayed(p, intent.key)).toBe(false);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM metric_samples
            WHERE profile_id = ? AND metric = 'bristol_stool'`
          )
          .get(p)
      ).toEqual({ n: 0 });
    }
  );
});

describe("queued day-context replay boundary (#5211)", () => {
  it.each([
    [
      "null",
      (intent: ReturnType<typeof buildIntent>) => ({
        ...intent,
        dayContext: null,
      }),
    ],
    [
      "partial",
      (intent: ReturnType<typeof buildIntent>) => ({
        ...intent,
        dayContext: { key: intent.dayContext?.key },
      }),
    ],
    [
      "noncanonical",
      (intent: ReturnType<typeof buildIntent>) => ({
        ...intent,
        dayContext: { ...intent.dayContext!, key: "wrong" },
      }),
    ],
    [
      "missing-profile",
      (intent: ReturnType<typeof buildIntent>) => {
        const { profileId: _profileId, ...rest } = intent;
        return rest;
      },
    ],
  ])("rejects a %s new stamp before recording its key", (_name, mutate) => {
    const p = newProfile(`context-${_name}`);
    const intent = buildIntent("mood", today(p), mood(4), p, true);
    expect(applyIntent(p, mutate(intent) as never).status).toBe("rejected");
    expect(alreadyReplayed(p, intent.key)).toBe(false);
  });

  it("rejects profile and date contradictions before recording the key", () => {
    const p = newProfile("context-contradiction");
    const intent = buildIntent("mood", today(p), mood(4), p, true);
    for (const parts of [
      { ...intent.dayContext!.parts, profileId: p + 1 },
      { ...intent.dayContext!.parts, day: shiftDateStr(today(p), -1) },
    ]) {
      const contradicted = {
        ...intent,
        dayContext: {
          ...intent.dayContext!,
          parts,
          key: dayContextKey(parts),
        },
      };
      expect(applyIntent(p, contradicted).status).toBe("rejected");
      expect(alreadyReplayed(p, intent.key)).toBe(false);
    }
  });

  it("accepts separately allocated equivalent reaches", () => {
    const p = newProfile("context-equivalent-reach");
    const intent = buildIntent("mood", today(p), mood(4), p, true);
    const parts = {
      ...intent.dayContext!.parts,
      reach: { ...DATED_REACH },
    };
    expect(
      applyIntent(p, {
        ...intent,
        dayContext: {
          ...intent.dayContext!,
          parts,
          key: dayContextKey(parts),
        },
      })
    ).toEqual({ status: "done" });
  });

  it("expires a bounded capture while an old dated capture stays eligible", () => {
    const p = newProfile("context-expiry");
    const old = shiftDateStr(today(p), -3);
    const bounded = buildIntent("mood", old, mood(2), p, false);
    const boundedParts = {
      ...bounded.dayContext!.parts,
      reach: TAP_REACH["dose-status"],
    };
    expect(
      applyIntent(p, {
        ...bounded,
        dayContext: {
          ...bounded.dayContext!,
          parts: boundedParts,
          key: dayContextKey(boundedParts),
        },
      }).status
    ).toBe("rejected");

    const dated = buildIntent("mood", old, mood(5), p, false);
    expect(applyIntent(p, dated)).toEqual({ status: "done" });
  });

  it("keeps the wholly absent legacy path", () => {
    const p = newProfile("context-legacy");
    const stamped = buildIntent("mood", today(p), mood(4), p, true);
    const { dayContext: _dayContext, ...legacy } = stamped;
    expect(applyIntent(p, legacy)).toEqual({ status: "done" });
  });
});
