// SERVER-ACTION TIER — the Bristol stool-form tap (#2785) and the "Happened earlier?"
// statement it gained in #3273.
//
// The write core's grain is pinned at the DB tier (bristol-stool-write.test.ts). What
// only this tier can see is the ACTION's decision about the optional `at` field, and
// the property that decision has to hold: a tap that says nothing must write the row
// it wrote before the affordance existed — same day, same second-grain key, same
// additive semantics. A test that only exercised the stated path could not tell a
// working `at` from one that had quietly started stamping every tap.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { logStoolForm } from "@/app/(app)/stool-actions";
import { logBristolStool } from "@/lib/offline/writes";
import { BRISTOL_STOOL_METRIC } from "@/lib/bristol-stool";
import { createLogin, createProfile, actAs, fd } from "./harness";

// Frozen so "the row an unstated tap writes" is a single comparable value: the seam
// is what the write core reads for both the wall minute and the SECONDS, and the
// seconds are the part the key is built on. :07, deliberately not :00 — a stated time
// lands on :00, so a zero here would make the two paths indistinguishable.
const NOW_ISO = "2026-07-08T21:30:07Z";
let priorNow: string | undefined;
beforeEach(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = NOW_ISO;
  return () => {
    if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
    else process.env.ALLOS_TEST_NOW = priorNow;
  };
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
    expect(await logStoolForm(fd({ type: 4 }))).toEqual({
      ok: true,
      type: 4,
      todayCount: 1,
    });
    // …and the call the action made before #3273 added the parameter, on a second
    // profile at the same frozen instant.
    expect(logBristolStool(control.id, date, 4)).toBe(true);

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
      todayCount: 2,
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
