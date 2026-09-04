import { describe, expect, it } from "vitest";
import {
  MAX_STORED_SWITCHES,
  appendTimezoneSwitch,
  comparePositions,
  connectedTimezoneSwitchHistory,
  decodeTimezoneSwitchHistory,
  isExcusedSlot,
  isRepeatedSlot,
  localPositionIn,
  neverOccurred,
  occurredTwice,
  resolveSwitchHistory,
  parseTimezoneSwitches,
  resolveSwitch,
  serializeTimezoneSwitches,
  travelOfferText,
  travelPrompt,
  travelReturnOfferText,
  zoneAtInstant,
  zonePlaceLabel,
  type TimezoneSwitch,
} from "@/lib/travel-timezone";

// One instant, read on three clocks (2026-05-01T14:00:00Z):
//   America/New_York (EDT, UTC-4) → 2026-05-01 10:00
//   Asia/Tokyo       (JST, UTC+9) → 2026-05-01 23:00
const NOON_UTC = "2026-05-01T14:00:00Z";
const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";
// And one that crosses the date line (2026-05-01T21:00:00Z):
//   Pacific/Honolulu (HST, UTC-10) → 2026-05-01 11:00
//   Asia/Tokyo       (JST, UTC+9)  → 2026-05-02 06:00
const EVENING_UTC = "2026-05-01T21:00:00Z";
const HONOLULU = "Pacific/Honolulu";

const MORNING = 8 * 60;
const MIDDAY = 13 * 60;
const EVENING = 20 * 60;
const BEDTIME = 22 * 60;

describe("localPositionIn", () => {
  it("reads one instant as a different local day and minute per zone", () => {
    const at = new Date(EVENING_UTC);
    expect(localPositionIn(HONOLULU, at)).toEqual({
      day: "2026-05-01",
      minute: 11 * 60,
    });
    expect(localPositionIn(TOKYO, at)).toEqual({
      day: "2026-05-02",
      minute: 6 * 60,
    });
  });
});

describe("comparePositions", () => {
  it("orders by local day before local minute", () => {
    const late = { day: "2026-05-01", minute: 23 * 60 };
    const earlyNextDay = { day: "2026-05-02", minute: 1 };
    expect(comparePositions(late, earlyNextDay)).toBeLessThan(0);
    expect(comparePositions(earlyNextDay, late)).toBeGreaterThan(0);
    expect(comparePositions(late, { ...late })).toBe(0);
  });
});

describe("resolveSwitch", () => {
  it("names the direction the wall clock moved", () => {
    expect(
      resolveSwitch({ at: NOON_UTC, from: NY, to: TOKYO })?.direction
    ).toBe("forward");
    expect(
      resolveSwitch({ at: NOON_UTC, from: TOKYO, to: NY })?.direction
    ).toBe("backward");
    // Two zones reading the same wall clock at that instant — nothing skipped and
    // nothing repeated, so neither rule may fire.
    expect(
      resolveSwitch({ at: NOON_UTC, from: "Europe/Paris", to: "Europe/Berlin" })
        ?.direction
    ).toBe("level");
  });

  it("carries both endpoints as the local positions they really were", () => {
    const r = resolveSwitch({ at: NOON_UTC, from: NY, to: TOKYO });
    expect(r?.left).toEqual({ day: "2026-05-01", minute: 10 * 60 });
    expect(r?.landed).toEqual({ day: "2026-05-01", minute: 23 * 60 });
  });

  it("answers null for a record it cannot trust, instead of throwing", () => {
    expect(
      resolveSwitch({ at: "not-an-instant", from: NY, to: TOKYO })
    ).toBeNull();
    expect(
      resolveSwitch({ at: NOON_UTC, from: "Mars/Olympus", to: TOKYO })
    ).toBeNull();
    expect(
      resolveSwitch({ at: NOON_UTC, from: NY, to: "Mars/Olympus" })
    ).toBeNull();
  });
});

// The predicates take a switch ALREADY resolved (#5010) — the resolution is hoisted to
// the profile so a strip does not pay `Intl` per slot. A single switch is always a
// connected chain, so this is the one-switch spelling of resolveSwitchHistory.
const resolved = (sw: TimezoneSwitch) => resolveSwitchHistory([sw])[0];

