// THE HOUSEHOLD STRIP'S CHIP INTEGER (issue #2110).
//
// app/(app)/page.tsx builds the strip by mapping householdFanoutProfiles() through
// attentionCountForProfile() and keeping the chips with count > 0. #2110 asked for
// that per-member gather to be made cheaper, and recorded the trap: every cheap
// SUBSET of the model (collectHouseholdRollup and friends) returns a DIFFERENT
// integer, so a faster chip showing a different number is a regression with better
// latency, not a fix. The chosen answer keeps the model whole and cuts what the
// gather COMPILES (hoistedStatement), which cannot move the number — and this file
// is what holds that claim to account.
//
// Two halves:
//   1. the chip integer IS the member's own hero count, on a realistic multi-member
//      fixture with EXACT expected integers, plus the two cases where an off-by-one
//      hides: a member with NOTHING (0, chip filtered out) and a one-other-member
//      household (a single chip, no aggregation to hide behind);
//   2. the #885-shaped statement pin: the reads hoisted for this issue compile ONCE
//      per connection, not once per member, so adding a member to the strip adds no
//      SQL compilation for them.
//
// All fixture data is obviously fictional — no real PHI.

import { describe, it, expect, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  attentionCountForProfile,
  collectAttentionModel,
} from "@/lib/queries/attention";
import { attentionCardItems } from "@/lib/attention";
import { householdFanoutProfiles } from "@/lib/household-fanout";

// A fixture profile that starts at a TRUE zero. A brand-new profile is not quiet:
// the immunization generator recommends seasonal flu + COVID to any adult, so a
// fixture that skipped this would pin integers that drift with the calendar and
// would have no genuinely-zero member to test the chip filter against. Declining
// those two is an ordinary user state expressed in the domain's own vocabulary
// (immunization_overrides), not a test-only escape hatch.
function createProfile(name: string): { id: number; name: string } {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')"
  ).run(id);
  for (const vaccine of ["influenza", "covid"]) {
    db.prepare(
      `INSERT INTO immunization_overrides (profile_id, vaccine, kind)
       VALUES (?, ?, 'declined')`
    ).run(id, vaccine);
  }
  return { id, name };
}

