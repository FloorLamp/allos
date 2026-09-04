// DB INTEGRATION TIER — `setTimezone` is the WRITER of the zone-switch history
// (#3428 item 2).
//
// Before this, `switchProfileTimezone` (lib/settings/travel.ts) was the only path that
// recorded a zone move, so a zone changed in Settings or at onboarding left no trace.
// A history with holes is worse than none for the readers that walk it: `zoneAtInstant`
// reads a gap as "the zone never moved" and silently re-labels every instant before it,
// and the Health Connect body-metric reconcile could not see a Settings move at all
// (#3524's gap, pinned open in hc-timezone-rekey-reconcile.test.ts until now).
//
// So every path comes through one door and the record says WHY it happened. The kind is
// the whole reason two readers can share one history:
//   • the excusal predicates read TRAVEL only — a correction must never drop a dose out
//     of a denominator or silence its reminder;
//   • `zoneAtInstant` and the reconcile read BOTH — either kind really did move the zone
//     a day was keyed under.
// The pure spans and the filter's own algebra are in lib/__tests__/travel-timezone.ts;
// what belongs here is the writer's behaviour against a real settings store, and the
// two readers disagreeing about the same stored row on purpose.

import { describe, it, expect, afterEach } from "vitest";
import { db } from "@/lib/db";
import {
  getTimezone,
  getTravelSwitches,
  setProfileSetting,
  setTimezone,
  switchProfileTimezone,
} from "@/lib/settings";
import { profileDayZone, travelExcusalResolver } from "@/lib/travel-excusal";
import { zoneOf } from "@/lib/travel-timezone";

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";
const HONOLULU = "Pacific/Honolulu";

// Every instant is stated, never sampled: the subject is which record an instant lands
// in the history as.
const realNow = process.env.ALLOS_TEST_NOW;
function freeze(iso: string): void {
  process.env.ALLOS_TEST_NOW = iso;
}
afterEach(() => {
  if (realNow === undefined) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = realNow;
});

// A profile with NO zone of its own — it is inheriting the instance default, which is
// the state every fixture, every onboarding answer and every freshly created profile
// starts in.
function bareProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("what setTimezone records", () => {
  it("records nothing for a first-ever zone", () => {
    freeze("2026-05-01T14:00:00Z");
    const p = bareProfile("First zone");
    // This is the onboarding/fixture shape, and it is why ~180 call sites did not start
    // manufacturing journeys: with no zone row of its own the profile was inheriting an
    // instance default, which is not a claim about this person. There is no `from`.
    expect(setTimezone(p, NY)).toBeNull();
    expect(getTimezone(p)).toBe(NY);
    expect(getTravelSwitches(p)).toEqual([]);
  });

  it("records nothing when the zone does not move", () => {
    freeze("2026-05-01T14:00:00Z");
    const p = bareProfile("Same zone");
    setTimezone(p, NY);
    expect(setTimezone(p, NY)).toBeNull();
    expect(getTravelSwitches(p)).toEqual([]);
  });

  it("records a settings-kind seam when the zone actually moves", () => {
    freeze("2026-05-01T14:00:00Z");
    const p = bareProfile("Moved in Settings");
    setTimezone(p, NY);
    freeze("2026-05-02T09:00:00Z");
    expect(setTimezone(p, TOKYO)).toEqual({
      at: "2026-05-02T09:00:00Z",
      from: NY,
      to: TOKYO,
      kind: "settings",
    });
    expect(getTravelSwitches(p)).toEqual([
      { at: "2026-05-02T09:00:00Z", from: NY, to: TOKYO, kind: "settings" },
    ]);
  });

  // NO DOUBLE-APPEND. `switchProfileTimezone` used to hold its own copy of the append;
  // it delegates now, so there is one appender and the travel path cannot write twice.
  it("records exactly one travel-kind entry per switch", () => {
    freeze("2026-05-01T14:00:00Z");
    const p = bareProfile("Traveller");
    setTimezone(p, NY);
    freeze("2026-05-02T09:00:00Z");
    switchProfileTimezone(p, TOKYO, NY);
    freeze("2026-05-09T09:00:00Z");
    switchProfileTimezone(p, NY, null);
    expect(getTravelSwitches(p)).toEqual([
      { at: "2026-05-02T09:00:00Z", from: NY, to: TOKYO, kind: "travel" },
      { at: "2026-05-09T09:00:00Z", from: TOKYO, to: NY, kind: "travel" },
    ]);
  });

  // The writer's trust check moved with the append and still refuses to launder a
  // damaged history into a clean one-way chain.
  it("preserves malformed storage instead of appending onto it", () => {
    freeze("2026-05-01T14:00:00Z");
    const p = bareProfile("Malformed");
    setTimezone(p, NY);
    const malformed = '[{"at":"2026-05-01T00:00:00Z","from":"' + NY + '"}]';
    setProfileSetting(p, "timezone_switches", malformed);
    freeze("2026-05-02T09:00:00Z");
    expect(setTimezone(p, TOKYO)).not.toBeNull(); // the zone still moves
    expect(getTimezone(p)).toBe(TOKYO);
    expect(
      db
        .prepare(
          "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone_switches'"
        )
        .get(p)
    ).toEqual({ value: malformed });
  });
});

