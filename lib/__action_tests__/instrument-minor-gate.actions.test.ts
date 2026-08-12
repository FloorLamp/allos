// SERVER-ACTION TIER — #1279's minor gate holds on SHARED instrument rows (issue #2107).
//
// #1174 hid the substance-use surface from a known minor; #1279 closed the gap under
// it, because a Server Action is independently POST-callable. But the instrument write
// cores serve BOTH catalogs, and update/delete resolve their instrument from the
// TARGETED ROW — so the mental-health twins, which have no life-stage check of their
// own and never needed one, could be posted with a substance-instrument row id and
// would edit or delete exactly the score the substance actions refuse to touch.
//
// The refusal now lives in the core (lib/instrument-records.ts `adultOnlyRefusal`), so
// these drive the MENTAL-HEALTH actions against a substance row on a known-minor
// profile and assert the same "there is nothing here" answer the substance surface
// gives. The three negatives matter as much as the positives: mental-health rows are
// untouched on a minor, and an adult is unaffected on both families.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import {
  updateInstrumentAction,
  deleteInstrumentAction,
} from "@/app/(app)/medical/instruments/actions";
import {
  recordInstrumentScore,
  adultOnlyRefusal,
} from "@/lib/instrument-records";
import { actAs, createLogin, createProfile, fd } from "./harness";
import { setProfileSetting } from "@/lib/settings";

// A profile with a stored age, already acting. 15 → isMinor true (no birthdate
// needed); omit the age for the unknown-age/adult side of each pair.
function actor(slug: string, age?: number) {
  const login = createLogin();
  const profile = createProfile(slug, login.id);
  actAs(login, profile);
  if (age != null) setProfileSetting(profile.id, "age", String(age));
  return profile;
}

function scoreOf(id: number): { date: string; value_num: number } | undefined {
  return db
    .prepare("SELECT date, value_num FROM medical_records WHERE id = ?")
    .get(id) as { date: string; value_num: number } | undefined;
}

// Seed a score BEFORE the profile is known to be a minor — the realistic history for
// a profile whose birthdate is filled in later, and the only way to have a substance
// row on a minor profile at all now that the create path is gated too.
function seedScore(
  profileId: number,
  instrument: "AUDIT" | "PHQ-9",
  total: number
): number {
  const id = recordInstrumentScore(profileId, {
    instrument,
    date: today(profileId),
    total,
  });
  if (id == null) throw new Error("seed refused");
  return id;
}

describe("the mental-health instrument actions can't reach a substance row on a minor (#2107)", () => {
  it("updateInstrumentAction refuses, leaving the score exactly as it was", async () => {
    const profile = actor("mh-minor-update");
    const id = seedScore(profile.id, "AUDIT", 10);
    const before = scoreOf(id);
    setProfileSetting(profile.id, "age", "15");

    const res = await updateInstrumentAction(
      fd({ id, date: "2026-07-01", total: 2 })
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("Couldn't find that score.");
    expect(scoreOf(id)).toEqual(before);
  });

  it("deleteInstrumentAction refuses, leaving the row in place and minting no undo", async () => {
    const profile = actor("mh-minor-delete");
    const id = seedScore(profile.id, "AUDIT", 10);
    setProfileSetting(profile.id, "age", "15");

    expect(await deleteInstrumentAction(fd({ id }))).toEqual({ undoId: null });
    expect(scoreOf(id)).toBeDefined();
  });

  it("still corrects and removes the minor's OWN mental-health scores", async () => {
    const profile = actor("mh-minor-own", 15);
    const id = seedScore(profile.id, "PHQ-9", 8);

    const res = await updateInstrumentAction(
      fd({ id, date: today(profile.id), total: 4 })
    );
    expect(res.ok).toBe(true);
    expect(scoreOf(id)?.value_num).toBe(4);

    const del = await deleteInstrumentAction(fd({ id }));
    expect(del.undoId).not.toBeNull();
    expect(scoreOf(id)).toBeUndefined();
  });

  it("leaves an adult profile's substance row editable from either surface", async () => {
    const profile = actor("mh-adult-substance", 40);
    const id = seedScore(profile.id, "AUDIT", 10);

    const res = await updateInstrumentAction(
      fd({ id, date: today(profile.id), total: 6 })
    );
    expect(res.ok).toBe(true);
    expect(scoreOf(id)?.value_num).toBe(6);
  });
});

describe("the gate sits in the core, so a new caller inherits it (#2107)", () => {
  it("recordInstrumentScore refuses a substance instrument for a known minor", () => {
    const profile = actor("core-minor-record", 15);
    expect(
      recordInstrumentScore(profile.id, {
        instrument: "AUDIT",
        date: today(profile.id),
        total: 12,
      })
    ).toBeNull();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ?"
        )
        .get(profile.id)
    ).toEqual({ n: 0 });
  });

  it("adultOnlyRefusal answers per instrument family and per life stage", () => {
    const minor = actor("gate-minor", 15);
    const adult = actor("gate-adult", 40);
    const unknown = actor("gate-unknown");

    expect(adultOnlyRefusal(minor.id, "AUDIT")).toBe(true);
    expect(adultOnlyRefusal(minor.id, "DAST-10")).toBe(true);
    // Mental-health instruments are NOT adult-only content — the gate must never
    // spread to them, or a teenager loses their own PHQ-9.
    expect(adultOnlyRefusal(minor.id, "PHQ-9")).toBe(false);
    expect(adultOnlyRefusal(adult.id, "AUDIT")).toBe(false);
    // Unknown age passes: lib/life-stage's documented "hide only on a positive
    // under-age match" policy, the same line the surface and #1279 use.
    expect(adultOnlyRefusal(unknown.id, "AUDIT")).toBe(false);
  });
});