describe("neverOccurred — the eastward vanished span", () => {
  const flight: TimezoneSwitch = { at: NOON_UTC, from: NY, to: TOKYO };

  it("covers the wall clock the switch jumped over", () => {
    // 10:00 → 23:00 on the same local date: midday, evening and bedtime all
    // vanished for this traveller.
    expect(neverOccurred(resolved(flight), { day: "2026-05-01", minute: MIDDAY })).toBe(
      true
    );
    expect(neverOccurred(resolved(flight), { day: "2026-05-01", minute: EVENING })).toBe(
      true
    );
    expect(neverOccurred(resolved(flight), { day: "2026-05-01", minute: BEDTIME })).toBe(
      true
    );
  });

  it("leaves the wall clock BEFORE the jump alone — that morning happened", () => {
    expect(neverOccurred(resolved(flight), { day: "2026-05-01", minute: MORNING })).toBe(
      false
    );
  });

  it("is open at BOTH ends: the minute left and the minute landed on both happened", () => {
    // The traveller was reading 10:00 when they switched, and 23:00 immediately
    // after. Closing either end would excuse a dose they could have taken.
    expect(neverOccurred(resolved(flight), { day: "2026-05-01", minute: 10 * 60 })).toBe(
      false
    );
    expect(neverOccurred(resolved(flight), { day: "2026-05-01", minute: 23 * 60 })).toBe(
      false
    );
    expect(
      neverOccurred(resolved(flight), { day: "2026-05-01", minute: 10 * 60 + 1 })
    ).toBe(true);
    expect(
      neverOccurred(resolved(flight), { day: "2026-05-01", minute: 23 * 60 - 1 })
    ).toBe(true);
  });

  it("does not reach the next local day — the day after a switch is ordinary", () => {
    expect(neverOccurred(resolved(flight), { day: "2026-05-02", minute: MORNING })).toBe(
      false
    );
    expect(neverOccurred(resolved(flight), { day: "2026-04-30", minute: EVENING })).toBe(
      false
    );
  });

  it("spans the calendar day the switch skipped over the date line", () => {
    // Honolulu 2026-05-01 11:00 → Tokyo 2026-05-02 06:00.
    const dateLine: TimezoneSwitch = {
      at: EVENING_UTC,
      from: HONOLULU,
      to: TOKYO,
    };
    expect(
      neverOccurred(resolved(dateLine), { day: "2026-05-01", minute: EVENING })
    ).toBe(true);
    expect(neverOccurred(resolved(dateLine), { day: "2026-05-02", minute: 5 * 60 })).toBe(
      true
    );
    expect(
      neverOccurred(resolved(dateLine), { day: "2026-05-02", minute: MORNING })
    ).toBe(false);
    expect(
      neverOccurred(resolved(dateLine), { day: "2026-05-01", minute: MORNING })
    ).toBe(false);
  });

  it("never fires for a westward or a level switch", () => {
    const westward: TimezoneSwitch = { at: NOON_UTC, from: TOKYO, to: NY };
    expect(neverOccurred(resolved(westward), { day: "2026-05-01", minute: MIDDAY })).toBe(
      false
    );
    const level: TimezoneSwitch = {
      at: NOON_UTC,
      from: "Europe/Paris",
      to: "Europe/Berlin",
    };
    expect(neverOccurred(resolved(level), { day: "2026-05-01", minute: MIDDAY })).toBe(
      false
    );
  });
});

describe("occurredTwice — the westward repeated span", () => {
  const flight: TimezoneSwitch = { at: NOON_UTC, from: TOKYO, to: NY };

  it("covers the wall clock the profile lives through a second time", () => {
    // 23:00 back to 10:00 on the same local date.
    expect(occurredTwice(resolved(flight), { day: "2026-05-01", minute: MIDDAY })).toBe(
      true
    );
    expect(occurredTwice(resolved(flight), { day: "2026-05-01", minute: EVENING })).toBe(
      true
    );
  });

  it("is closed at BOTH ends: the clock stands on one and runs back through the other", () => {
    expect(occurredTwice(resolved(flight), { day: "2026-05-01", minute: 10 * 60 })).toBe(
      true
    );
    expect(occurredTwice(resolved(flight), { day: "2026-05-01", minute: 23 * 60 })).toBe(
      true
    );
    expect(
      occurredTwice(resolved(flight), { day: "2026-05-01", minute: 10 * 60 - 1 })
    ).toBe(false);
    expect(
      occurredTwice(resolved(flight), { day: "2026-05-01", minute: 23 * 60 + 1 })
    ).toBe(false);
  });

  it("leaves the morning already taken before the jump outside the span", () => {
    expect(occurredTwice(resolved(flight), { day: "2026-05-01", minute: MORNING })).toBe(
      false
    );
  });

  it("spans backwards over the date line", () => {
    // Tokyo 2026-05-02 06:00 back to Honolulu 2026-05-01 11:00.
    const dateLine: TimezoneSwitch = {
      at: EVENING_UTC,
      from: TOKYO,
      to: HONOLULU,
    };
    expect(
      occurredTwice(resolved(dateLine), { day: "2026-05-01", minute: EVENING })
    ).toBe(true);
    expect(occurredTwice(resolved(dateLine), { day: "2026-05-02", minute: 5 * 60 })).toBe(
      true
    );
    expect(
      occurredTwice(resolved(dateLine), { day: "2026-05-02", minute: MORNING })
    ).toBe(false);
  });

  it("never fires for an eastward switch", () => {
    const eastward: TimezoneSwitch = { at: NOON_UTC, from: NY, to: TOKYO };
    expect(occurredTwice(resolved(eastward), { day: "2026-05-01", minute: MIDDAY })).toBe(
      false
    );
  });
});

