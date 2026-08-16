// DB INTEGRATION TIER — the fasting lifecycle's write cores (#2756) and the
// notification stand-down they feed (#2757).
//
// The pure derivations are covered in lib/__tests__/fasting.test.ts. What only a real
// database can prove is here: the one-active invariant under an actual unique index, the
// typed refusals coming back from real state, the adult-only ASYMMETRY (starts refuse,
// ending always succeeds), and the annotation reading real `food_log_events` rows.

import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setProfileSetting } from "@/lib/settings";
import { utcInstant } from "@/lib/date";
import {
  discardFast,
  endFast,
  fastingAvailable,
  reopenFast,
  startFast,
} from "@/lib/fast-write";
import { getActiveFast, listFasts } from "@/lib/fast-store";
import { FAST_MAX_HOURS } from "@/lib/fasting";
import { getServingsDuringFast } from "@/lib/queries/fasting";
import { standsDownForFast } from "@/lib/fasting-standdown";
import { logFoodServingCore } from "@/lib/food-log-write";
import { getUsualRoutineOffer } from "@/lib/queries/usual-routine";

function makeProfile(name: string, age?: number): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  if (age != null) setProfileSetting(id, "age", String(age));
  return id;
}

// A COMPLETED fast seeded directly, `startedHoursAgo` → `endedHoursAgo` before now.
// Inserted rather than driven through the cores because these fixtures are deliberately
// older than the cores would now accept — which is the point of the tests using them.
function seedCompleted(
  profileId: number,
  startedHoursAgo: number,
  endedHoursAgo: number
): number {
  return Number(
    db
      .prepare(
        "INSERT INTO fasts (profile_id, started_at, ended_at) VALUES (?, ?, ?)"
      )
      .run(
        profileId,
        utcInstant(new Date(Date.now() - startedHoursAgo * 3_600_000)),
        utcInstant(new Date(Date.now() - endedHoursAgo * 3_600_000))
      ).lastInsertRowid
  );
}

let adult: number;
let minor: number;

beforeEach(() => {
  db.prepare("DELETE FROM fasts").run();
  adult = makeProfile("adult-fast", 40);
  minor = makeProfile("minor-fast", 15);
});

describe("start / end lifecycle", () => {
  it("starts, reports the active row, and ends", () => {
    // Backdated an hour, because a fast that starts and ends inside the SAME STORED
    // SECOND is zero-length and is refused (see the granularity test below). "Start and
    // end with no time in between" is not a lifecycle, it is a mis-tap.
    const started = startFast(adult, new Date(Date.now() - 3_600_000));
    expect(started.kind).toBe("started");
    expect(getActiveFast(adult)).not.toBeNull();

    const ended = endFast(adult);
    expect(ended.kind).toBe("ended");
    expect(getActiveFast(adult)).toBeNull();
    expect(listFasts(adult)).toHaveLength(1);
  });

  it("refuses a SECOND start — the cross-device double-start", () => {
    const first = startFast(adult);
    expect(first.kind).toBe("started");
    const second = startFast(adult);
    expect(second).toEqual({
      kind: "already-active",
      id: first.kind === "started" ? first.id : -1,
    });
    // The refusal wrote nothing.
    expect(listFasts(adult)).toHaveLength(1);
  });

  it("refuses an end when nothing is running, rather than confirming", () => {
    expect(endFast(adult).kind).toBe("none-active");
  });

  it("refuses an end at or before its own start", () => {
    startFast(adult, new Date(Date.now() - 3_600_000));
    const bad = endFast(adult, new Date(Date.now() - 7_200_000));
    expect(bad.kind).toBe("invalid");
    // Still running: a refusal is a report, never a partial write.
    expect(getActiveFast(adult)).not.toBeNull();
  });

  it("refuses a future start", () => {
    expect(startFast(adult, new Date(Date.now() + 3_600_000)).kind).toBe(
      "invalid"
    );
    expect(listFasts(adult)).toHaveLength(0);
  });

  it("accepts a BACKDATED start — forgot-to-tap is the common failure", () => {
    const at = new Date(Date.now() - 10 * 3_600_000);
    expect(startFast(adult, at).kind).toBe("started");
    expect(getActiveFast(adult)?.started_at).toBe(utcInstant(at));
  });

  it("refuses a backdated start that would OVERLAP a recorded fast", () => {
    // A completed fast covering [-6h, -3h].
    startFast(adult, new Date(Date.now() - 6 * 3_600_000));
    endFast(adult, new Date(Date.now() - 3 * 3_600_000));
    // A new open fast backdated to -8h would swallow it.
    const clash = startFast(adult, new Date(Date.now() - 8 * 3_600_000));
    expect(clash.kind).toBe("overlap");
    expect(listFasts(adult)).toHaveLength(1);
  });

  it("allows a back-to-back start at the previous fast's exact end", () => {
    const end = new Date(Date.now() - 3 * 3_600_000);
    startFast(adult, new Date(Date.now() - 6 * 3_600_000));
    endFast(adult, end);
    expect(startFast(adult, end).kind).toBe("started");
  });
});

