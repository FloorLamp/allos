// DB TIER — the unclaimed effort a day's heart rate holds, as the clocks a blank
// activity form carries (#5195, reader 2 of #5113).
//
// The judgment about what a finished effort IS belongs to `exertionWindows` and is
// pinned pure in lib/__tests__/exertion-window.test.ts. What these cases pin is
// everything the database adds around it: that the span is stated as profile-local
// clocks, that a row already covering it is a CLAIM rather than an offer, and — the
// fourth acceptance criterion — that a span declined anywhere is not offered here,
// through the one dismissal registry every reader shares.
//
// NOTHING HERE WRITES A ROW, and that is the point rather than an omission: a span is
// a suggestion until a save claims it (the #5194 ruling), so the offer is a pair of
// default values and the assertions are about what is OFFERED.
//
// Every value is synthetic.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  latestExertionOffer,
  unclaimedExertionSpans,
} from "@/lib/exertion-offer";
import { exertionSpanDismissalKey } from "@/lib/dismissal-keys";
import { setTimezone } from "@/lib/settings";

const NOW = new Date("2026-07-17T18:00:00Z");

/** A profile whose day runs in a NAMED zone, never the host's (#5338). */
function newProfile(name: string, tz = "UTC"): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, tz);
  return id;
}

/** A resting range of their own — without one this feature refuses to guess (#4775). */
function seedRestingHr(profileId: number, bpm: number): void {
  const ins = db.prepare(
    "INSERT INTO body_metrics (profile_id, date, resting_hr) VALUES (?, ?, ?)"
  );
  for (let i = 1; i <= 10; i++) {
    const d = new Date(
      Date.parse(`${today(profileId)}T00:00:00Z`) - i * 86_400_000
    );
    ins.run(profileId, d.toISOString().slice(0, 10), bpm);
  }
}

/** Minute-by-minute trace between two clock times on the profile's today. */
function seedRange(
  profileId: number,
  fromHhmm: string,
  toHhmm: string,
  bpm: number
): void {
  const day = today(profileId);
  const ins = db.prepare(
    "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, ?, 1, 'health-connect')"
  );
  let t = Date.parse(`${day}T${fromHhmm}:00Z`);
  const end = Date.parse(`${day}T${toHhmm}:00Z`);
  while (t < end) {
    ins.run(profileId, new Date(t).toISOString().slice(0, 16), bpm);
    t += 60_000;
  }
}

/**
 * One finished effort with measured quiet on both sides — the shape `exertionWindows`
 * answers. Quiet BEFORE matters as much as quiet after: a span already under way at
 * the trace's first minute has no measured start and is refused.
 */
function seedOneEffort(profileId: number): void {
  seedRestingHr(profileId, 60);
  seedRange(profileId, "15:30", "16:00", 55);
  seedRange(profileId, "16:00", "16:35", 140);
  seedRange(profileId, "16:35", "17:10", 55);
}

