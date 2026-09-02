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
import { parseUtcSql, utcInstant } from "@/lib/date";
import {
  discardFast,
  editFast,
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
import { getDataset, toCsv } from "@/lib/export";

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
//
// The end's WRITE stamp defaults to the end instant itself, i.e. a PLAIN end recorded as
// it happened, which is what every fixture here means by "ended N hours ago". Pass
// `writtenHoursAgo` to pull the two apart — a backdated end — which is the case the Undo
// window is actually measured against.
function seedCompleted(
  profileId: number,
  startedHoursAgo: number,
  endedHoursAgo: number,
  writtenHoursAgo: number = endedHoursAgo
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO fasts (profile_id, started_at, ended_at, end_written_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        profileId,
        utcInstant(new Date(Date.now() - startedHoursAgo * 3_600_000)),
        utcInstant(new Date(Date.now() - endedHoursAgo * 3_600_000)),
        utcInstant(new Date(Date.now() - writtenHoursAgo * 3_600_000))
      ).lastInsertRowid
  );
}

/** The row's stored end and the instant that end was written. */
function storedEnd(id: number): {
  ended_at: string | null;
  end_written_at: string | null;
} {
  return db
    .prepare("SELECT ended_at, end_written_at FROM fasts WHERE id = ?")
    .get(id) as { ended_at: string | null; end_written_at: string | null };
}

let adult: number;
let minor: number;

beforeEach(() => {
  db.prepare("DELETE FROM fasts").run();
  adult = makeProfile("adult-fast", 40);
  minor = makeProfile("minor-fast", 15);
});

