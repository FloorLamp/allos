// SERVER-ACTION TIER — the Bristol stool-form tap (#2785) and the "Happened earlier?"
// statement it gained in #3273.
//
// The write core's grain is pinned at the DB tier (bristol-stool-write.test.ts). What
// only this tier can see is the ACTION's decision about the optional `at` field, and
// the property that decision has to hold: a tap that says nothing must write the row
// it wrote before the affordance existed — same day, same second-grain key, same
// additive semantics. A test that only exercised the stated path could not tell a
// working `at` from one that had quietly started stamping every tap.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { loadStoolDay, logStoolForm } from "@/app/(app)/stool-actions";
import { logBristolStool } from "@/lib/offline/writes";
import { BRISTOL_STOOL_METRIC } from "@/lib/bristol-stool";
import { createLogin, createProfile, actAs, fd } from "./harness";

// Frozen so "the row an unstated tap writes" is a single comparable value: the seam
// is what the write core reads for both the wall minute and the SECONDS, and the
// seconds are the part the key is built on. :07, deliberately not :00 — a stated time
// lands on :00, so a zero here would make the two paths indistinguishable.
const NOW_ISO = "2026-07-08T21:30:07Z";

beforeEach(() => {
  vi.setSystemTime(new Date(NOW_ISO));
});

function rows(profileId: number) {
  return db
    .prepare(
      `SELECT source, metric, date, started_at, ended_at, value
         FROM metric_samples WHERE profile_id = ? AND metric = ?
        ORDER BY started_at`
    )
    .all(profileId, BRISTOL_STOOL_METRIC);
}

describe("logStoolForm — the unstated tap is unchanged (#3273)", () => {
  it("writes the same row the pre-affordance call writes, field for field", async () => {
    const login = createLogin();
    const profile = createProfile("unstated-tap", login.id);
    actAs(login, profile);
    const control = createProfile("control-tap", login.id);
    const date = today(profile.id);

    // The path the form takes when nobody opens "Happened earlier?": no `at` field on
    // the post at all.
    // EXACT, so a field added to this answer has to be looked at rather than
    // absorbed. Since #5663 the answer also carries the day's receipt rows and which
    // of them the tap landed on — a wider ANSWER over a byte-identical ROW, which is
    // what the comparison below is about.
    expect(await logStoolForm(fd({ type: 4 }))).toEqual({
      ok: true,
      type: 4,
      dayCount: 1,
      reading: { id: expect.any(Number) },
      readings: [{ id: expect.any(Number), type: 4, hhmm: "21:30" }],
    });
    // …and the call the action made before #3273 added the parameter, on a second
    // profile at the same frozen instant.
    expect(logBristolStool(control.id, date, 4)).toEqual({ wrote: true });

    const [tapped] = rows(profile.id);
    const [before] = rows(control.id);
    expect(tapped).toEqual(before);
    // Spelled out too, because "equal to the control" is only as strong as the
    // control: the seam's SECONDS survive, which is the second-grain key itself.
    expect(tapped).toMatchObject({
      date,
      started_at: `${date}T21:30:07`,
      ended_at: `${date}T21:30:07`,
      value: 4,
    });
  });

  // The field's ABSENCE and its EMPTINESS must land on the same path — a control that
  // renders but is never touched posts nothing, and a post that carried an empty
  // string must not be read as "stated nothing at 00:00".
  it.each([
    ["absent", {}],
    ["empty", { at: "" }],
    ["whitespace", { at: "   " }],
  ])("%s `at` takes the clock-seam path", async (_name, extra) => {
    const login = createLogin();
    const profile = createProfile(`at-${_name}`, login.id);
    actAs(login, profile);
    const date = today(profile.id);

    expect(await logStoolForm(fd({ type: 2, ...extra }))).toMatchObject({
      ok: true,
    });
    expect(rows(profile.id)[0]).toMatchObject({
      started_at: `${date}T21:30:07`,
    });
  });
});