function seedWindowedActivity(
  profileId: number,
  start: string,
  end: string
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, type, title, date, start_time, end_time)
       VALUES (?, 'cardio', 'Ride', ?, ?, ?)`
  ).run(profileId, today(profileId), start, end);
}

describe("latestExertionOffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("states the effort's own clocks", () => {
    const p = newProfile("OfferPlain");
    seedOneEffort(p);
    expect(latestExertionOffer(p, today(p))).toEqual({
      start: "16:00",
      end: "16:35",
      dismissalKey: "exertion-span:2026-07-17T16:00",
    });
  });

  // The refusals. Each seeds the SAME effort as the case above and changes exactly one
  // thing, so a null is attributable to that thing rather than to a fixture that never
  // produced an effort at all — which the case above proves it does.
  it.each([
    [
      "a bare wrist",
      (p: number) => {
        seedRestingHr(p, 60);
      },
    ],
    [
      // Inventing a resting band is the clinical cutoff #4775 refuses.
      "no resting range of their own",
      (p: number) => {
        seedRange(p, "15:30", "16:00", 55);
        seedRange(p, "16:00", "16:35", 140);
        seedRange(p, "16:35", "17:10", 55);
      },
    ],
    [
      // A session logged over the effort IS the effort; offering the same window again
      // would invite two rows for one workout.
      "an activity already claiming the window",
      (p: number) => {
        seedOneEffort(p);
        seedWindowedActivity(p, "16:00", "16:35");
      },
    ],
    [
      // A span overlapping a logged practice is that practice's physiology, never a
      // workout nobody logged.
      "a practice already claiming the window",
      (p: number) => {
        seedOneEffort(p);
        db.prepare(
          `INSERT INTO practice_logs (profile_id, practice, date, start_time, end_time)
             VALUES (?, 'sauna', ?, '16:10', '16:30')`
        ).run(p, today(p));
      },
    ],
  ])("offers nothing for %s", (name, seed) => {
    const p = newProfile(`OfferNone-${name}`);
    seed(p);
    expect(latestExertionOffer(p, today(p))).toBeNull();
  });

  /** A decline, written the only way one is remembered: a row on the suppression bus. */
  function decline(profileId: number, localMinute: string): void {
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
         VALUES (?, ?, datetime('now'))`
    ).run(profileId, exertionSpanDismissalKey(localMinute));
  }

  // CRITERION 4. Readers 2 to 4 offer one span ONCE, and the memory of a refusal is the
  // suppression bus every other dismissal in this app already lives on — read here so
  // no surface has to remember to filter.
  //
  // ASKED BEFORE AND AFTER THE SAME ROW IS WRITTEN, because there is no writer for this
  // namespace yet (#5197 holds it) and a case that only asserts a null could be passing
  // on a fixture that never offered, or on a suppression map that came back empty. The
  // first expectation rules out the fixture; the second can only change because the row
  // landed and the filter read it. An empty map would leave the offer standing and red
  // this case rather than green it.
  it("stops offering a span the moment it is declined", () => {
    const p = newProfile("OfferDeclined");
    seedOneEffort(p);
    expect(latestExertionOffer(p, today(p))?.start).toBe("16:00");
    decline(p, `${today(p)}T16:00`);
    expect(latestExertionOffer(p, today(p))).toBeNull();
  });

  it("reads the span's OWN key, not merely that some span was declined", () => {
    // The namespace is not the identity. A refusal of the 15:00 span says nothing about
    // the 16:00 one, and this is what says the filter compares keys instead of asking
    // whether the profile has ever declined anything.
    const p = newProfile("OfferDeclinedElsewhere");
    seedOneEffort(p);
    decline(p, `${today(p)}T15:00`);
    expect(latestExertionOffer(p, today(p))?.start).toBe("16:00");
  });

  // SPAN ORDER, PINNED WHERE IT IS RELIED ON. `latestExertionOffer` takes the LAST span
  // and calls it the newest, which is only true because `exertionWindows` appends runs
  // in trace order and filters without reordering. A day with two efforts is what tells
  // the two readings apart; the one-effort cases above pin the single-span day, and
  // every refusal above pins the empty one (no last element, so no offer).
  it("offers the day's latest effort, the spans arriving oldest first", () => {
    const p = newProfile("OfferTwoEfforts");
    seedRestingHr(p, 60);
    seedRange(p, "13:00", "13:30", 55);
    seedRange(p, "13:30", "14:00", 140);
    seedRange(p, "14:00", "16:00", 55);
    seedRange(p, "16:00", "16:35", 140);
    seedRange(p, "16:35", "17:10", 55);
    expect(
      unclaimedExertionSpans(p, today(p)).map((span) =>
        new Date(span.from).toISOString().slice(11, 16)
      )
    ).toEqual(["13:30", "16:00"]);
    expect(latestExertionOffer(p, today(p))).toEqual({
      start: "16:00",
      end: "16:35",
      dismissalKey: "exertion-span:2026-07-17T16:00",
    });
  });

  it("is scoped to the profile that measured it", () => {
    const mine = newProfile("OfferMine");
    const theirs = newProfile("OfferTheirs");
    seedOneEffort(theirs);
    expect(latestExertionOffer(mine, today(mine))).toBeNull();
    expect(latestExertionOffer(theirs, today(theirs))?.start).toBe("16:00");
  });
});