describe("start / end lifecycle", () => {
  it("runs the lifecycle and refuses conflicting cross-device commands", () => {
    // Backdated an hour, because a fast that starts and ends inside the SAME STORED
    // SECOND is zero-length and is refused (see the granularity test below). "Start and
    // end with no time in between" is not a lifecycle, it is a mis-tap.
    const started = startFast(adult, new Date(Date.now() - 3_600_000));
    expect(started.kind).toBe("started");
    expect(getActiveFast(adult)).not.toBeNull();
    expect(startFast(adult)).toEqual({
      kind: "already-active",
      id: started.kind === "started" ? started.id : -1,
    });
    expect(listFasts(adult)).toHaveLength(1);

    const ended = endFast(adult);
    expect(ended.kind).toBe("ended");
    expect(getActiveFast(adult)).toBeNull();
    expect(listFasts(adult)).toHaveLength(1);
    expect(endFast(adult).kind).toBe("none-active");
  });

  it("rejects future starts and ends at or before the stored start", () => {
    expect(startFast(adult, new Date(Date.now() + 3_600_000)).kind).toBe(
      "invalid"
    );
    expect(listFasts(adult)).toHaveLength(0);

    startFast(adult, new Date(Date.now() - 3_600_000));
    const bad = endFast(adult, new Date(Date.now() - 7_200_000));
    expect(bad.kind).toBe("invalid");
    // Still running: a refusal is a report, never a partial write.
    expect(getActiveFast(adult)).not.toBeNull();
  });

  it("accepts backdated boundaries but refuses one that overlaps history", () => {
    // A completed fast covering [-6h, -3h].
    const start = new Date(Date.now() - 6 * 3_600_000);
    const end = new Date(Date.now() - 3 * 3_600_000);
    expect(startFast(adult, start).kind).toBe("started");
    expect(getActiveFast(adult)?.started_at).toBe(utcInstant(start));
    endFast(adult, end);
    // A new open fast backdated to -8h would swallow it.
    const clash = startFast(adult, new Date(Date.now() - 8 * 3_600_000));
    expect(clash.kind).toBe("overlap");
    expect(listFasts(adult)).toHaveLength(1);
    // Touching the prior row at its exact end is not overlap.
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
    db.prepare(
      "UPDATE fasts SET ended_at = ?, end_written_at = ? WHERE id = ?"
    ).run(
      utcInstant(new Date(Date.now() - 60_000)),
      utcInstant(new Date(Date.now() - 60_000)),
      old
    );
    const outcome = reopenFast(adult, old);
    expect(outcome.kind).toBe("overlap");
    expect(getActiveFast(adult)).toBeNull();
  });

  // F1. The claim ceiling does NOT reach the Undo path, and this is the test that says
  // so. A duration guard here could only ever fire after `too-old` had already passed —
  // i.e. on a row this app wrote and accepted within the last quarter hour — so it was
  // never judging a claim from a user; it was refusing to give back a state the app had
  // just been in. Once `endFast` stopped refusing long intervals (R1, below), ending a
  // forgotten fast became ordinary, and the Undo drawn beside it answered `too-long` on
  // every tap with nothing behind it.
  it("reopens a fast past the maximum length — an Undo is not a new claim", () => {
    const id = seedCompleted(adult, FAST_MAX_HOURS + 24, 1 / 60);
    expect(reopenFast(adult, id)).toEqual({ kind: "reopened", id });
    expect(getActiveFast(adult)?.id).toBe(id);
  });

  // …and the Undo is a real way back, not just a state change: it lands in the state the
  // stale suggest handles, where BOTH of that copy's resolutions work. This is the whole
  // point of the fix — before it, the long row was permanent (reopen refused, discard
  // refuses a completed row, no edit core exists) and it then answered `overlap` to every
  // backdated start inside the fortnight the field can reach.
  it("leaves the reopened long fast discardable, and the fortnight startable again", () => {
    const id = seedCompleted(adult, FAST_MAX_HOURS + 24, 1 / 60);
    // While it is still recorded, the honest correction is blocked — the reason the dead
    // Undo mattered rather than being a cosmetic dead button.
    expect(
      startFast(adult, new Date(Date.now() - 5 * 24 * 3_600_000)).kind
    ).toBe("overlap");
    expect(reopenFast(adult, id).kind).toBe("reopened");
    expect(discardFast(adult, id)).toEqual({ kind: "discarded", id });
    expect(listFasts(adult)).toHaveLength(0);
    expect(
      startFast(adult, new Date(Date.now() - 5 * 24 * 3_600_000)).kind
    ).toBe("started");
  });

  // The bound that actually separates an Undo from an arbitrary reopen is AGE, and it
  // still does the whole job on a long row: past the window this is history, whatever its
  // length.
  it("still refuses a long fast whose end is outside the undo window", () => {
    const id = seedCompleted(adult, FAST_MAX_HOURS + 24, 2);
    expect(reopenFast(adult, id)).toEqual({ kind: "too-old" });
    expect(getActiveFast(adult)).toBeNull();
  });

  // ── F4. THE AGE BOUND MEASURES THE WRITE, NOT THE INSTANT THE END NAMES ───────────
  //
  // An Undo takes back an ACTION, and the action happened now whatever time it recorded.
  // Measuring from `ended_at` made the window already expired at the moment of the write
  // for every backdated end — which the surface asks for out loud ("End it at the time
  // you actually stopped") — so the Undo drawn beside it was refused on every tap, with
  // F1's whole damage list behind the refusal.
  it("undoes a BACKDATED end — the window runs from the write, not from the instant named", () => {
    startFast(adult, new Date(Date.now() - 40 * 3_600_000));
    // The user does what the stale suggest tells them: end it at the time they stopped,
    // four hours ago. That names an instant far outside the undo window.
    const ended = endFast(adult, new Date(Date.now() - 4 * 3_600_000));
    expect(ended.kind).toBe("ended");
    const id = ended.kind === "ended" ? ended.id : -1;
    expect(reopenFast(adult, id)).toEqual({ kind: "reopened", id });
    expect(getActiveFast(adult)?.id).toBe(id);
  });

  // The same door, driven end to end through the cores at the size that made it matter:
  // the forgotten long fast, ended honestly at the time it really stopped.
  it("undoes an end backdated by DAYS, and the fortnight is startable again", () => {
    startFast(adult, new Date(Date.now() - 12 * 24 * 3_600_000));
    const ended = endFast(adult, new Date(Date.now() - 10 * 24 * 3_600_000));
    const id = ended.kind === "ended" ? ended.id : -1;
    expect(reopenFast(adult, id)).toEqual({ kind: "reopened", id });
    // …and the way out is complete from there, exactly as it is on the plain path.
    expect(discardFast(adult, id)).toEqual({ kind: "discarded", id });
    expect(listFasts(adult)).toHaveLength(0);
    expect(
      startFast(adult, new Date(Date.now() - 5 * 24 * 3_600_000)).kind
    ).toBe("started");
  });

  // The bound did not get weaker, it got measured correctly — so an end WRITTEN two
  // hours ago is history even when the instant it names is a minute old. This is the
  // reading that would let a stale tab resurrect a fast if the two were confused the
  // other way round.
  it("refuses an end that was WRITTEN outside the window, however recent the instant it names", () => {
    const id = seedCompleted(adult, 30, 1 / 60, 2);
    expect(reopenFast(adult, id)).toEqual({ kind: "too-old" });
    expect(getActiveFast(adult)).toBeNull();
  });

  // A closed row whose end nobody recorded the writing of — no core produces one, since
  // the end and its stamp are a single argument at the store, but the column is nullable
  // and `id` arrives from a form. It is not an Undo of anything this app just did.
  it("refuses a closed row that carries no write stamp at all", () => {
    const id = seedCompleted(adult, 30, 1 / 60);
    db.prepare("UPDATE fasts SET end_written_at = NULL WHERE id = ?").run(id);
    expect(reopenFast(adult, id)).toEqual({ kind: "too-old" });
  });

  // The pair is written together and cleared together, which is what keeps "closed with
  // no write stamp" out of the schema rather than out of a guard.
  it("stamps the write on an end and clears it on the reopen", () => {
    startFast(adult, new Date(Date.now() - 5 * 3_600_000));
    const backdated = new Date(Date.now() - 2 * 3_600_000);
    const ended = endFast(adult, backdated);
    const id = ended.kind === "ended" ? ended.id : -1;
    const closed = storedEnd(id);
    expect(closed.ended_at).toBe(utcInstant(backdated));
    // The stamp is the app's own clock at the write, not the instant the end names.
    expect(closed.end_written_at).not.toBe(closed.ended_at);
    expect(
      Date.now() - new Date(closed.end_written_at as string).getTime()
    ).toBeLessThan(60_000);

    expect(reopenFast(adult, id).kind).toBe("reopened");
    expect(storedEnd(id)).toEqual({ ended_at: null, end_written_at: null });
  });

  // R1/R2. FAST_MAX_HOURS is a ceiling on a CLAIM, never on a fast the app watched run.
  // A guard here refused nothing that was not already true of the row — `end` is bounded
  // by now, so this core can only ever shorten — and it stranded every fast older than
  // 14 days, restricted profiles worst of all (below), where the close-out control is the
  // whole surface.
  it("ends a fast that has run past the maximum recordable length — the clock is not a claim", () => {
    const startedAt = new Date(Date.now() - (FAST_MAX_HOURS + 24) * 3_600_000);
    db.prepare(
      "INSERT INTO fasts (profile_id, started_at, ended_at) VALUES (?, ?, NULL)"
    ).run(adult, utcInstant(startedAt));
    expect(endFast(adult).kind).toBe("ended");
    expect(getActiveFast(adult)).toBeNull();
    expect(listFasts(adult)[0].ended_at).not.toBeNull();
  });

  // R2. The stale suggest tells the user to "End it at the time you actually stopped".
  // With the length guard in place that sentence named a write the core rejected: a
  // backdated end was refused for being long, while an end at start + 13 d — a time the
  // user did NOT stop — was accepted. The honest answer has to be the one that lands.
  it("accepts an honest backdated end on an over-long fast", () => {
    const startedAt = new Date(Date.now() - (FAST_MAX_HOURS + 48) * 3_600_000);
    db.prepare(
      "INSERT INTO fasts (profile_id, started_at, ended_at) VALUES (?, ?, NULL)"
    ).run(adult, utcInstant(startedAt));
    // "I actually stopped an hour ago."
    const stopped = new Date(Date.now() - 3_600_000);
    expect(endFast(adult, stopped)).toMatchObject({ kind: "ended" });
    expect(listFasts(adult)[0].ended_at).toBe(utcInstant(stopped));
  });

  // The ceiling stays where an interval really does arrive from a user: a backdated
  // START past it is still refused, so nothing here loosens the claim side.
  it("still refuses a backdated START past the maximum", () => {
    expect(
      startFast(adult, new Date(Date.now() - (FAST_MAX_HOURS + 1) * 3_600_000))
    ).toEqual({ kind: "invalid" });
    expect(listFasts(adult)).toHaveLength(0);
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
  it("is profile-scoped, then lets the owner remove the active row", () => {
    const other = makeProfile("other-adult", 30);
    const started = startFast(adult);
    const id = started.kind === "started" ? started.id : -1;
    expect(discardFast(other, id).kind).toBe("not-found");
    expect(getActiveFast(adult)).not.toBeNull();
    expect(discardFast(adult, id)).toEqual({ kind: "discarded", id });
    expect(listFasts(adult)).toHaveLength(0);
  });

  // R3. THE STALE TAB, which is the app's own button carrying a now-wrong id rather than
  // a crafted one. Discard is drawn only on the stale suggest, for the ACTIVE fast; a tab
  // open across an end on another device still holds that row's id. Without a state
  // re-derivation this deletes a COMPLETED fast — no confirmation, no undo — and answers
  // "Discarded.", while the very same tab's `startFast` is correctly refused.
  it("refuses to discard a fast that was closed on another device", () => {
    const started = startFast(adult, new Date(Date.now() - 3_600_000));
    const id = started.kind === "started" ? started.id : -1;

    // Device B ends it and starts the next one.
    expect(endFast(adult).kind).toBe("ended");
    const second = startFast(adult);
    expect(second.kind).toBe("started");

    // Device A's Discard still names the first row.
    expect(discardFast(adult, id)).toEqual({ kind: "already-ended", id });
    // The completed fast is still there, and so is the running one.
    expect(listFasts(adult)).toHaveLength(2);
    expect(getActiveFast(adult)).not.toBeNull();
    // The refusal is the same shape the same stale tab's start already got.
    expect(startFast(adult).kind).toBe("already-active");
  });
});

// CORRECTING A RECORDED FAST (#2993). The remedy the owner ruled for: a 15-day recorded
// fast is almost always a mis-set date, and editing says that where deleting does not.
// This core was deleted once for having no surface, so what these pin is not only that it
// works but the properties the rest of the machine depends on — it mints no active row,
// it does not restart the Undo's clock, and it carries the claim ceiling.
describe("edit — correcting a fast recorded with a mis-set date", () => {
  it("corrects the end of an implausibly long recorded fast", () => {
    // The #2993 row exactly: ended, over-long, and past every other way back — reopen is
    // `too-old` and discard refuses a completed row.
    const id = seedCompleted(adult, FAST_MAX_HOURS + 24, 0.5);
    expect(reopenFast(adult, id).kind).toBe("too-old");
    expect(discardFast(adult, id)).toEqual({ kind: "already-ended", id });
    const before = listFasts(adult)[0];

    // ONLY THE END IS NAMED — which is both what the surface posts for this correction
    // and the reason the row is still correctable at all: its start is 360 h old, so
    // re-judging it as a fresh claim would refuse the one fix #2993 asked for.
    const corrected = new Date(Date.now() - (FAST_MAX_HOURS + 8) * 3_600_000);
    expect(editFast(adult, id, undefined, corrected)).toEqual({
      kind: "saved",
      id,
    });

    const row = listFasts(adult)[0];
    // The untouched start is BYTE-FOR-BYTE what it was, not a re-serialization of it.
    expect(row.started_at).toBe(before.started_at);
    expect(row.ended_at).toBe(utcInstant(corrected));
    // Still exactly one row, and still closed: the correction records what happened
    // rather than asserting the fast never did.
    expect(listFasts(adult)).toHaveLength(1);
    expect(getActiveFast(adult)).toBeNull();
  });

  // The damage the permanent long row did, and its repair. Before the correction every
  // backdated start inside the span answers `overlap`; afterwards the same start lands.
  it("frees the backdated starts the over-long row was blocking", () => {
    const id = seedCompleted(adult, FAST_MAX_HOURS + 24, 0.5);
    const blocked = new Date(Date.now() - 120 * 3_600_000);
    expect(startFast(adult, blocked).kind).toBe("overlap");

    expect(
      editFast(
        adult,
        id,
        undefined,
        new Date(Date.now() - (FAST_MAX_HOURS + 8) * 3_600_000)
      ).kind
    ).toBe("saved");
    expect(startFast(adult, blocked).kind).toBe("started");
  });

  it("keeps the note it was not asked to change", () => {
    const started = startFast(
      adult,
      new Date(Date.now() - 6 * 3_600_000),
      "ok"
    );
    const id = started.kind === "started" ? started.id : -1;
    expect(endFast(adult).kind).toBe("ended");
    const start = new Date(Date.now() - 5 * 3_600_000);
    expect(
      editFast(adult, id, start, new Date(start.getTime() + 3_600_000)).kind
    ).toBe("saved");
    expect(listFasts(adult)[0].note).toBe("ok");
  });

  // THE LENGTH CEILING, on the one shape that can still reach it. With a NAMED start
  // bounded to `startFast`'s window, start and end together can never span more than the
  // ceiling — so what this refuses is the other direction: dragging an already-old row's
  // END forward until the interval passes the ceiling, with the start left untouched.
  it("refuses stretching an old row's end past FAST_MAX_HOURS", () => {
    const id = seedCompleted(adult, FAST_MAX_HOURS + 24, 0.5);
    const before = listFasts(adult);
    expect(editFast(adult, id, undefined, new Date())).toEqual({
      kind: "invalid",
    });
    // A refusal is a report, never a partial write.
    expect(listFasts(adult)).toEqual(before);
    // The shortening it exists to allow still lands.
    expect(
      editFast(
        adult,
        id,
        undefined,
        new Date(Date.now() - (FAST_MAX_HOURS + 8) * 3_600_000)
      ).kind
    ).toBe("saved");
  });

  // R1b — THE LAUNDRY THAT NEEDS NO UNDO AT ALL. `startFast` bounds how far BACK a start
  // may be placed; a length-only ceiling on the edit bounded `end - start` and nothing
  // else, so a legal 10-day interval could be planted three years ago — a row `startFast`
  // refuses, produced by a core. Chaining three of them fabricated 42 days of history.
  it("refuses a NAMED start further back than startFast would accept", () => {
    const id = seedCompleted(adult, 20, 4);
    const before = listFasts(adult);
    const longAgo = new Date(Date.now() - 3 * 365 * 24 * 3_600_000);
    const tenDaysLater = new Date(longAgo.getTime() + 10 * 24 * 3_600_000);

    // The interval itself is legal — 10 days, well under the ceiling. Its POSITION is
    // what `startFast` refuses, and now so does this.
    expect(tenDaysLater.getTime() - longAgo.getTime()).toBeLessThan(
      FAST_MAX_HOURS * 3_600_000
    );
    expect(startFast(adult, longAgo)).toEqual({ kind: "invalid" });
    expect(editFast(adult, id, longAgo, tenDaysLater)).toEqual({
      kind: "invalid",
    });
    expect(listFasts(adult)).toEqual(before);

    // The far edge is the same one `startFast` draws, so no pair of cores disagrees.
    const atTheEdge = new Date(Date.now() - (FAST_MAX_HOURS - 1) * 3_600_000);
    expect(
      editFast(adult, id, atTheEdge, new Date(Date.now() - 3_600_000)).kind
    ).toBe("saved");
  });

  it("refuses a NAMED start in the future", () => {
    const id = seedCompleted(adult, 20, 4);
    expect(
      editFast(
        adult,
        id,
        new Date(Date.now() + 3_600_000),
        new Date(Date.now() - 3_600_000)
      )
    ).toEqual({ kind: "invalid" });
  });

  // R1 — THE LAUNDRY THROUGH THE UNDO, which is the composition neither the ceiling nor
  // the Undo's own bounds caught on their own. Start, end, edit to a legal interval three
  // years back, tap Undo (the write stamp is untouched, so `too-old` still passes), end
  // again — and `endFast` writes `now` against whatever start the row now carries. Every
  // step returned a typed success and the row came out at 78× the ceiling.
  //
  // The fix is at the claim, not at the Undo: the edit refuses to plant that start, so
  // the longest thing this composition can now record is what the clock produced.
  it("cannot launder a long fast through edit-then-Undo", () => {
    const started = startFast(adult, new Date(Date.now() - 3_600_000));
    const id = started.kind === "started" ? started.id : -1;
    expect(endFast(adult).kind).toBe("ended");

    const longAgo = new Date(Date.now() - 3 * 365 * 24 * 3_600_000);
    expect(
      editFast(adult, id, longAgo, new Date(longAgo.getTime() + 864_000_000))
    ).toEqual({ kind: "invalid" });

    // The Undo is still live — this is not a test of the age bound — so the reopen and
    // the re-end both land, and the row they leave is bounded by the CLOCK.
    expect(reopenFast(adult, id).kind).toBe("reopened");
    expect(endFast(adult).kind).toBe("ended");
    const row = listFasts(adult)[0];
    const start = parseUtcSql(row.started_at);
    const end = parseUtcSql(row.ended_at);
    expect(end!.getTime() - start!.getTime()).toBeLessThanOrEqual(
      FAST_MAX_HOURS * 3_600_000
    );
  });

  // D5's granularity rule, one core over: `utcInstant` truncates to the second, so a
  // millisecond comparison would accept a pair that serializes to a zero-length fast.
  it("refuses a zero-length correction AT THE STORED SECOND", () => {
    const id = seedCompleted(adult, 20, 4);
    // ALIGNED TO AN EXACT SECOND, like the `endFast` twin above, so the +400 ms below
    // cannot straddle a second boundary and become a real interval. A bare `Date.now()`
    // carries whatever sub-second remainder the clock had, and past 600 ms the +400 lands
    // in the NEXT second — the guard then correctly declines to refuse and the edit
    // saves. That is not a weaker version of this assertion, it is a different one: the
    // rule being pinned is that a pair which SERIALIZES to one second is refused, so the
    // test has to construct a pair that provably does.
    const start = new Date(
      Math.floor((Date.now() - 20 * 3_600_000) / 1000) * 1000
    );
    expect(editFast(adult, id, start, start)).toEqual({ kind: "invalid" });
    expect(editFast(adult, id, start, new Date(start.getTime() + 400))).toEqual(
      { kind: "invalid" }
    );
    expect(
      editFast(adult, id, start, new Date(start.getTime() + 1000)).kind
    ).toBe("saved");
  });

  it("refuses an end in the future", () => {
    const id = seedCompleted(adult, 20, 4);
    const start = new Date(Date.now() - 20 * 3_600_000);
    expect(
      editFast(adult, id, start, new Date(Date.now() + 3_600_000))
    ).toEqual({ kind: "invalid" });
  });

  it("refuses a correction that would overlap another recorded fast", () => {
    const older = seedCompleted(adult, 48, 40);
    const id = seedCompleted(adult, 20, 4);
    const before = listFasts(adult);
    const start = new Date(Date.now() - 44 * 3_600_000);
    expect(
      editFast(adult, id, start, new Date(Date.now() - 4 * 3_600_000))
    ).toEqual({ kind: "overlap", id: older });
    expect(listFasts(adult)).toEqual(before);
  });

  // A fast always overlaps ITSELF, so the scan has to exclude the row being edited —
  // otherwise no correction of any kind could land.
  it("does not treat the edited row as its own overlap", () => {
    const id = seedCompleted(adult, 20, 4);
    const start = new Date(Date.now() - 19 * 3_600_000);
    expect(
      editFast(adult, id, start, new Date(Date.now() - 5 * 3_600_000)).kind
    ).toBe("saved");
  });

  // The ACTIVE fast runs to +infinity, so a correction cannot reach into it either.
  it("refuses a correction that would run into the ACTIVE fast", () => {
    const id = seedCompleted(adult, 48, 40);
    expect(startFast(adult, new Date(Date.now() - 12 * 3_600_000)).kind).toBe(
      "started"
    );
    const start = new Date(Date.now() - 48 * 3_600_000);
    expect(
      editFast(adult, id, start, new Date(Date.now() - 6 * 3_600_000)).kind
    ).toBe("overlap");
  });

  // IT CANNOT MINT AN ACTIVE ROW, which the partial unique index and every reader
  // downstream assume. The end is always written, so no input clears `ended_at` — and the
  // RUNNING row is not editable at all.
  it("refuses to edit the running fast, and leaves it running", () => {
    const started = startFast(adult, new Date(Date.now() - 6 * 3_600_000));
    const id = started.kind === "started" ? started.id : -1;
    const start = new Date(Date.now() - 5 * 3_600_000);
    expect(
      editFast(adult, id, start, new Date(Date.now() - 3_600_000))
    ).toEqual({ kind: "still-active", id });
    const row = getActiveFast(adult);
    expect(row).not.toBeNull();
    expect(row?.ended_at).toBeNull();
  });

  // The stale tab, the other direction from discard's `already-ended`: the id was drawn
  // on a completed row, and the fast was reopened elsewhere before the save landed.
  it("refuses a correction whose row was reopened on another device", () => {
    const started = startFast(adult, new Date(Date.now() - 6 * 3_600_000));
    const id = started.kind === "started" ? started.id : -1;
    expect(endFast(adult).kind).toBe("ended");
    // Device B taps Undo.
    expect(reopenFast(adult, id).kind).toBe("reopened");
    const start = new Date(Date.now() - 5 * 3_600_000);
    expect(
      editFast(adult, id, start, new Date(Date.now() - 3_600_000)).kind
    ).toBe("still-active");
  });

  // THE UNDO'S CLOCK IS NOT RESTARTED. `end_written_at` bounds the Undo of an END, and an
  // edit is not an end — reopening after one would delete the end rather than restore
  // what the edit changed. So a correction must never leave a row MORE reopenable than it
  // found it, which is the "resurrect last week's fast" this bound exists to refuse.
  it("preserves end_written_at, so correcting an old fast does not make it reopenable", () => {
    const id = seedCompleted(adult, 200, 100);
    const written = storedEnd(id).end_written_at;
    const start = new Date(Date.now() - 30 * 3_600_000);
    const corrected = new Date(Date.now() - 20 * 3_600_000);
    expect(editFast(adult, id, start, corrected).kind).toBe("saved");

    const after = storedEnd(id);
    expect(after.end_written_at).toBe(written);
    expect(after.ended_at).toBe(utcInstant(corrected));
    // The row is exactly as un-reopenable as it was before the correction.
    expect(reopenFast(adult, id).kind).toBe("too-old");
  });

  // R5 — AN UNTOUCHED INSTANT IS NOT REWRITTEN, which is the `note` discipline applied to
  // the columns the button is actually about. The form's prefill is MINUTE-grained, so a
  // "Save times" that posted both fields truncated the stored seconds off the instant the
  // user never touched — every save, silently, on a control whose label says it is saving
  // what is on screen. The stored value has real seconds here precisely to catch that.
  it("leaves an unnamed instant byte-for-byte, seconds included", () => {
    // Stored with real, non-zero SECONDS — the precision a minute-grained form cannot
    // express and therefore the precision an untouched field would quietly destroy.
    const withSeconds = (hoursAgo: number, ss: string): string =>
      utcInstant(new Date(Date.now() - hoursAgo * 3_600_000)).replace(
        /:\d\dZ$/,
        `:${ss}Z`
      );
    const startedAt = withSeconds(20, "37");
    const endedAt = withSeconds(4, "49");
    const id = Number(
      db
        .prepare(
          `INSERT INTO fasts (profile_id, started_at, ended_at, end_written_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(adult, startedAt, endedAt, endedAt).lastInsertRowid
    );

    const correctedEnd = new Date(Date.now() - 3 * 3_600_000);
    expect(editFast(adult, id, undefined, correctedEnd).kind).toBe("saved");
    expect(listFasts(adult)[0].started_at).toBe(startedAt);
    expect(listFasts(adult)[0].ended_at).toBe(utcInstant(correctedEnd));

    // The other direction: correcting the START leaves the end exactly as it stands.
    const endNow = listFasts(adult)[0].ended_at;
    const correctedStart = new Date(Date.now() - 19 * 3_600_000);
    expect(editFast(adult, id, correctedStart, undefined).kind).toBe("saved");
    expect(listFasts(adult)[0].started_at).toBe(utcInstant(correctedStart));
    expect(listFasts(adult)[0].ended_at).toBe(endNow);
  });

  it("reports `unchanged` when neither instant was named, and writes nothing", () => {
    const id = seedCompleted(adult, 20, 4);
    const before = listFasts(adult);
    expect(editFast(adult, id)).toEqual({ kind: "unchanged", id });
    expect(listFasts(adult)).toEqual(before);
  });

  // R2 — THE PROPERTY, STATED UNCONDITIONALLY AND NOW TRUE. A closed row with a NULL
  // write stamp is one this module cannot create, but the column is nullable and
  // `reopenFast` reads NULL as `too-old`. An earlier revision supplied a stamp on edit
  // (`?? row.ended_at`), which handed such a row the plain-end reading and made it
  // REOPENABLE by being corrected. The store statement no longer names the column at all.
  it("never makes a row more reopenable, including one with no write stamp", () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO fasts (profile_id, started_at, ended_at, end_written_at)
           VALUES (?, ?, ?, NULL)`
        )
        .run(
          adult,
          utcInstant(new Date(Date.now() - 3 * 3_600_000)),
          utcInstant(new Date(Date.now() - 60_000))
        ).lastInsertRowid
    );
    expect(reopenFast(adult, id).kind).toBe("too-old");
    expect(
      editFast(adult, id, undefined, new Date(Date.now() - 30_000)).kind
    ).toBe("saved");
    expect(storedEnd(id).end_written_at).toBeNull();
    expect(reopenFast(adult, id).kind).toBe("too-old");
  });

  it("is profile-scoped — one profile cannot correct another's fast", () => {
    const other = makeProfile("other-editor", 30);
    const id = seedCompleted(adult, 20, 4);
    const before = listFasts(adult);
    const start = new Date(Date.now() - 19 * 3_600_000);
    expect(
      editFast(other, id, start, new Date(Date.now() - 5 * 3_600_000))
    ).toEqual({ kind: "not-found" });
    expect(listFasts(adult)).toEqual(before);
  });

  it("reports not-found for an id that names nothing", () => {
    const start = new Date(Date.now() - 5 * 3_600_000);
    expect(
      editFast(adult, 9999, start, new Date(Date.now() - 3_600_000))
    ).toEqual({ kind: "not-found" });
  });
});

// THE RULING'S ASYMMETRY (#2756). This is the safety-shaped half of the feature, so the
// negatives are asserted as hard as the positives: a restricted profile can never START
// a fast, and can ALWAYS close an existing one out.
describe("adult-only at the core, with the end-side exemption", () => {
  it("refuses a known minor but permits an unknown age", () => {
    expect(startFast(minor)).toEqual({ kind: "refused" });
    expect(listFasts(minor)).toHaveLength(0);
    expect(fastingAvailable(minor)).toBe(false);

    const unknown = makeProfile("unknown-age-fast");
    expect(fastingAvailable(unknown)).toBe(true);
    expect(startFast(unknown).kind).toBe("started");
  });

  it("lets a newly restricted profile end, but never recreate, its active fast", () => {
    // The realistic history: the fast is started while the age is unknown, and a
    // birthdate edit later makes the profile restricted. Without the exemption this row
    // would be permanently un-closable — and its food nudges permanently stood down.
    const profile = makeProfile("became-minor");
    const started = startFast(profile, new Date(Date.now() - 3_600_000));
    const id = started.kind === "started" ? started.id : -1;
    setProfileSetting(profile, "age", "15");
    expect(fastingAvailable(profile)).toBe(false);

    const ended = endFast(profile);
    expect(ended.kind).toBe("ended");
    expect(getActiveFast(profile)).toBeNull();
    // Neither a new start nor Undo may recreate active fasting content.
    expect(startFast(profile).kind).toBe("refused");
    expect(reopenFast(profile, id)).toEqual({ kind: "refused" });
    expect(getActiveFast(profile)).toBeNull();
    // Discard's refusal is state-based: this row is already history.
    expect(discardFast(profile, id)).toEqual({ kind: "already-ended", id });
  });

  // The discard exemption itself, on the row it actually applies to: a RUNNING fast on a
  // profile that has since become restricted. This is the assertion the completed-row
  // case above used to stand in for.
  it("lets a restricted profile discard the fast it is still running", () => {
    const profile = makeProfile("became-minor-discard");
    const started = startFast(profile, new Date(Date.now() - 3_600_000));
    const id = started.kind === "started" ? started.id : -1;
    setProfileSetting(profile, "age", "15");
    expect(fastingAvailable(profile)).toBe(false);
    expect(discardFast(profile, id)).toEqual({ kind: "discarded", id });
    expect(listFasts(profile)).toHaveLength(0);
  });

  // R3 — WHAT THE EDIT'S GATE ACTUALLY COSTS, PINNED SO IT CANNOT BE CLAIMED AWAY. A
  // revision of lib/fast-write.ts's header argued the gate was free because a restricted
  // profile is drawn no history. This case captures the cost: the mandated close-out on
  // a fast the clock grew past FAST_MAX_HOURS mints the #2993 artifact — a permanent
  // over-long recorded row — and every correcting core then refuses it.
  //
  // This is NOT asserting the outcome is right. It is recording, executably, that the
  // residue exists and what its shape is, because the alternatives (ungate the edit, or
  // draw history on the close-out surface) each undo a #2756 ruling and the choice is the
  // owner's. If a later change closes it, this test is what will go red and name it.
  it("leaves a restricted profile's over-long close-out row correctable by nobody", () => {
    const profile = makeProfile("became-minor-residue");
    db.prepare(
      "INSERT INTO fasts (profile_id, started_at, ended_at) VALUES (?, ?, NULL)"
    ).run(
      profile,
      utcInstant(new Date(Date.now() - (FAST_MAX_HOURS + 72) * 3_600_000))
    );
    setProfileSetting(profile, "age", "15");

    // The exempt close-out lands, as the ruling requires — and records 408 h.
    const ended = endFast(profile);
    expect(ended.kind).toBe("ended");
    expect(getActiveFast(profile)).toBeNull();
    expect(startFast(profile).kind).toBe("refused");
    const id = ended.kind === "ended" ? ended.id : -1;
    const row = listFasts(profile)[0];
    const start = parseUtcSql(row.started_at);
    const end = parseUtcSql(row.ended_at);
    expect(end!.getTime() - start!.getTime()).toBeGreaterThan(
      FAST_MAX_HOURS * 3_600_000
    );

    // And nothing this module offers will correct it for that profile.
    expect(
      editFast(profile, id, undefined, new Date(Date.now() - 3_600_000))
    ).toEqual({ kind: "refused" });
    expect(reopenFast(profile, id)).toEqual({ kind: "refused" });
    expect(discardFast(profile, id)).toEqual({ kind: "already-ended", id });
    // The row survives every one of those refusals intact.
    expect(listFasts(profile)).toHaveLength(1);
  });
});

describe("the annotation reads real food rows and offers no verdict", () => {
  it("counts only servings with a STATED eating instant inside the interval", () => {
    const other = makeProfile("other-food", 30);
    const day = today(adult);
    const start = new Date(Date.now() - 6 * 3_600_000);
    startFast(adult, start);

    // Inside the interval, with a stated eating time.
    logFoodServingCore(adult, "legumes", day, "page", undefined, {
      eatenAt: utcInstant(new Date(Date.now() - 4 * 3_600_000)),
      source: "stated",
    });
    // Inside the interval, but no stated eating time — proves nothing about WHEN, so it
    // is not counted. Silence here is honest.
    logFoodServingCore(adult, "legumes", day, "page");
    // The same stated instant on another profile is also outside this fast's scope.
    logFoodServingCore(
      other,
      "legumes",
      today(other),
      "page",
      undefined,
      {
        eatenAt: utcInstant(new Date(Date.now() - 4 * 3_600_000)),
        source: "stated",
      }
    );

    const ended = endFast(adult);
    expect(ended.kind).toBe("ended");
    const fast = listFasts(adult)[0];
    expect(getServingsDuringFast(adult, fast)).toBe(1);
    // The fast still stands, and so do the servings: both facts, no adjudication.
    expect(fast.ended_at).not.toBeNull();
  });
});

// #2757 over real rows: the stand-down follows the fast's actual state and heals itself
// the moment it ends, because nothing is stored.
describe("the stand-down over real state (#2757)", () => {
  it("stands down only the food nudge while active, then resumes it", () => {
    expect(standsDownForFast(getActiveFast(adult), "food", new Date())).toBe(
      false
    );
    startFast(adult, new Date(Date.now() - 3_600_000));
    const active = getActiveFast(adult);
    expect(standsDownForFast(active, "food", new Date())).toBe(true);
    expect(standsDownForFast(active, "dose", new Date())).toBe(false);
    expect(standsDownForFast(active, "escalation", new Date())).toBe(false);
    expect(standsDownForFast(active, "redose", new Date())).toBe(false);
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

  // The OFFER half, at the gather that actually decides it. The dashboard control and
  // the log-sheet context row both render from `getUsualRoutineOffer`, so this is the
  // one place the stand-down has to hold — and it holds BEFORE the food gather runs, so
  // a fasting profile pays for no reads at all.
  it("withdraws the usual-routine offer without blocking food logging", () => {
    const day = today(adult);
    // Whatever the offer would be for this profile, an active fast makes it null …
    startFast(adult, new Date(Date.now() - 3_600_000));
    for (const window of ["Morning", "Midday", "Evening"] as const) {
      expect(getUsualRoutineOffer(adult, window, day)).toBeNull();
    }
    // The stand-down withdraws the offer, never the ability to record what was eaten.
    expect(logFoodServingCore(adult, "legumes", day, "page").kind).toBe(
      "logged"
    );
    // … and ending the fast restores whatever it was, with nothing to sweep. (This
    // seeded profile has no habitual food history, so the restored answer is also null;
    // what is proved here is that the stand-down does not persist past the fast.)
    endFast(adult);
    expect(getActiveFast(adult)).toBeNull();
  });
});

// ── The portable export (#465/#2129) ────────────────────────────────────────────
//
// Registering `fasts` in OWNED_TABLES makes the export-completeness binding ask the
// question this PR had not answered, and the answer is that fasting rows travel. The
// agreement test proves the DECISION was made; this proves the dataset's SQL actually
// runs against the real schema and is profile-scoped, which nothing else executes.
describe("the fasting log exports (#2756)", () => {
  it("rows/page/count agree, are scoped, and the CSV carries the declared columns", () => {
    const mine = makeProfile("Export Mine", 40);
    const other = makeProfile("Export Other", 40);

    const hour = 3_600_000;
    const now = Date.now();
    seedCompleted(mine, 30, 14);
    startFast(mine, new Date(now - 2 * hour));
    seedCompleted(other, 50, 40);

    const ds = getDataset("fasts")!;
    expect(ds.table).toBe("fasts");
    expect(ds.deletable).not.toBe(false);

    const rows = ds.rows(mine);
    expect(rows).toHaveLength(2);
    expect(ds.count(mine)).toBe(rows.length);
    expect(ds.page(mine, 25, 0)).toEqual(rows);
    // Newest-started first, and the ACTIVE fast (no end) exports with a null `ended_at`
    // rather than being dropped — an unfinished fast is still on the record.
    expect(rows[0].ended_at).toBeNull();
    expect(rows[1].ended_at).not.toBeNull();

    // Scoped: the other profile's fast is not in this profile's export, in either
    // direction, and the write-stamp column stays out of the bundle.
    expect(ds.rows(other)).toHaveLength(1);
    for (const r of [...rows, ...ds.rows(other)])
      expect(r).not.toHaveProperty("end_written_at");

    const csv = toCsv(ds.columns, rows).trimEnd().split("\n");
    expect(csv[0]).toBe("started_at,ended_at,note,created_at");
    expect(csv).toHaveLength(rows.length + 1);
  });
});
