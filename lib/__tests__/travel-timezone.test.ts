import { describe, expect, it } from "vitest";
import {
  MAX_STORED_SWITCHES,
  appendTimezoneSwitch,
  comparePositions,
  isExcusedSlot,
  isRepeatedSlot,
  localPositionIn,
  neverOccurred,
  occurredTwice,
  parseTimezoneSwitches,
  resolveSwitch,
  serializeTimezoneSwitches,
  travelOfferText,
  travelPrompt,
  travelReturnOfferText,
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

describe("neverOccurred — the eastward vanished span", () => {
  const flight: TimezoneSwitch = { at: NOON_UTC, from: NY, to: TOKYO };

  it("covers the wall clock the switch jumped over", () => {
    // 10:00 → 23:00 on the same local date: midday, evening and bedtime all
    // vanished for this traveller.
    expect(neverOccurred(flight, { day: "2026-05-01", minute: MIDDAY })).toBe(
      true
    );
    expect(neverOccurred(flight, { day: "2026-05-01", minute: EVENING })).toBe(
      true
    );
    expect(neverOccurred(flight, { day: "2026-05-01", minute: BEDTIME })).toBe(
      true
    );
  });

  it("leaves the wall clock BEFORE the jump alone — that morning happened", () => {
    expect(neverOccurred(flight, { day: "2026-05-01", minute: MORNING })).toBe(
      false
    );
  });

  it("is open at BOTH ends: the minute left and the minute landed on both happened", () => {
    // The traveller was reading 10:00 when they switched, and 23:00 immediately
    // after. Closing either end would excuse a dose they could have taken.
    expect(neverOccurred(flight, { day: "2026-05-01", minute: 10 * 60 })).toBe(
      false
    );
    expect(neverOccurred(flight, { day: "2026-05-01", minute: 23 * 60 })).toBe(
      false
    );
    expect(
      neverOccurred(flight, { day: "2026-05-01", minute: 10 * 60 + 1 })
    ).toBe(true);
    expect(
      neverOccurred(flight, { day: "2026-05-01", minute: 23 * 60 - 1 })
    ).toBe(true);
  });

  it("does not reach the next local day — the day after a switch is ordinary", () => {
    expect(neverOccurred(flight, { day: "2026-05-02", minute: MORNING })).toBe(
      false
    );
    expect(neverOccurred(flight, { day: "2026-04-30", minute: EVENING })).toBe(
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
      neverOccurred(dateLine, { day: "2026-05-01", minute: EVENING })
    ).toBe(true);
    expect(neverOccurred(dateLine, { day: "2026-05-02", minute: 5 * 60 })).toBe(
      true
    );
    expect(
      neverOccurred(dateLine, { day: "2026-05-02", minute: MORNING })
    ).toBe(false);
    expect(
      neverOccurred(dateLine, { day: "2026-05-01", minute: MORNING })
    ).toBe(false);
  });

  it("never fires for a westward or a level switch", () => {
    const westward: TimezoneSwitch = { at: NOON_UTC, from: TOKYO, to: NY };
    expect(neverOccurred(westward, { day: "2026-05-01", minute: MIDDAY })).toBe(
      false
    );
    const level: TimezoneSwitch = {
      at: NOON_UTC,
      from: "Europe/Paris",
      to: "Europe/Berlin",
    };
    expect(neverOccurred(level, { day: "2026-05-01", minute: MIDDAY })).toBe(
      false
    );
  });
});

describe("occurredTwice — the westward repeated span", () => {
  const flight: TimezoneSwitch = { at: NOON_UTC, from: TOKYO, to: NY };

  it("covers the wall clock the profile lives through a second time", () => {
    // 23:00 back to 10:00 on the same local date.
    expect(occurredTwice(flight, { day: "2026-05-01", minute: MIDDAY })).toBe(
      true
    );
    expect(occurredTwice(flight, { day: "2026-05-01", minute: EVENING })).toBe(
      true
    );
  });

  it("is closed at BOTH ends: the clock stands on one and runs back through the other", () => {
    expect(occurredTwice(flight, { day: "2026-05-01", minute: 10 * 60 })).toBe(
      true
    );
    expect(occurredTwice(flight, { day: "2026-05-01", minute: 23 * 60 })).toBe(
      true
    );
    expect(
      occurredTwice(flight, { day: "2026-05-01", minute: 10 * 60 - 1 })
    ).toBe(false);
    expect(
      occurredTwice(flight, { day: "2026-05-01", minute: 23 * 60 + 1 })
    ).toBe(false);
  });

  it("leaves the morning already taken before the jump outside the span", () => {
    expect(occurredTwice(flight, { day: "2026-05-01", minute: MORNING })).toBe(
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
      occurredTwice(dateLine, { day: "2026-05-01", minute: EVENING })
    ).toBe(true);
    expect(occurredTwice(dateLine, { day: "2026-05-02", minute: 5 * 60 })).toBe(
      true
    );
    expect(
      occurredTwice(dateLine, { day: "2026-05-02", minute: MORNING })
    ).toBe(false);
  });

  it("never fires for an eastward switch", () => {
    const eastward: TimezoneSwitch = { at: NOON_UTC, from: NY, to: TOKYO };
    expect(occurredTwice(eastward, { day: "2026-05-01", minute: MIDDAY })).toBe(
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

  it("excuses a slot skipped by ANY switch on record", () => {
    expect(isExcusedSlot(history, "2026-05-01", EVENING)).toBe(true);
  });

  it("does not excuse a slot the westward leg merely repeated", () => {
    // 2026-05-08: Tokyo 23:00 → New York 10:00. The evening slot repeats; it did
    // not vanish, so it stays in the denominator and must be answered.
    expect(isExcusedSlot(history, "2026-05-08", EVENING)).toBe(false);
    expect(isRepeatedSlot(history, "2026-05-08", EVENING)).toBe(true);
  });

  it("leaves every other day untouched", () => {
    for (const minute of [MORNING, MIDDAY, EVENING, BEDTIME]) {
      expect(isExcusedSlot(history, "2026-05-04", minute)).toBe(false);
      expect(isRepeatedSlot(history, "2026-05-04", minute)).toBe(false);
    }
  });

  it("excuses nothing when there is no history at all", () => {
    expect(isExcusedSlot([], "2026-05-01", EVENING)).toBe(false);
    expect(isRepeatedSlot([], "2026-05-01", EVENING)).toBe(false);
  });
});

describe("stored switch history", () => {
  it("round-trips through the stored JSON", () => {
    const list: TimezoneSwitch[] = [{ at: NOON_UTC, from: NY, to: TOKYO }];
    expect(parseTimezoneSwitches(serializeTimezoneSwitches(list))).toEqual(
      list
    );
  });

  it("drops junk rather than throwing, so one bad row cannot take a render down", () => {
    expect(parseTimezoneSwitches(undefined)).toEqual([]);
    expect(parseTimezoneSwitches("{")).toEqual([]);
    expect(parseTimezoneSwitches('{"at":"x"}')).toEqual([]);
    expect(
      parseTimezoneSwitches(
        `[{"at":"${NOON_UTC}","from":"${NY}"},{"at":"${NOON_UTC}","from":"${NY}","to":"${TOKYO}"},null,7]`
      )
    ).toEqual([{ at: NOON_UTC, from: NY, to: TOKYO }]);
  });

  it("prunes records older than the retention window on append", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const ancient: TimezoneSwitch = {
      at: "2025-01-01T00:00:00Z",
      from: NY,
      to: TOKYO,
    };
    const recent: TimezoneSwitch = {
      at: "2026-04-20T00:00:00Z",
      from: TOKYO,
      to: NY,
    };
    const next: TimezoneSwitch = { at: NOON_UTC, from: NY, to: TOKYO };
    expect(appendTimezoneSwitch([ancient, recent], next, now)).toEqual([
      recent,
      next,
    ]);
  });

  it("keeps the newest MAX_STORED_SWITCHES and no more", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    let history: TimezoneSwitch[] = [];
    for (let i = 0; i < MAX_STORED_SWITCHES + 5; i++) {
      history = appendTimezoneSwitch(
        history,
        {
          at: `2026-04-30T00:00:${String(i).padStart(2, "0")}Z`,
          from: NY,
          to: TOKYO,
        },
        now
      );
    }
    expect(history).toHaveLength(MAX_STORED_SWITCHES);
    expect(history[history.length - 1].at).toBe("2026-04-30T00:00:28Z");
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
