// Personal-record celebration keys follow the record's IDENTITY, not its display
// spelling (issue #1931).
//
// `recentPRs` reads stats grouped on `movementLoadKey` and `recentCardioPRs` reads
// stats grouped on the case-folded activity name — but the group ships its FIRST-SEEN
// logged spelling as `exercise` / `activity`, and the dedupeKey used to be built from
// that raw string. Two consequences, both of them the #203/#482 name-recycling class:
//
//   • ONE record produced TWO keys. "Barbell Curl" and "Curl" are one merged history
//     (#331) and one PR, but a dismissal on one did not silence the other.
//   • The key of an UNCHANGED record moved when its oldest session was deleted, since
//     that is what decides which spelling the group reports — orphaning the dismissal
//     and leaving a dead row for a later name to inherit.
//
// These pins FAIL on the pre-#1931 raw-name key. The fix is the same one #1399/#1610
// applied to the plateau/stale findings: key on the canonical identity function, and
// carry the old shape as `supersedes` so a stored dismissal keeps working.

import { describe, it, expect } from "vitest";
import {
  prToFinding,
  cardioPrToFinding,
  isFindingSuppressed,
} from "@/lib/findings";
import type { PR, CardioPR } from "@/lib/coaching";
import { exerciseHistoryKey } from "@/lib/lifts";
import {
  prStrengthDismissalKey,
  prCardioDismissalKey,
  prDismissalIdentity,
  prDismissalKeysLosingBacking,
} from "@/lib/dismissal-keys";

function strengthPr(over: Partial<PR> = {}): PR {
  return {
    exercise: "Barbell Curl",
    equipmentId: null,
    equipment: null,
    kind: "1rm",
    date: "2026-07-09",
    e1rmKg: 40,
    weightKg: 35,
    reps: 8,
    bodyweight: false,
    ...over,
  };
}

function cardioPr(over: Partial<CardioPR> = {}): CardioPR {
  return {
    activity: "Cycling",
    kind: "speed",
    date: "2026-07-09",
    distanceKm: 20,
    durationMin: 40,
    speedKmh: 30,
    ...over,
  };
}

describe("PR dedupe keys follow identity, not the logged spelling (#1931)", () => {
  it("gives one merged movement ONE key across its variant spellings", () => {
    // Precondition: these ARE one history (#331), so they must be one celebration.
    expect(exerciseHistoryKey("Barbell Curl")).toBe(exerciseHistoryKey("Curl"));
    const variant = prToFinding(strengthPr({ exercise: "Barbell Curl" }), "kg");
    const base = prToFinding(strengthPr({ exercise: "Curl" }), "kg");
    expect(variant.dedupeKey).toBe(base.dedupeKey);
  });

  it("does not re-key a record when its group reports a different casing", () => {
    const a = prToFinding(strengthPr({ exercise: "Bench Press" }), "kg");
    const b = prToFinding(strengthPr({ exercise: "bench press" }), "kg");
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });

  it("keys a cardio record on the case-folded activity the stats group on", () => {
    const a = cardioPrToFinding(cardioPr({ activity: "Cycling" }), "km");
    const b = cardioPrToFinding(cardioPr({ activity: " cycling " }), "km");
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.dedupeKey).toBe(prCardioDismissalKey("Cycling", "speed"));
  });

  it("still separates the two axes that are genuinely different records", () => {
    const home = prToFinding(strengthPr({ equipmentId: 4 }), "kg");
    const hotel = prToFinding(strengthPr({ equipmentId: 9 }), "kg");
    const unassigned = prToFinding(strengthPr({ equipmentId: null }), "kg");
    expect(
      new Set([home.dedupeKey, hotel.dedupeKey, unassigned.dedupeKey]).size
    ).toBe(3);
    // …and the record KIND stays part of the key, so a 1RM dismissal doesn't silence
    // a top-set record on the same lift.
    expect(
      prToFinding(strengthPr({ kind: "weight" }), "kg").dedupeKey
    ).not.toBe(prToFinding(strengthPr({ kind: "1rm" }), "kg").dedupeKey);
    expect(
      cardioPrToFinding(cardioPr({ kind: "distance" }), "km").dedupeKey
    ).not.toBe(cardioPrToFinding(cardioPr({ kind: "speed" }), "km").dedupeKey);
  });

  it("carries the pre-#1931 raw-name key as `supersedes`, so a stored dismissal survives", () => {
    const f = prToFinding(strengthPr({ exercise: "Barbell Curl" }), "kg");
    expect(f.supersedes).toBe("pr:strength:Barbell Curl@none:1rm");
    // A dismissal stored under the OLD shape still suppresses the finding (#436).
    const legacyRow = new Map([
      [f.supersedes!, { snooze_until: null, dismissed_at: "2026-07-01" }],
    ]);
    expect(isFindingSuppressed(f, legacyRow, "2026-07-09")).toBe(true);
  });

  it("omits `supersedes` when the legacy shape is already the canonical one", () => {
    // A movement whose logged spelling IS its identity mints one key, not two.
    const f = prToFinding(strengthPr({ exercise: "curl" }), "kg");
    expect(f.dedupeKey).toBe(prStrengthDismissalKey("curl", null, "1rm"));
    expect(f.supersedes).toBeUndefined();
  });
});