describe("Undo an end — the inverse is complete and local", () => {
  it("reopens the named fast, restoring the state exactly", () => {
    const started = startFast(adult, new Date(Date.now() - 3_600_000));
    const ended = endFast(adult);
    expect(ended.kind).toBe("ended");
    const id = ended.kind === "ended" ? ended.id : -1;
    expect(reopenFast(adult, id)).toEqual({ kind: "reopened", id });
    expect(getActiveFast(adult)?.id).toBe(id);
    expect(getActiveFast(adult)?.started_at).toBe(
      started.kind === "started" ? getActiveFast(adult)?.started_at : null
    );
  });

  it("refuses to reopen into an already-active fast", () => {
    startFast(adult, new Date(Date.now() - 6 * 3_600_000));
    const ended = endFast(adult, new Date(Date.now() - 5 * 3_600_000));
    const id = ended.kind === "ended" ? ended.id : -1;
    startFast(adult);
    expect(reopenFast(adult, id).kind).toBe("already-active");
  });

  // D1. `id` arrives from a FORM. Naming an id rather than resolving by recency was
  // never enough on its own — an id IS an arbitrary handle, so without an age bound this
  // core resurrects last week's fast exactly as a recency-resolved one would have, which
  // is the failure naming the id was supposed to avoid.
  it("refuses to reopen a fast that ended long ago — an Undo is not a resurrection", () => {
    // A fast recorded and closed ten days back.
    const id = seedCompleted(adult, 10 * 24, 10 * 24 - 16);
    expect(reopenFast(adult, id)).toEqual({ kind: "too-old" });
    expect(getActiveFast(adult)).toBeNull();
  });

  // D1, the shape the resurrection actually corrupts: reopening makes the fast OPEN
  // again, so it runs to +infinity and swallows everything recorded after it.
  it("refuses a reopen that would swallow a later fast", () => {
    const old = seedCompleted(adult, 10 * 24, 10 * 24 - 16);
    seedCompleted(adult, 48, 32);
    // Age is what stops this one first; prove the overlap guard independently by moving
    // the old fast's end inside the undo window while the later fast still sits after it.
    db.prepare("UPDATE fasts SET ended_at = ? WHERE id = ?").run(
      utcInstant(new Date(Date.now() - 60_000)),
      old
    );
    const outcome = reopenFast(adult, old);
    expect(outcome.kind).toBe("overlap");
    expect(getActiveFast(adult)).toBeNull();
  });

  // D1's downstream consequence, pinned directly: no core may mint a row another core
  // would refuse. `endFast` now carries the SAME FAST_MAX_HOURS bound `startFast` does.
  it("refuses to end a fast that has run past the maximum recordable length", () => {
    const startedAt = new Date(Date.now() - (FAST_MAX_HOURS + 24) * 3_600_000);
    db.prepare(
      "INSERT INTO fasts (profile_id, started_at, ended_at) VALUES (?, ?, NULL)"
    ).run(adult, utcInstant(startedAt));
    expect(endFast(adult).kind).toBe("too-long");
    // Still open and still reported honestly — a refusal writes nothing.
    expect(getActiveFast(adult)).not.toBeNull();
  });

  // D5. `utcInstant` truncates to SECONDS, so a millisecond comparison judges a
  // precision the column will not keep: two Dates 400 ms apart pass `end > start` in ms
  // and then serialize to the same string, storing a zero-length fast.
  it("refuses an end that would serialize to the same second as its start", () => {
    // Aligned to an exact second so the +400 ms below cannot straddle a second boundary
    // and accidentally become a real interval.
    const start = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
    startFast(adult, start);
    const end = new Date(start.getTime() + 400);
    expect(endFast(adult, end)).toEqual({ kind: "invalid" });
    expect(getActiveFast(adult)).not.toBeNull();
    // One second later is a real interval and lands.
    expect(endFast(adult, new Date(start.getTime() + 1000)).kind).toBe("ended");
    const row = listFasts(adult)[0];
    expect(row.ended_at).not.toBe(row.started_at);
  });
});

