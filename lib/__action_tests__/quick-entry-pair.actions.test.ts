// SERVER-ACTION TIER — the two quick-entry surfaces added in #1525 and #1633.
//
// What matters here is that neither surface grew a write path of its own:
//   - loadQuickEntry("practice") gathers the SAME tracked-practice standing the
//     Wellness page reads, per acting profile, and answers honestly when there is
//     none — it is also the list the command palette matches typed input against;
//   - loadQuickEntry("document") only reports the demo gate the Data page applies;
//   - paletteQuickLog re-parses AUTHORITATIVELY: an untracked name can never be
//     written (the finite preimage), a tracked one goes through the same logPractice
//     action the card's button posts, and the weight command is untouched;
//   - a read-only grant writes nothing.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { loadQuickEntry } from "@/app/(app)/quick-entry-actions";
import { paletteQuickLog } from "@/app/(app)/palette-actions";
import { practiceIdentity } from "@/lib/practice";
import { createLogin, createProfile, actAs, seedActor } from "./harness";

function trackPractice(
  profileId: number,
  name: string,
  floor = 3,
  ceiling: number | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week, per_week_max)
         VALUES (?, 'practice', ?, ?, ?, ?)`
      )
      .run(profileId, name, practiceIdentity(name), floor, ceiling)
      .lastInsertRowid
  );
}

function practiceRows(profileId: number): { practice: string; date: string }[] {
  return db
    .prepare(
      "SELECT practice, date FROM practice_logs WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as { practice: string; date: string }[];
}

describe("loadQuickEntry — practice (#1633)", () => {
  it("offers the acting profile's tracked practices with their week standing", async () => {
    const { profile } = seedActor({ profileName: "Practice Subject" });
    trackPractice(profile.id, "Sauna", 3, 5);
    trackPractice(profile.id, "Meditation", 5, null);
    // A session logged under a DIFFERENT spelling still counts: identity folding is
    // the one practiceIdentity every surface keys on.
    db.prepare(
      "INSERT INTO practice_logs (profile_id, practice, date) VALUES (?, 'sauna', ?)"
    ).run(profile.id, today(profile.id));

    const data = await loadQuickEntry("practice");
    expect(data.form).toBe("practice");
    if (data.form !== "practice") return;
    // Alphabetical, one row per identity, named by the TARGET's spelling.
    expect(data.practices.map((p) => p.name)).toEqual(["Meditation", "Sauna"]);
    const sauna = data.practices.find((p) => p.identity === "sauna")!;
    expect(sauna).toMatchObject({
      perWeek: 3,
      perWeekMax: 5,
      countThisWeek: 1,
      todayCount: 1,
      atCeiling: false,
    });
    expect(data.practices[0]).toMatchObject({ todayCount: 0, perWeek: 5 });
  });

  it("says so instead of offering an empty list", async () => {
    seedActor({ profileName: "No Practices" });
    const data = await loadQuickEntry("practice");
    expect(data.form).toBe("unavailable");
    if (data.form !== "unavailable") return;
    expect(data.message).toMatch(/Wellness/);
  });

  it("never leaks another profile's practices", async () => {
    const admin = createLogin({ role: "admin" });
    const mine = createProfile("Mine");
    const theirs = createProfile("Theirs");
    trackPractice(theirs.id, "Cold plunge");
    actAs(admin, mine);

    expect((await loadQuickEntry("practice")).form).toBe("unavailable");

    actAs(admin, theirs);
    const data = await loadQuickEntry("practice");
    expect(data.form).toBe("practice");
    if (data.form !== "practice") return;
    expect(data.practices.map((p) => p.name)).toEqual(["Cold plunge"]);
  });
});

describe("loadQuickEntry — document (#1525)", () => {
  it("gathers only the demo gate — the upload form needs nothing else", async () => {
    seedActor({ profileName: "Uploader" });
    const data = await loadQuickEntry("document");
    expect(data).toEqual({ form: "document", demo: false });
  });
});

describe("paletteQuickLog — practices (#1633)", () => {
  it("logs a tracked practice through the shared action and reports the count", async () => {
    const { profile } = seedActor({ profileName: "Palette Practice" });
    trackPractice(profile.id, "Sauna", 3, null);

    const first = await paletteQuickLog("log sauna");
    expect(first).toEqual({ ok: true, message: "Logged today's session" });
    // A second deliberate tap is a second session, and says so — a practice log is
    // not idempotent.
    const second = await paletteQuickLog("did SAUNA");
    expect(second).toEqual({ ok: true, message: "Logged — 2 sessions today" });

    const rows = practiceRows(profile.id);
    expect(rows).toHaveLength(2);
    // The TARGET's spelling is written, not what was typed, so the quick log lands in
    // the family the Wellness card counts.
    expect(rows.every((r) => r.practice === "Sauna")).toBe(true);
    expect(rows.every((r) => r.date === today(profile.id))).toBe(true);
  });

  it("refuses a name this profile does not track — nothing written", async () => {
    const { profile } = seedActor({ profileName: "Finite Preimage" });
    trackPractice(profile.id, "Sauna");

    // The client's list is only a preview; the server re-derives the finite set, so a
    // forged input cannot invent a practice.
    expect(await paletteQuickLog("log breathwork")).toEqual({
      ok: false,
      message: "Unrecognized quick log.",
    });
    // Synonyms and modalities are deliberately not folded, here as everywhere.
    expect(await paletteQuickLog("log infrared sauna")).toMatchObject({
      ok: false,
    });
    expect(practiceRows(profile.id)).toHaveLength(0);
  });

  it("cannot log another profile's practice", async () => {
    const admin = createLogin({ role: "admin" });
    const mine = createProfile("Mine");
    const theirs = createProfile("Theirs");
    trackPractice(theirs.id, "Cold plunge");
    actAs(admin, mine);

    expect(await paletteQuickLog("log cold plunge")).toMatchObject({
      ok: false,
    });
    expect(practiceRows(mine.id)).toHaveLength(0);
    expect(practiceRows(theirs.id)).toHaveLength(0);
  });

  it("leaves the weight shorthand alone", async () => {
    const { profile } = seedActor({ profileName: "Still Weighing" });
    // A practice named "weight" must not shadow the older, shorter vocabulary.
    trackPractice(profile.id, "Weight");

    const res = await paletteQuickLog("weight 82.5");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("82.5");
    expect(practiceRows(profile.id)).toHaveLength(0);
    const weights = db
      .prepare("SELECT weight_kg FROM body_metrics WHERE profile_id = ?")
      .all(profile.id) as { weight_kg: number }[];
    expect(weights).toHaveLength(1);

    // …and the practice of that name is still loggable behind the verb.
    expect(await paletteQuickLog("log weight")).toMatchObject({ ok: true });
    expect(practiceRows(profile.id).map((r) => r.practice)).toEqual(["Weight"]);
  });

  it("a read-only grant cannot quick-log at all", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("RO Subject", login.id);
    trackPractice(profile.id, "Sauna");
    actAs(login, profile, "read");

    await expect(paletteQuickLog("log sauna")).rejects.toThrow(/read-only/);
    await expect(paletteQuickLog("weight 80")).rejects.toThrow(/read-only/);
    expect(practiceRows(profile.id)).toHaveLength(0);
  });
});