describe("PR dismissal orphan arithmetic (#1931)", () => {
  it("reads the identity back out of both the canonical and the legacy shape", () => {
    expect(
      prDismissalIdentity(prStrengthDismissalKey("Barbell Curl", 7, "1rm"))
    ).toEqual({ domain: "strength", identity: "curl@7" });
    // Legacy row: raw display name, raw casing — normalized on the way in so it is
    // compared against live history on the same terms.
    expect(prDismissalIdentity("pr:strength:Barbell Curl@none:1rm")).toEqual({
      domain: "strength",
      identity: "curl@none",
    });
    expect(prDismissalIdentity("pr:cardio:Cycling:speed")).toEqual({
      domain: "cardio",
      identity: "cycling",
    });
    // Not a PR key, or malformed — never swept.
    expect(prDismissalIdentity("biomarker:ldl")).toBeNull();
    expect(prDismissalIdentity("pr:strength:")).toBeNull();
    expect(prDismissalIdentity("pr:strength:nolane:1rm")).toBeNull();
  });

  it("drops only the keys with no backing history left", () => {
    const stored = [
      prStrengthDismissalKey("Bench Press", null, "1rm"), // still trained
      prStrengthDismissalKey("Barbell Curl", null, "1rm"), // sets all deleted
      "pr:strength:Barbell Curl@none:weight", // the same dead subject, legacy shape
      prCardioDismissalKey("Cycling", "speed"), // still logged
      prCardioDismissalKey("Rowing", "distance"), // activity deleted
      "biomarker:ldl", // another namespace — untouched
    ];
    const lost = prDismissalKeysLosingBacking(
      stored,
      ["bench press@none"],
      ["cycling"]
    );
    expect(lost).toEqual([
      prStrengthDismissalKey("Barbell Curl", null, "1rm"),
      "pr:strength:Barbell Curl@none:weight",
      prCardioDismissalKey("Rowing", "distance"),
    ]);
  });

  it("keeps a dismissal whose movement merely moved to another implement lane", () => {
    // The lane is part of the identity, so the OLD lane's key is genuinely orphaned
    // while the new lane's is live — losing backing is per-lane, not per-movement.
    const stored = [
      prStrengthDismissalKey("Bench Press", 3, "1rm"),
      prStrengthDismissalKey("Bench Press", 8, "1rm"),
    ];
    expect(prDismissalKeysLosingBacking(stored, ["bench press@8"], [])).toEqual(
      [prStrengthDismissalKey("Bench Press", 3, "1rm")]
    );
  });
});