describe("logStoolForm — a stated earlier time writes THAT instant (#3273)", () => {
  it("files the stated wall minute, on the day the tap files under", async () => {
    const login = createLogin();
    const profile = createProfile("stated-tap", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    expect(await logStoolForm(fd({ type: 3, at: "07:05" }))).toMatchObject({
      ok: true,
      type: 3,
    });

    expect(rows(profile.id)).toEqual([
      {
        source: "manual",
        metric: BRISTOL_STOOL_METRIC,
        date,
        // :00 — a stated wall time carries no seconds, so restating the same minute
        // CORRECTS that reading rather than inventing a second movement.
        started_at: `${date}T07:05:00`,
        ended_at: `${date}T07:05:00`,
        value: 3,
      },
    ]);
    // The day is the ACTION's `today`, never the client's: the control's day is fixed
    // to today, so a statement can only move the minute.
    expect(rows(profile.id)[0]).toMatchObject({ date: today(profile.id) });
  });

  it("stays ADDITIVE across statements — two minutes are two rows", async () => {
    const login = createLogin();
    const profile = createProfile("additive-stated", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    await logStoolForm(fd({ type: 2, at: "08:12" }));
    await logStoolForm(fd({ type: 6, at: "19:40" }));
    const stored = rows(profile.id) as { started_at: string; value: number }[];
    expect(stored.map((r) => r.started_at)).toEqual([
      `${date}T08:12:00`,
      `${date}T19:40:00`,
    ]);
    expect(stored.map((r) => r.value)).toEqual([2, 6]);
    expect(await logStoolForm(fd({ type: 6, at: "19:40" }))).toMatchObject({
      dayCount: 2,
    });
  });

  it("a malformed statement costs the STATEMENT, never the reading", async () => {
    const login = createLogin();
    const profile = createProfile("garbage-at", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    expect(await logStoolForm(fd({ type: 5, at: "half past" }))).toMatchObject({
      ok: true,
      type: 5,
    });
    // The reading lands, on the clock seam — the same posture the food log takes.
    expect(rows(profile.id)[0]).toMatchObject({
      started_at: `${date}T21:30:07`,
      value: 5,
    });
  });
});

describe("logStoolForm — scoping and the vocabulary guard", () => {
  it("writes against the ACTING profile and refuses a type off the scale", async () => {
    const login = createLogin();
    const profile = createProfile("scoped", login.id);
    const other = createProfile("other", login.id);
    actAs(login, profile);

    await logStoolForm(fd({ type: 1, at: "06:00" }));
    expect(rows(other.id)).toHaveLength(0);
    expect(await logStoolForm(fd({ type: 8, at: "06:00" }))).toEqual({
      ok: false,
      error: "Pick a type from 1 to 7.",
    });
    expect(rows(profile.id)).toHaveLength(1);
    // The seam is what the row was written against, so the fixture's own reading of
    // it is the same instant the action used.
    expect(clockNow().toISOString()).toBe(new Date(NOW_ISO).toISOString());
  });
});

// THE DATED MOUNT'S DAY (#4433 / #4424's date context). The action used to re-derive
// `today(profile.id)` and drop any posted date on the floor, so the record's door could
// stand on Monday and file Wednesday's row. What only this tier can see is that the
// posted day REACHES the core — and that the fast path is unchanged: no `date` field
// still means the profile's today, which is what keeps the sheet's tap byte-identical.
describe("logStoolForm — the posted day (#4433)", () => {
  const day = (offset: number) =>
    new Date(new Date(NOW_ISO).getTime() + offset * 86_400_000)
      .toISOString()
      .slice(0, 10);

  it.each([
    ["a week back", day(-7), true],
    ["yesterday", day(-1), true],
    ["today, posted", day(0), true],
    // The shared never-the-future invariant, reported in words rather than as a retry.
    ["tomorrow", day(1), false],
    // Not a day the calendar has. It is not a refusal here: the action cannot tell a
    // crafted string from an absent field, so it falls back to today exactly as an
    // unstated post does — and `isPastWriteAccepted` would refuse it in the core.
    ["a day that does not exist", "2026-02-30", true],
  ])("%s (%s) → ok=%s", async (_label, date, ok) => {
    const login = createLogin();
    const profile = createProfile(`posted-${date}`, login.id);
    actAs(login, profile);

    const outcome = await logStoolForm(fd({ type: 4, date }));
    expect(outcome.ok).toBe(ok);
    if (!ok) {
      expect(outcome).toEqual({
        ok: false,
        error: "That day hasn't happened yet.",
      });
      expect(rows(profile.id)).toHaveLength(0);
      return;
    }
    const landed = date === "2026-02-30" ? today(profile.id) : date;
    expect(rows(profile.id)).toMatchObject([{ date: landed }]);
    // The count answers for THE DAY IT WROTE TO, which on a backfill is not today.
    expect(outcome).toMatchObject({ dayCount: 1 });
  });

  it("leaves the unstated post on the profile's today", async () => {
    const login = createLogin();
    const profile = createProfile("no-date-posted", login.id);
    actAs(login, profile);

    await logStoolForm(fd({ type: 4 }));
    expect(rows(profile.id)).toMatchObject([{ date: today(profile.id) }]);
  });
});

// ── THE DAY READ, UNDER THE REAL GATE (#5663) ────────────────────────────────
//
// `loadStoolDay` is the ONE surface in this domain that hands back a LIST of a
// person's readings, and it is the only new one this issue adds. Everywhere else the
// sheet shows a number.
//
// WHICH IS WHY IT IS ASKED HERE RATHER THAN LEFT TO THE STATIC SCAN. The write-access
// census proves a TEXT fact — that `gateItemProfile(` appears in the body — and that
// is all a regex can prove. It cannot see whether the rows the function answers with
// are scoped by what the gate RETURNED, and a read that gates the subject and then
// lists the acting profile's day would satisfy it completely. Every other reference to
// this function in the repo is a mock; this is where it actually runs.
//
// The refusals are asserted by their own words (the tier's auth double mirrors prod's
// two refusal branches) rather than as a bare throw, so a function that fails for some
// third reason cannot pass as a gate.
describe("loadStoolDay — the day it lists is the day it was gated for (#5663)", () => {
  function seedReading(
    profileId: number,
    date: string,
    hhmm: string,
    value: number
  ): number {
    return Number(
      db
        .prepare(
          `INSERT INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
             VALUES (?, 'manual', ?, ?, ?, ?, ?)`
        )
        .run(
          profileId,
          BRISTOL_STOOL_METRIC,
          date,
          `${date}T${hhmm}:00`,
          `${date}T${hhmm}:00`,
          value
        ).lastInsertRowid
    );
  }

  it("refuses a subject this login cannot reach, and one it may only read", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("day-read-acting", login.id);
    const ungranted = createProfile("day-read-ungranted");
    const readOnly = createProfile("day-read-readonly");
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
    ).run(login.id, readOnly.id);
    actAs(login, acting);
    const date = today(acting.id);
    seedReading(ungranted.id, date, "07:05", 4);
    seedReading(readOnly.id, date, "07:05", 4);

    await expect(
      loadStoolDay(fd({ profile_id: ungranted.id, date }))
    ).rejects.toThrow(/not accessible/);
    // A READ-ONLY grant is refused too. That is the gate this domain already uses for
    // its writes, taken deliberately rather than loosened for a read: the sheet mounts
    // this control to LOG for the subject, and a row list is the receipt for that.
    await expect(
      loadStoolDay(fd({ profile_id: readOnly.id, date }))
    ).rejects.toThrow(/read-only on target/);
  });

  it("answers with ONLY the gated subject's rows, on a day three profiles share", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("day-read-me", login.id);
    const subject = createProfile("day-read-subject", login.id);
    const stranger = createProfile("day-read-stranger");
    actAs(login, acting);
    const date = today(acting.id);
    // THE SAME DAY AND THE SAME MINUTE for all three, so nothing but the profile
    // scope can tell the three rows apart: a read that answered from the acting
    // profile, or from no scope at all, returns a different set here and says so.
    const theirs = seedReading(subject.id, date, "07:05", 4);
    seedReading(stranger.id, date, "07:05", 2);
    seedReading(acting.id, date, "07:05", 1);

    const day = await loadStoolDay(fd({ profile_id: subject.id, date }));
    expect(day.readings).toEqual([{ id: theirs, type: 4, hhmm: "07:05" }]);
    expect(day.dayCount).toBe(1);
  });

  it("falls back to the ACTING profile when no subject is posted, and when one is not a subject", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("day-read-fallback", login.id);
    const other = createProfile("day-read-other", login.id);
    actAs(login, acting);
    const date = today(acting.id);
    const mine = seedReading(acting.id, date, "08:00", 5);
    seedReading(other.id, date, "08:00", 6);

    // The sheet's own mount, which posts no subject at all.
    expect((await loadStoolDay(fd({ date }))).readings).toEqual([
      { id: mine, type: 5, hhmm: "08:00" },
    ]);
    // …and a posted field that names no profile. THE ANSWER FOLLOWS THE GATE, NOT THE
    // FIELD, and the two only come apart here: `gateItemProfile` reads any
    // non-positive `profile_id` as absent and returns the acting profile, so a read
    // that consulted the posted value itself would scope to a profile that does not
    // exist and hand back an empty day.
    //
    // BOTH SPELLINGS OF "not a profile", because they fail differently. A zero is
    // falsy, so a `Number(posted) || gated` mutation still lands on the gate's answer
    // and passes; a NEGATIVE id is truthy and is what separates the two readers. That
    // is not hypothetical — the zero case alone left exactly that mutation alive.
    for (const notAProfile of [0, -1])
      expect(
        (await loadStoolDay(fd({ profile_id: notAProfile, date }))).readings,
        `profile_id=${notAProfile}`
      ).toEqual([{ id: mine, type: 5, hhmm: "08:00" }]);
  });
});