describe("discard — 'I never actually fasted'", () => {
  it("removes the row", () => {
    const started = startFast(adult);
    const id = started.kind === "started" ? started.id : -1;
    expect(discardFast(adult, id)).toEqual({ kind: "discarded", id });
    expect(listFasts(adult)).toHaveLength(0);
  });

  it("is profile-scoped — one profile cannot discard another's fast", () => {
    const other = makeProfile("other-adult", 30);
    const started = startFast(adult);
    const id = started.kind === "started" ? started.id : -1;
    expect(discardFast(other, id).kind).toBe("not-found");
    expect(getActiveFast(adult)).not.toBeNull();
  });
});

// THE RULING'S ASYMMETRY (#2756). This is the safety-shaped half of the feature, so the
// negatives are asserted as hard as the positives: a restricted profile can never START
// a fast, and can ALWAYS close an existing one out.
describe("adult-only at the core, with the end-side exemption", () => {
  it("refuses a start on a known-minor profile, and writes nothing", () => {
    expect(startFast(minor)).toEqual({ kind: "refused" });
    expect(listFasts(minor)).toHaveLength(0);
    expect(fastingAvailable(minor)).toBe(false);
  });

  it("PASSES on unknown age — hide only on a positive under-age match", () => {
    const unknown = makeProfile("unknown-age-fast");
    expect(fastingAvailable(unknown)).toBe(true);
    expect(startFast(unknown).kind).toBe("started");
  });

  it("lets a profile that became restricted MID-FAST still end it", () => {
    // The realistic history: the fast is started while the age is unknown, and a
    // birthdate edit later makes the profile restricted. Without the exemption this row
    // would be permanently un-closable — and its food nudges permanently stood down.
    const profile = makeProfile("became-minor");
    expect(startFast(profile, new Date(Date.now() - 3_600_000)).kind).toBe(
      "started"
    );
    setProfileSetting(profile, "age", "15");
    expect(fastingAvailable(profile)).toBe(false);

    const ended = endFast(profile);
    expect(ended.kind).toBe("ended");
    expect(getActiveFast(profile)).toBeNull();
    // And a new one still cannot be started.
    expect(startFast(profile).kind).toBe("refused");
  });

  // D2. THE GATE PROTECTS "no ACTIVE fast comes to exist", not "no row is INSERTed".
  // `ended_at IS NULL` IS the active state, so clearing it is a way of causing an active
  // fast to exist with no INSERT anywhere — and it is reachable through the Undo button
  // the app renders on the exempt end's own confirmation. This walks that exact path.
  it("refuses the Undo-after-end for a restricted profile — reopening CREATES an active fast", () => {
    const profile = makeProfile("became-minor-2");
    const started = startFast(profile, new Date(Date.now() - 3_600_000));
    const id = started.kind === "started" ? started.id : -1;
    const ended = endFast(profile);
    expect(ended.kind).toBe("ended");

    // The birthdate is corrected. Starts are now refused …
    setProfileSetting(profile, "age", "15");
    expect(startFast(profile).kind).toBe("refused");

    // … and so is the reopen, because it would leave this profile with an ACTIVE fast
    // and the #2757 stand-downs back on.
    expect(reopenFast(profile, id)).toEqual({ kind: "refused" });
    expect(getActiveFast(profile)).toBeNull();

    // Discard still works — it is the path that REMOVES fasting data, and refusing it
    // would keep the very content the gate exists to withhold.
    expect(discardFast(profile, id).kind).toBe("discarded");
  });

  // The exemptions' whole purpose, walked end to end: no supported path leaves a
  // restricted profile with an active fast, and the one it already had can always be
  // closed.
  it("leaves no path that gives a restricted profile an active fast", () => {
    const profile = makeProfile("became-minor-3");
    const started = startFast(profile, new Date(Date.now() - 3_600_000));
    const id = started.kind === "started" ? started.id : -1;
    setProfileSetting(profile, "age", "15");

    // The active row it already has can be closed (the exemption).
    expect(endFast(profile).kind).toBe("ended");
    // And nothing puts one back.
    expect(startFast(profile).kind).toBe("refused");
    expect(reopenFast(profile, id).kind).toBe("refused");
    expect(getActiveFast(profile)).toBeNull();
  });
});