// THE DISCRIMINATOR, PINNED IN BOTH DIRECTIONS against one stored history, because
// getting it wrong in either direction is silent. One profile, one seam, two readers.
describe("one recorded seam, read two ways", () => {
  // 2026-05-01T14:00:00Z is 10:00 in New York and 23:00 in Tokyo, so the wall clock
  // between them never happened for anyone who really crossed it. Midday (13:00) sits
  // inside that span.
  const SEAM = "2026-05-01T14:00:00Z";
  const MIDDAY_SLOT = "Midday";
  const DAY = "2026-05-01";

  function seamProfile(name: string, kind: "travel" | "settings"): number {
    freeze("2026-04-01T00:00:00Z");
    const p = bareProfile(name);
    setTimezone(p, NY);
    freeze(SEAM);
    if (kind === "travel") switchProfileTimezone(p, TOKYO, NY);
    else setTimezone(p, TOKYO);
    return p;
  }

  it("excuses the skipped dose slot for TRAVEL", () => {
    const p = seamProfile("Flew", "travel");
    expect(getTravelSwitches(p).map((sw) => sw.kind)).toEqual(["travel"]);
    expect(travelExcusalResolver(p)(MIDDAY_SLOT, DAY)).toBe(true);
  });

  it("excuses nothing for the identical seam recorded in SETTINGS", () => {
    const p = seamProfile("Corrected", "settings");
    expect(getTravelSwitches(p).map((sw) => sw.kind)).toEqual(["settings"]);
    // Same instant, same two zones, same skipped span — and no dose leaves the
    // denominator, because nobody went anywhere. This is the assertion that keeps
    // #3263's semantics from moving under a Settings edit.
    expect(travelExcusalResolver(p)(MIDDAY_SLOT, DAY)).toBe(false);
  });

  it.each([{ kind: "travel" as const }, { kind: "settings" as const }])(
    "resolves a pre-seam instant to New York for kind $kind",
    ({ kind }) => {
      const p = seamProfile(`Zone-at ${kind}`, kind);
      const zone = profileDayZone(p);
      // The whole-history reader does NOT discriminate: the day really was keyed under
      // New York before the seam, whichever reason moved it.
      expect(zoneOf(zone, new Date("2026-04-20T12:00:00Z"))).toBe(NY);
      expect(zoneOf(zone, new Date("2026-05-04T12:00:00Z"))).toBe(TOKYO);
    }
  );

  // ALREADY-STORED PROD RECORDS CARRY NO `kind` — every one of them was written by
  // `switchProfileTimezone`, i.e. by a trip. They must keep excusing what they excused
  // before this landed, so the decoder reads an absent kind as travel. Seeded as raw
  // storage rather than through the writer, because the writer can no longer produce
  // this shape and the shape is exactly what is on disk (profile 1 holds two of them).
  it("keeps excusing over a pre-item-2 record that carries no kind", () => {
    freeze("2026-04-01T00:00:00Z");
    const p = bareProfile("Legacy history");
    setTimezone(p, TOKYO); // where the recorded chain must end
    setProfileSetting(
      p,
      "timezone_switches",
      `[{"at":"${SEAM}","from":"${NY}","to":"${TOKYO}"}]`
    );
    expect(getTravelSwitches(p).map((sw) => sw.kind)).toEqual(["travel"]);
    expect(travelExcusalResolver(p)(MIDDAY_SLOT, DAY)).toBe(true);
  });

  // The reader a profile that never moved gets: a plain string, byte-identical to the
  // pre-#4025 path, with nothing extra to go wrong.
  it("hands an unmoved profile its bare zone", () => {
    freeze("2026-05-01T14:00:00Z");
    const p = bareProfile("Never moved");
    setTimezone(p, HONOLULU);
    expect(profileDayZone(p)).toBe(HONOLULU);
  });
});