describe("isExcusedSlot / isRepeatedSlot over a history", () => {
  // A trip out and back: eastward on the 1st, westward on the 8th.
  const history: TimezoneSwitch[] = [
    { at: NOON_UTC, from: NY, to: TOKYO },
    { at: "2026-05-08T14:00:00Z", from: TOKYO, to: NY },
  ];

  it("excuses a slot the complete trip trajectory never contained", () => {
    expect(isExcusedSlot(resolveSwitchHistory(history), "2026-05-01", EVENING)).toBe(true);
  });

  it("re-arms a skipped slot when a later reverse switch makes it occur", () => {
    const quickReturn: TimezoneSwitch[] = [
      { at: "2026-05-01T14:00:00Z", from: NY, to: TOKYO },
      { at: "2026-05-01T14:01:00Z", from: TOKYO, to: NY },
    ];
    // 10:00 -> 23:00 skips noon, then 23:01 -> 10:01 puts noon back ahead
    // of the profile. Across the combined trajectory it occurs exactly once.
    expect(isExcusedSlot(resolveSwitchHistory(quickReturn), "2026-05-01", MIDDAY)).toBe(false);
    expect(isRepeatedSlot(resolveSwitchHistory(quickReturn), "2026-05-01", MIDDAY)).toBe(false);
  });

  it("ignores a duplicate crossing instead of cancelling a legitimate return", () => {
    const duplicatedOutbound: TimezoneSwitch[] = [
      { at: "2026-05-01T13:59:00Z", from: NY, to: TOKYO },
      { at: "2026-05-01T14:00:00Z", from: NY, to: TOKYO },
      { at: "2026-05-01T14:01:00Z", from: TOKYO, to: NY },
    ];
    expect(isExcusedSlot(resolveSwitchHistory(duplicatedOutbound), "2026-05-01", MIDDAY)).toBe(false);
    expect(isRepeatedSlot(resolveSwitchHistory(duplicatedOutbound), "2026-05-01", MIDDAY)).toBe(
      false
    );
  });

  it("fails open across a discontinuity or a current-zone mismatch", () => {
    const disconnected: TimezoneSwitch[] = [
      { at: "2026-05-01T14:00:00Z", from: NY, to: TOKYO },
      { at: "2026-05-01T14:01:00Z", from: "Europe/Paris", to: TOKYO },
    ];
    // Paris 16:01 → Tokyo 23:01 appears to skip 20:00, but the unrecorded
    // boundary that put the profile in Paris can cancel that crossing. The
    // retained history is uncertain, so even an in-gap slot must fail open.
    expect(isExcusedSlot(resolveSwitchHistory(disconnected), "2026-05-01", EVENING)).toBe(false);
    expect(connectedTimezoneSwitchHistory(history, NY)).toEqual(history);
    expect(connectedTimezoneSwitchHistory([history[0]], NY)).toEqual([]);
  });

  it("does not excuse a slot the westward leg merely repeated", () => {
    // 2026-05-08: Tokyo 23:00 → New York 10:00. The evening slot repeats; it did
    // not vanish, so it stays in the denominator and must be answered.
    expect(isExcusedSlot(resolveSwitchHistory(history), "2026-05-08", EVENING)).toBe(false);
    expect(isRepeatedSlot(resolveSwitchHistory(history), "2026-05-08", EVENING)).toBe(true);
  });

  it("leaves every other day untouched", () => {
    for (const minute of [MORNING, MIDDAY, EVENING, BEDTIME]) {
      expect(isExcusedSlot(resolveSwitchHistory(history), "2026-05-04", minute)).toBe(false);
      expect(isRepeatedSlot(resolveSwitchHistory(history), "2026-05-04", minute)).toBe(false);
    }
  });

  it("excuses nothing when there is no history at all", () => {
    expect(isExcusedSlot(resolveSwitchHistory([]), "2026-05-01", EVENING)).toBe(false);
    expect(isRepeatedSlot(resolveSwitchHistory([]), "2026-05-01", EVENING)).toBe(false);
  });
});

