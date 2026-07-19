// DB INTEGRATION TIER — issues #997 (mental-health visit kind + shared-surface
// sensitivity) and #996 (configurable crisis resources + privacy).
//
// Seeds realistic fixtures and asserts the END-TO-END outputs the pure tier can't
// see: a completed mental_health visit satisfying the depression/anxiety screenings
// through the shared inference stream; the household rollup minimizing a
// mental_health visit's title unless the owner overrode; the crisis finding reading
// the CONFIGURED resources (with the neutral fallback when unconfigured); and the
// privacy invariant that a crisis signal stays with the profile.
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getInferredPreventiveSatisfactions,
  collectHouseholdRollup,
  collectUpcoming,
} from "@/lib/queries";
import { recordInstrumentScore } from "@/lib/instrument-records";
import {
  setMentalHealthShareFull,
  setGlobalCrisisResources,
  setProfileCrisisResourcesOverride,
} from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addAppointment(
  profileId: number,
  scheduledAt: string,
  title: string | null,
  status: string,
  kind: string | null
): void {
  db.prepare(
    `INSERT INTO appointments (profile_id, scheduled_at, title, status, kind)
     VALUES (?, ?, ?, ?, ?)`
  ).run(profileId, scheduledAt, title, status, kind);
}

describe("#997 — a completed mental_health visit satisfies depression + anxiety screenings", () => {
  it("satisfies BOTH screenings via the shared inference stream, even with a generic title", () => {
    const p = newProfile("MH visit");
    const td = today(p);
    // A generically-titled completed mental_health visit — the KIND is the signal.
    addAppointment(
      p,
      shiftDateStr(td, -10),
      "Session",
      "completed",
      "mental_health"
    );

    const sats = getInferredPreventiveSatisfactions(p);
    expect(sats.some((s) => s.ruleKey === "depression_screening")).toBe(true);
    expect(sats.some((s) => s.ruleKey === "anxiety_screening")).toBe(true);
  });

  it("a completed physical does NOT satisfy the mental-health screenings", () => {
    const p = newProfile("Phys visit");
    const td = today(p);
    addAppointment(
      p,
      shiftDateStr(td, -10),
      "Annual physical",
      "completed",
      "physical"
    );
    const sats = getInferredPreventiveSatisfactions(p);
    expect(sats.some((s) => s.ruleKey === "depression_screening")).toBe(false);
    expect(sats.some((s) => s.ruleKey === "anxiety_screening")).toBe(false);
  });
});

describe("#997 — household strip minimizes a mental_health visit", () => {
  it("shows only 'Medical appointment' by default; own Upcoming keeps the real title; override reveals it", () => {
    const p = newProfile("MH strip");
    const td = today(p);
    addAppointment(
      p,
      shiftDateStr(td, 2),
      "Therapy — Dr. Okafor",
      "scheduled",
      "mental_health"
    );

    // Shared household strip → minimal by default.
    const rollup = collectHouseholdRollup(p, td);
    expect(rollup.nextAppointment).toBeTruthy();
    expect(rollup.nextAppointment!.title).toBe("Medical appointment");

    // The profile's OWN Upcoming page → full title.
    const own = collectUpcoming(p, td).find((i) => i.domain === "appointment");
    expect(own?.title).toBe("Therapy — Dr. Okafor");

    // Owner opts into full shared detail → the strip reveals the real title.
    setMentalHealthShareFull(p, true);
    const rollup2 = collectHouseholdRollup(p, td);
    expect(rollup2.nextAppointment!.title).toBe("Therapy — Dr. Okafor");
  });

  it("a non-sensitive kind is shown in full on the household strip", () => {
    const p = newProfile("Phys strip");
    const td = today(p);
    addAppointment(
      p,
      shiftDateStr(td, 2),
      "Cardiology follow-up",
      "scheduled",
      "physical"
    );
    const rollup = collectHouseholdRollup(p, td);
    expect(rollup.nextAppointment!.title).toBe("Cardiology follow-up");
  });
});

describe("#996 — the crisis finding reads the configured resources", () => {
  function severeProfile(name: string): { p: number; td: string } {
    const p = newProfile(name);
    const td = today(p);
    recordInstrumentScore(p, { instrument: "PHQ-9", date: td, total: 24 });
    return { p, td };
  }

  it("unconfigured → neutral fallback in the finding detail (never a fabricated number)", () => {
    const { p, td } = severeProfile("crisis fallback");
    const crisis = collectUpcoming(p, td).find(
      (i) => i.domain === "mental-health"
    );
    expect(crisis!.detail).toContain("local emergency services");
    expect(crisis!.detail).not.toContain("988");
  });

  it("global default appears in the finding detail", () => {
    setGlobalCrisisResources([{ label: "Region line", contact: "555-0100" }]);
    const { p, td } = severeProfile("crisis global");
    const crisis = collectUpcoming(p, td).find(
      (i) => i.domain === "mental-health"
    );
    expect(crisis!.detail).toContain("Region line: 555-0100");
  });

  it("a per-profile override wins over the global default and is private to the profile", () => {
    setGlobalCrisisResources([{ label: "Region line", contact: "555-0100" }]);
    const { p: a, td: tda } = severeProfile("crisis A");
    const { p: b, td: tdb } = severeProfile("crisis B");
    setProfileCrisisResourcesOverride(a, [
      { label: "A local line", contact: "555-0111" },
    ]);

    const crisisA = collectUpcoming(a, tda).find(
      (i) => i.domain === "mental-health"
    );
    expect(crisisA!.detail).toContain("A local line: 555-0111");
    expect(crisisA!.detail).not.toContain("Region line");

    // Profile B never sees A's override — it still resolves the global default.
    const crisisB = collectUpcoming(b, tdb).find(
      (i) => i.domain === "mental-health"
    );
    expect(crisisB!.detail).toContain("Region line: 555-0100");
    expect(crisisB!.detail).not.toContain("A local line");
  });
});

describe("#996 — the crisis signal stays with the profile (privacy pin)", () => {
  it("is NEVER part of the cross-profile household rollup — only doses/refills/appointments are", () => {
    const p = newProfile("crisis private");
    const td = today(p);
    recordInstrumentScore(p, { instrument: "PHQ-9", date: td, total: 25 });

    // The crisis finding is on the profile's OWN Upcoming...
    expect(
      collectUpcoming(p, td).some((i) => i.domain === "mental-health")
    ).toBe(true);

    // ...but the household rollup (what a caregiver login sees across profiles)
    // carries only doses, refills, and the next appointment — structurally never a
    // mental-health crisis signal.
    const rollup = collectHouseholdRollup(p, td);
    const rollupItems = [
      ...rollup.dueDoses,
      ...rollup.lowRefills,
      ...(rollup.nextAppointment ? [rollup.nextAppointment] : []),
    ];
    expect(rollupItems.every((i) => i.domain !== "mental-health")).toBe(true);
    expect(Object.keys(rollup)).toEqual([
      "dueDoses",
      "lowRefills",
      "nextAppointment",
    ]);
  });
});