describe("the annotation reads real food rows and offers no verdict", () => {
  it("counts only servings with a STATED eating instant inside the interval", () => {
    const day = today(adult);
    const start = new Date(Date.now() - 6 * 3_600_000);
    startFast(adult, start);

    // Inside the interval, with a stated eating time.
    logFoodServingCore(adult, "legumes", day, undefined, undefined, {
      eatenAt: utcInstant(new Date(Date.now() - 4 * 3_600_000)),
      source: "stated",
    });
    // Inside the interval, but no stated eating time — proves nothing about WHEN, so it
    // is not counted. Silence here is honest.
    logFoodServingCore(adult, "legumes", day);

    const ended = endFast(adult);
    expect(ended.kind).toBe("ended");
    const fast = listFasts(adult)[0];
    expect(getServingsDuringFast(adult, fast)).toBe(1);
    // The fast still stands, and so do the servings: both facts, no adjudication.
    expect(fast.ended_at).not.toBeNull();
  });

  it("does not count another profile's servings", () => {
    const other = makeProfile("other-food", 30);
    const start = new Date(Date.now() - 6 * 3_600_000);
    startFast(adult, start);
    logFoodServingCore(other, "legumes", today(other), undefined, undefined, {
      eatenAt: utcInstant(new Date(Date.now() - 4 * 3_600_000)),
      source: "stated",
    });
    endFast(adult);
    expect(getServingsDuringFast(adult, listFasts(adult)[0])).toBe(0);
  });
});

// #2757 over real rows: the stand-down follows the fast's actual state and heals itself
// the moment it ends, because nothing is stored.
describe("the stand-down over real state (#2757)", () => {
  it("stands the food nudge down while active and resumes on the end", () => {
    expect(standsDownForFast(getActiveFast(adult), "food", new Date())).toBe(
      false
    );
    startFast(adult, new Date(Date.now() - 3_600_000));
    expect(standsDownForFast(getActiveFast(adult), "food", new Date())).toBe(
      true
    );
    // Nothing was written anywhere to record the suppression …
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM profile_settings WHERE profile_id = ? AND key LIKE '%fast%'"
        )
        .get(adult)
    ).toEqual({ n: 0 });
    endFast(adult);
    // … so it self-heals with no sweep.
    expect(standsDownForFast(getActiveFast(adult), "food", new Date())).toBe(
      false
    );
  });

  it("never stands a dose reminder or an escalation down, fasting or not", () => {
    startFast(adult, new Date(Date.now() - 3_600_000));
    const active = getActiveFast(adult);
    expect(standsDownForFast(active, "dose", new Date())).toBe(false);
    expect(standsDownForFast(active, "escalation", new Date())).toBe(false);
    expect(standsDownForFast(active, "redose", new Date())).toBe(false);
  });

  // The OFFER half, at the gather that actually decides it. The dashboard control and
  // the log-sheet context row both render from `getUsualRoutineOffer`, so this is the
  // one place the stand-down has to hold — and it holds BEFORE the food gather runs, so
  // a fasting profile pays for no reads at all.
  it("withdraws the usual-routine offer while a fast is active", () => {
    const day = today(adult);
    // Whatever the offer would be for this profile, an active fast makes it null …
    startFast(adult, new Date(Date.now() - 3_600_000));
    for (const window of ["Morning", "Midday", "Evening"] as const) {
      expect(getUsualRoutineOffer(adult, window, day)).toBeNull();
    }
    // … and ending the fast restores whatever it was, with nothing to sweep. (This
    // seeded profile has no habitual food history, so the restored answer is also null;
    // what is proved here is that the stand-down does not persist past the fast.)
    endFast(adult);
    expect(getActiveFast(adult)).toBeNull();
  });

  it("leaves food LOGGING untouched while the offer stands down (#2419)", () => {
    const day = today(adult);
    startFast(adult, new Date(Date.now() - 3_600_000));
    // The offer is gone …
    expect(getUsualRoutineOffer(adult, "Morning", day)).toBeNull();
    // … and every food row is exactly as loggable. The stand-down withdraws the OFFER,
    // never the ability to record what you ate.
    const outcome = logFoodServingCore(adult, "legumes", day);
    expect(outcome.kind).toBe("logged");
  });
});