describe("zoneAtInstant — which zone a past instant was lived in (#4025)", () => {
  // Out on the 1st, back on the 8th. The chain must end at the CURRENT zone or it is
  // rejected whole, which is why every row below passes the zone the trip ends in.
  const trip: TimezoneSwitch[] = [
    { at: NOON_UTC, from: NY, to: TOKYO },
    { at: "2026-05-08T14:00:00Z", from: TOKYO, to: NY },
  ];

  it.each([
    // Before the outbound, during the trip, after the return — and the two boundary
    // instants, which belong to the zone they LANDED in (the switch is instantaneous).
    { at: "2026-04-30T00:00:00Z", expected: NY, why: "before the outbound" },
    { at: NOON_UTC, expected: TOKYO, why: "at the outbound instant" },
    { at: "2026-05-04T00:00:00Z", expected: TOKYO, why: "mid-trip" },
    { at: "2026-05-08T14:00:00Z", expected: NY, why: "at the return instant" },
    { at: "2026-06-01T00:00:00Z", expected: NY, why: "after the return" },
  ])("$why → $expected", ({ at, expected }) => {
    expect(zoneAtInstant(trip, NY, new Date(at))).toBe(expected);
  });

  // FAIL OPEN, exactly as every other consumer of this history does: a chain that does
  // not lead to the current zone is rejected whole, and the answer is the current zone
  // — which is the pre-#4025 behaviour rather than a guess built on a broken record.
  it.each([
    { name: "no history at all", switches: [] as TimezoneSwitch[] },
    { name: "a chain that does not reach the current zone", switches: trip },
  ])("$name → the current zone", ({ switches }) => {
    expect(
      zoneAtInstant(switches, HONOLULU, new Date("2026-04-30T00:00:00Z"))
    ).toBe(HONOLULU);
  });
});

describe("stored switch history", () => {
  it("round-trips through the stored JSON", () => {
    const list: TimezoneSwitch[] = [{ at: NOON_UTC, from: NY, to: TOKYO }];
    expect(parseTimezoneSwitches(serializeTimezoneSwitches(list))).toEqual(
      list
    );
  });

  it("fails open without throwing when any stored row is malformed", () => {
    expect(parseTimezoneSwitches(undefined)).toEqual([]);
    expect(decodeTimezoneSwitchHistory("")).toEqual({
      switches: [],
      valid: false,
    });
    expect(parseTimezoneSwitches("{")).toEqual([]);
    expect(parseTimezoneSwitches('{"at":"x"}')).toEqual([]);
    expect(
      parseTimezoneSwitches(
        `[{"at":"${NOON_UTC}","from":"${NY}"},{"at":"${NOON_UTC}","from":"${NY}","to":"${TOKYO}"},null,7]`
      )
    ).toEqual([]);
    expect(
      decodeTimezoneSwitchHistory(`[{"at":"${NOON_UTC}","from":"${NY}"}]`)
    ).toEqual({ switches: [], valid: false });
  });

  // #3428 item 1. The old rule dropped anything past 120 days and kept 24 records,
  // sized for the excusal rules' 90-day strip. `zoneAtInstant` asks about instants of
  // any age, and a dropped record answers every instant before it with the wrong
  // zone — so nothing ages out. Three years of monthly hops is the shape a heavy
  // traveller reaches; it must survive whole.
  it("keeps a three-year, 200-switch history unpruned", () => {
    let history: TimezoneSwitch[] = [];
    const zones = [NY, TOKYO];
    for (let i = 0; i < 200; i++) {
      const day = new Date(Date.UTC(2023, 0, 1) + i * 5 * 86_400_000);
      history = appendTimezoneSwitch(history, {
        at: `${day.toISOString().slice(0, 10)}T12:00:00Z`,
        from: zones[i % 2],
        to: zones[(i + 1) % 2],
      });
    }
    expect(history).toHaveLength(200);
    expect(history[0].at).toBe("2023-01-01T12:00:00Z");
    // Three years of coverage, and the oldest record is the one a resolver needs to
    // answer for the oldest instant — under the retired rule it was the first to go.
    expect(history.at(-1)!.at).toBe("2025-09-22T12:00:00Z");
    // The chain still validates end to end, so the whole span is readable.
    expect(connectedTimezoneSwitchHistory(history, NY)).toHaveLength(200);
    // Switch 30 (2023-05-31T12:00Z, an even index) landed in Tokyo and switch 31 had
    // not happened yet, so an instant two and a half years before "now" still resolves
    // to the zone it was lived in. Under the retired 120-day floor this record was gone
    // and the same instant answered Tokyo only by accident of the current zone.
    expect(zoneAtInstant(history, NY, new Date("2023-06-01T00:00:00Z"))).toBe(
      TOKYO
    );
    // Before the first record at all: that switch's `from`.
    expect(zoneAtInstant(history, NY, new Date("2022-12-01T00:00:00Z"))).toBe(
      NY
    );
  });

  // The remaining bound is a safety valve on a runaway writer, not a retention
  // policy — nothing the app does approaches it.
  it("caps the stored history at MAX_STORED_SWITCHES, newest kept", () => {
    let history: TimezoneSwitch[] = [];
    for (let i = 0; i < MAX_STORED_SWITCHES + 5; i++) {
      history = appendTimezoneSwitch(history, {
        at: `2026-04-30T00:00:${String(i % 60).padStart(2, "0")}Z`,
        from: NY,
        to: TOKYO,
      });
    }
    expect(history).toHaveLength(MAX_STORED_SWITCHES);
    expect(MAX_STORED_SWITCHES).toBeGreaterThan(200);
  });
});