// A currently-flagged lab collected today — an act-now attention signal.
function insertFlaggedLab(profileId: number, canonical: string): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, flag, created_at)
     VALUES (?, ?, 'lab', ?, '999', 'mg/dL', ?, 'high', datetime('now'))`
  ).run(profileId, today(profileId), canonical, canonical);
}

function insertAppointment(
  profileId: number,
  dayOffset: number,
  title: string
): void {
  db.prepare(
    `INSERT INTO appointments (profile_id, date, time_of_day, title, status)
     VALUES (?, ?, '09:00', ?, 'scheduled')`
  ).run(profileId, shiftDateStr(today(profileId), dayOffset), title);
}

// The strip exactly as app/(app)/page.tsx builds it: bounded fan-out, one count per
// member, chips with nothing to say dropped.
function householdStrip(
  accessible: readonly { id: number; name: string }[],
  actingProfileId: number
): { name: string; count: number }[] {
  return householdFanoutProfiles(accessible, actingProfileId)
    .map((p) => ({
      name: p.name,
      count: attentionCountForProfile(p.id, today(p.id)),
    }))
    .filter((entry) => entry.count > 0);
}

// What that member's OWN dashboard hero renders — the number the chip claims to be.
function heroCount(profileId: number): number {
  const on = today(profileId);
  return attentionCardItems(collectAttentionModel(profileId, on), on).length;
}

describe("the household chip integer is the member's own hero count (#2110/#524)", () => {
  it("agrees per member on a realistic household, with the exact integers pinned", () => {
    const acting = createProfile("Fixture Caregiver");
    const withSignals = createProfile("Fixture Member Signals");
    const quiet = createProfile("Fixture Member Quiet");

    // One member carries two act-now signals plus a page-only planning item; the
    // other carries the same page-only item and nothing act-now, so the fixture
    // distinguishes "quiet" from "has nothing at all".
    insertFlaggedLab(withSignals.id, "Ferritin");
    insertAppointment(withSignals.id, -3, "Fixture overdue follow-up");
    insertAppointment(withSignals.id, 45, "Fixture far-future physical");
    insertAppointment(quiet.id, 45, "Fixture far-future physical");

    const accessible = [acting, withSignals, quiet];

    // EXACT integers, not just internal agreement: two act-now items for the first
    // member (the far-future appointment is page-only, #524), none for the second.
    expect(
      attentionCountForProfile(withSignals.id, today(withSignals.id))
    ).toBe(2);
    expect(attentionCountForProfile(quiet.id, today(quiet.id))).toBe(0);

    // And the chip is the hero's own number for every member the strip fans out to.
    for (const member of householdFanoutProfiles(accessible, acting.id)) {
      expect(attentionCountForProfile(member.id, today(member.id))).toBe(
        heroCount(member.id)
      );
    }

    // The rendered strip: the quiet member has no chip at all.
    expect(householdStrip(accessible, acting.id)).toEqual([
      { name: "Fixture Member Signals", count: 2 },
    ]);
  });

  it("a member with NOTHING counts exactly zero (the case an off-by-one hides)", () => {
    const acting = createProfile("Fixture Caregiver Empty");
    const empty = createProfile("Fixture Member Empty");

    // No labs, no appointments, no doses, nothing due.
    expect(collectAttentionModel(empty.id, today(empty.id))).toEqual([]);
    expect(attentionCountForProfile(empty.id, today(empty.id))).toBe(0);
    expect(heroCount(empty.id)).toBe(0);
    // Zero, not "a small number": the strip renders no chip for them.
    expect(householdStrip([acting, empty], acting.id)).toEqual([]);
  });

  it("a household of exactly one other member renders one chip, equal to that member's hero", () => {
    const acting = createProfile("Fixture Caregiver Solo");
    const only = createProfile("Fixture Member Solo");
    insertFlaggedLab(only.id, "Triglycerides");

    // One member, so nothing else can compensate for a wrong number.
    expect(householdStrip([acting, only], acting.id)).toEqual([
      { name: "Fixture Member Solo", count: 1 },
    ]);
    expect(attentionCountForProfile(only.id, today(only.id))).toBe(
      heroCount(only.id)
    );

    // A session that reaches only its own profile fans out to nobody.
    expect(householdFanoutProfiles([acting], acting.id)).toEqual([]);
  });
});

// ---- The cheapness half: hoisted reads compile once, not once per member --------

// Statement counting in the #885 shape: db.prepare() COMPILES, so counting prepares
// of a signature counts COMPILATIONS of the read that owns it. hoistedStatement()
// caches the compiled statement per connection, so a hoisted read prepares on first
// use and never again — while an inline db.prepare(...) prepares on every call.
function countPrepares(...signatures: RegExp[]): { calls: () => number }[] {
  const counts = signatures.map(() => 0);
  const real = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    signatures.forEach((s, i) => {
      if (s.test(sql)) counts[i]++;
    });
    return real(sql);
  }) as typeof db.prepare);
  return signatures.map((_, i) => ({ calls: () => counts[i] }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the fan-out compiles its clinical reads once per connection (#2110)", () => {
  it("adding a member to the strip adds no compilation of the hoisted reads", () => {
    const acting = createProfile("Fixture Caregiver Compile");
    const first = createProfile("Fixture Member Compile One");
    const second = createProfile("Fixture Member Compile Two");
    const third = createProfile("Fixture Member Compile Three");
    // Give them data so the generators actually reach these tables.
    for (const m of [first, second, third]) {
      insertFlaggedLab(m.id, "Ferritin");
      insertAppointment(m.id, -1, "Fixture overdue follow-up");
    }

    // Warm the per-connection statement cache the way the first chip of any render
    // does — this member's gather pays every first compile.
    attentionCountForProfile(first.id, today(first.id));

    const [conditions, allergies, familyHistory, carePlan, flaggedLabs] =
      countPrepares(
        /FROM conditions\s+WHERE profile_id = \? AND id IN/,
        /FROM allergies\s+WHERE profile_id = \? AND id IN/,
        /FROM family_history\s+WHERE profile_id = \? AND id IN/,
        /FROM care_plan_items cp/,
        /AND category = 'lab'\s+AND flag IS NOT NULL/
      );

    // Two MORE members, i.e. the rest of a three-member strip.
    householdStrip([acting, first, second, third], acting.id);

    expect(conditions.calls()).toBe(0);
    expect(allergies.calls()).toBe(0);
    expect(familyHistory.calls()).toBe(0);
    expect(carePlan.calls()).toBe(0);
    expect(flaggedLabs.calls()).toBe(0);
  });
});
