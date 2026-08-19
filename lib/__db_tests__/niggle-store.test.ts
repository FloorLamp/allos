// DB INTEGRATION TIER — the niggle store's one transition (issue #2948 part 1).
//
// What is pinned here and not in the pure tier: the compare-and-set that holds "at most
// one LIVE niggle per (profile, region, laterality)", the NULL-side matching that makes
// it hold for an unstated side, the profile scoping, and the ownership re-check on the
// source activity.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getLiveNiggles, getNiggles, reportNiggle } from "@/lib/niggle-store";
import { NIGGLE_QUIET_DAYS } from "@/lib/niggle-model";

const DAY_MS = 86_400_000;
const at = (dayOffset: number) =>
  new Date(Date.UTC(2026, 7, 1) + dayOffset * DAY_MS)
    .toISOString()
    .slice(0, 19) + "Z";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function makeActivity(profileId: number, notes: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, notes)
         VALUES (?, '2026-08-01', 'strength', 'Leg day', ?)`
      )
      .run(profileId, notes).lastInsertRowid
  );
}

describe("reportNiggle", () => {
  it("creates a niggle linked to the activity its note came from", () => {
    const p = makeProfile("Niggle Create");
    const a = makeActivity(p, "right knee weird");
    const out = reportNiggle(
      p,
      {
        region: "Legs",
        laterality: "right",
        bodyTerm: "knee",
        sourceActivityId: a,
      },
      at(0)
    );
    expect(out).toMatchObject({ ok: true, kind: "created" });

    const rows = getNiggles(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      region: "Legs",
      laterality: "right",
      bodyTerm: "knee",
      sourceActivityId: a,
      reportedAt: at(0),
      lastReportedAt: at(0),
    });
  });

  it("re-reports the live row instead of minting a second one", () => {
    const p = makeProfile("Niggle Re-report");
    reportNiggle(p, { region: "Legs", laterality: "right" }, at(0));
    const again = reportNiggle(
      p,
      { region: "Legs", laterality: "right" },
      at(3)
    );
    expect(again).toMatchObject({ ok: true, kind: "re-reported" });

    const rows = getNiggles(p);
    expect(rows).toHaveLength(1);
    // The clock advances; the FIRST report stands, so the pair still reads as how long
    // this has been going on.
    expect(rows[0].lastReportedAt).toBe(at(3));
    expect(rows[0].reportedAt).toBe(at(0));
  });

  it("advancing the clock keeps the niggle live past its original expiry", () => {
    const p = makeProfile("Niggle Clock");
    reportNiggle(p, { region: "Legs", laterality: "right" }, at(0));
    reportNiggle(p, { region: "Legs", laterality: "right" }, at(3));
    // Day 14 would have expired the ORIGINAL report; the re-report moved the window.
    expect(getLiveNiggles(p, at(NIGGLE_QUIET_DAYS))).toHaveLength(1);
    expect(getLiveNiggles(p, at(NIGGLE_QUIET_DAYS + 3))).toHaveLength(0);
  });

  it("a quiet niggle expires without anything running, and its row survives", () => {
    const p = makeProfile("Niggle Quiet");
    reportNiggle(p, { region: "Glutes", laterality: "left" }, at(0));
    expect(getLiveNiggles(p, at(NIGGLE_QUIET_DAYS - 1))).toHaveLength(1);
    expect(getLiveNiggles(p, at(NIGGLE_QUIET_DAYS))).toHaveLength(0);
    // Expiry is a read-time derivation, never a delete: the history stays.
    expect(getNiggles(p)).toHaveLength(1);
  });

  it("re-reporting after expiry starts a NEW niggle rather than resurrecting one", () => {
    const p = makeProfile("Niggle Restart");
    reportNiggle(p, { region: "Legs", laterality: "right" }, at(0));
    const out = reportNiggle(
      p,
      { region: "Legs", laterality: "right" },
      at(NIGGLE_QUIET_DAYS + 1)
    );
    expect(out).toMatchObject({ ok: true, kind: "created" });
    expect(getNiggles(p)).toHaveLength(2);
    expect(getLiveNiggles(p, at(NIGGLE_QUIET_DAYS + 1))).toHaveLength(1);
  });

  it("matches an UNSTATED side to itself, not to a stated one", () => {
    const p = makeProfile("Niggle Sides");
    reportNiggle(p, { region: "Legs", laterality: null }, at(0));
    // Same region, side now stated: a different amount of knowledge, so a new row.
    expect(
      reportNiggle(p, { region: "Legs", laterality: "right" }, at(1))
    ).toMatchObject({ kind: "created" });
    // Unstated again: must find its own live row rather than minting a duplicate — the
    // `laterality IS ?` half of the compare-and-set.
    expect(
      reportNiggle(p, { region: "Legs", laterality: null }, at(2))
    ).toMatchObject({ kind: "re-reported" });
    expect(getNiggles(p)).toHaveLength(2);
  });

  it("scopes every read and write to the profile", () => {
    const mine = makeProfile("Niggle Mine");
    const theirs = makeProfile("Niggle Theirs");
    reportNiggle(mine, { region: "Legs", laterality: "right" }, at(0));
    expect(getNiggles(theirs)).toHaveLength(0);
    // Same key on another profile is a separate niggle, not a re-report.
    expect(
      reportNiggle(theirs, { region: "Legs", laterality: "right" }, at(0))
    ).toMatchObject({ kind: "created" });
  });

  it("refuses a source activity belonging to another profile", () => {
    const mine = makeProfile("Niggle Owner");
    const theirs = makeProfile("Niggle Intruder");
    const theirActivity = makeActivity(theirs, "right knee weird");
    expect(
      reportNiggle(
        mine,
        { region: "Legs", sourceActivityId: theirActivity },
        at(0)
      )
    ).toEqual({ ok: false, reason: "not-owned" });
    expect(getNiggles(mine)).toHaveLength(0);
  });

  it("refuses a region outside the injury vocabulary", () => {
    const p = makeProfile("Niggle Vocabulary");
    expect(reportNiggle(p, { region: "Kneecaps" as never }, at(0))).toEqual({
      ok: false,
      reason: "invalid-region",
    });
    expect(getNiggles(p)).toHaveLength(0);
  });

  it("stores a source exercise as its canonical identity, never a raw label", () => {
    const p = makeProfile("Niggle Exercise");
    reportNiggle(p, { region: "Legs", sourceExercise: "Back Squat" }, at(0));
    expect(getNiggles(p)[0].sourceExercise).toBe("back squat");
  });
});