describe("travelPrompt", () => {
  const base = {
    ownProfile: true,
    deviceZone: TOKYO,
    profileZone: NY,
    homeZone: null,
    dismissedZone: null,
  };

  it("offers the switch when the device is somewhere the profile is not", () => {
    expect(travelPrompt(base)).toEqual({
      kind: "offer",
      deviceZone: TOKYO,
      profileZone: NY,
    });
  });

  it("says nothing for a profile that is not the login's own", () => {
    // The one that silently moves somebody else's day: a member acting for the
    // traveller from their own phone must not be offered this.
    expect(travelPrompt({ ...base, ownProfile: false })).toEqual({
      kind: "none",
    });
  });

  it("says nothing when the device and the profile already agree", () => {
    expect(travelPrompt({ ...base, deviceZone: NY })).toEqual({ kind: "none" });
  });

  it("says nothing when the browser names no zone, or names one that is not real", () => {
    expect(travelPrompt({ ...base, deviceZone: null })).toEqual({
      kind: "none",
    });
    expect(travelPrompt({ ...base, deviceZone: "Mars/Olympus" })).toEqual({
      kind: "none",
    });
  });

  it("suppresses the offer for the dismissed zone only", () => {
    expect(travelPrompt({ ...base, dismissedZone: TOKYO })).toEqual({
      kind: "none",
    });
    // A NEW zone re-raises it — the dismissal answered one question, not the trip.
    expect(
      travelPrompt({
        ...base,
        deviceZone: "Europe/Paris",
        dismissedZone: TOKYO,
      })
    ).toEqual({ kind: "offer", deviceZone: "Europe/Paris", profileZone: NY });
  });

  it("reports the return when the device is back on the recorded home zone", () => {
    expect(
      travelPrompt({
        ...base,
        deviceZone: NY,
        profileZone: TOKYO,
        homeZone: NY,
      })
    ).toEqual({ kind: "return", homeZone: NY, awayZone: TOKYO });
  });

  it("suppresses a return offer dismissed for the reported home zone", () => {
    // A home-terminating VPN can stay on indefinitely. It asks once, rather than
    // once per render, for the same reason an outbound offer does.
    expect(
      travelPrompt({
        ...base,
        deviceZone: NY,
        profileZone: TOKYO,
        homeZone: NY,
        dismissedZone: NY,
      })
    ).toEqual({ kind: "none" });
  });

  it("treats a home zone equal to the profile's own zone as stale, not a trip", () => {
    // Left over from a switch that was undone by hand: it must not manufacture a
    // return prompt for a third zone.
    expect(
      travelPrompt({
        ...base,
        deviceZone: TOKYO,
        profileZone: NY,
        homeZone: NY,
      })
    ).toEqual({ kind: "offer", deviceZone: TOKYO, profileZone: NY });
  });
});

describe("copy", () => {
  it("names the place, not the IANA path", () => {
    expect(zonePlaceLabel(TOKYO)).toBe("Tokyo");
    expect(zonePlaceLabel("America/Argentina/Buenos_Aires")).toBe(
      "Buenos Aires"
    );
    expect(zonePlaceLabel("UTC")).toBe("UTC");
  });

  it("asks before moving the day", () => {
    expect(travelOfferText(TOKYO)).toBe(
      "Your device is on Tokyo time — move your day there?"
    );
  });

  it("asks explicitly before moving the day back", () => {
    expect(travelReturnOfferText(NY)).toBe(
      "Your device is back on New York time — move your day back?"
    );
  });
});
