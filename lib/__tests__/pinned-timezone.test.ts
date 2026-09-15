import { describe, expect, it } from "vitest";
import { pinnedTimezone } from "../../e2e/pinned-timezone";
import { sriSleepWindow } from "../../e2e/seed/profile-time-fixtures";
import { isValidTimezone } from "../timezone";
import {
  shiftDateStr,
  utcSqlString,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "../date";
import { mainSleepNights } from "../sleep-regularity";
import { isLastNight } from "../sleep-summary";

// The e2e timezone pin (e2e/pinned-timezone.ts): for ANY frozen run-start
// instant, the chosen zone must read 13:mm local on the SAME calendar date as
// the instant's UTC date — deterministic Midday at every possible CI start
// hour, with no today()/SQL-date divergence. Verified against the real Intl
// database, since the whole scheme rests on Etc/GMT±N being valid, DST-free
// zones.

function localParts(iso: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    // Intl can render midnight as "24" with hour12:false — normalize.
    hour: Number(get("hour")) % 24,
    minute: get("minute"),
  };
}

describe("pinnedTimezone (e2e frozen-clock timezone pin)", () => {
  it("maps every UTC start hour to 13:mm local on the same UTC date", () => {
    for (let h = 0; h < 24; h++) {
      const iso = `2026-07-21T${String(h).padStart(2, "0")}:37:00.000Z`;
      const { zone, offsetHours } = pinnedTimezone(iso);
      expect(isValidTimezone(zone), `${zone} must be a valid IANA zone`).toBe(
        true
      );
      expect(offsetHours).toBe(13 - h);
      const local = localParts(iso, zone);
      expect(local.hour, `utc hour ${h} → ${zone}`).toBe(13);
      expect(local.minute).toBe("37");
      expect(local.date, `utc hour ${h} → ${zone} keeps the UTC date`).toBe(
        "2026-07-21"
      );
    }
  });

  it("uses plain UTC when the instant is already 13:xx UTC", () => {
    expect(pinnedTimezone("2026-07-21T13:05:00.000Z").zone).toBe("UTC");
  });

  it("falls back to UTC on an unparseable instant", () => {
    expect(pinnedTimezone("not-a-date")).toEqual({
      zone: "UTC",
      offsetHours: 0,
    });
  });
});

describe("pinned zone × local intake fixture instants (#3886)", () => {
  const day = "2026-08-29";

  it("round-trips an 08:00 wall time through UTC SQL in all 24 pinned zones", () => {
    for (let h = 0; h < 24; h++) {
      const frozen = `${day}T${String(h).padStart(2, "0")}:37:00.000Z`;
      const { zone } = pinnedTimezone(frozen);
      const instant = zonedWallTimeToUtc(zone, day, "08:00")!;
      const stored = utcSqlString(instant);
      const read = zonedDateParts(
        zone,
        new Date(`${stored.replace(" ", "T")}Z`)
      );
      expect(read.date, `utc hour ${h} → ${zone}`).toBe(day);
      expect(read.hhmm, `utc hour ${h} → ${zone}`).toBe("08:00");
    }
  });

  it("documents the bug: a naive 08:00 UTC string crosses the local day in rotating zones", () => {
    const wrong: string[] = [];
    for (let h = 0; h < 24; h++) {
      const frozen = `${day}T${String(h).padStart(2, "0")}:37:00.000Z`;
      const { zone } = pinnedTimezone(frozen);
      const read = zonedDateParts(zone, new Date(`${day}T08:00:00Z`));
      if (read.date !== day) wrong.push(`${zone}:${read.date}`);
    }
    expect(wrong.length).toBeGreaterThan(0);
    expect(wrong.some((entry) => entry.startsWith("Etc/GMT+10:"))).toBe(true);
  });
});

// The #2159 band: an e2e fixture overnight (23:00 prev night → 04:00 today,
// meant LOCAL) must be stamped through the pinned zone (zonedWallTimeToUtc),
// because a wakeDay is the PROFILE-LOCAL date a session ENDS (mainSleepNights →
// zonedDateParts) and the coaching sleep signal refuses any night that is not
// last night (isLastNight). A bare-UTC `${today}T04:00:00Z` stamp reads as
// 23:00 the PREVIOUS local evening once the pinned offset reaches −5 — every
// run starting ≥ 18:00 UTC — so the night lands on yesterday's wakeDay,
// rest-sleep silently drops, and the rest card loses its "Also:" line. Same
// clock-band family as #2031/#2051: pin the whole 24-hour sweep, not one hour.
describe("pinned zone × fixture sleep instants (#2159 band)", () => {
  const today = "2026-08-05";
  const prevNight = shiftDateStr(today, -1);

  it("a tz-correct 23:00→04:00 local overnight lands on today's wakeDay at every UTC start hour", () => {
    for (let h = 0; h < 24; h++) {
      const frozen = `${today}T${String(h).padStart(2, "0")}:37:00.000Z`;
      const { zone } = pinnedTimezone(frozen);
      const session = {
        start: zonedWallTimeToUtc(zone, prevNight, "23:00")!.toISOString(),
        end: zonedWallTimeToUtc(zone, today, "04:00")!.toISOString(),
        value: 300,
      };
      const nights = mainSleepNights([session], zone);
      expect(nights, `utc hour ${h} → ${zone}`).toHaveLength(1);
      expect(nights[0].wakeDay, `utc hour ${h} → ${zone}`).toBe(today);
      expect(nights[0].durationMin).toBe(300);
      expect(isLastNight(nights[0].wakeDay, today)).toBe(true);
    }
  });

  it("documents the bug: bare-UTC stamps strand the night on yesterday exactly when the pinned offset is ≤ −5 (run start ≥ 18:00 UTC)", () => {
    for (let h = 0; h < 24; h++) {
      const frozen = `${today}T${String(h).padStart(2, "0")}:37:00.000Z`;
      const { zone, offsetHours } = pinnedTimezone(frozen);
      const bare = {
        start: `${prevNight}T23:00:00Z`,
        end: `${today}T04:00:00Z`,
        value: 300,
      };
      const nights = mainSleepNights([bare], zone);
      expect(nights).toHaveLength(1);
      const expectLastNight = offsetHours >= -4; // 04:00Z − 5h crosses local midnight
      expect(
        isLastNight(nights[0].wakeDay, today),
        `utc hour ${h} (offset ${offsetHours}) → ${zone}`
      ).toBe(expectLastNight);
    }
  });
});

// The #3644 corpus is keyed by stored wake-day. Its 28 windows must end on that
// same profile-local day in every rotating e2e zone; otherwise adjacent rows collide
// and the main-sleep election turns the losing 8h night into a nap.
describe("pinned zone × the 28-night SRI fixture (#3644)", () => {
  const today = "2026-08-28";

  it("computes the stored wake-day for every night in all 24 pinned zones", () => {
    for (let h = 0; h < 24; h++) {
      const frozen = `${today}T${String(h).padStart(2, "0")}:37:00.000Z`;
      const { zone } = pinnedTimezone(frozen);
      for (let i = 1; i <= 28; i++) {
        const wakeDay = shiftDateStr(today, -i);
        const dow = new Date(`${wakeDay}T00:00:00Z`).getUTCDay();
        const window = sriSleepWindow(zone, wakeDay, dow === 0 || dow === 6);
        const nights = mainSleepNights([{ ...window, date: wakeDay }], zone);
        expect(nights, `${zone} / stored ${wakeDay}`).toHaveLength(1);
        expect(nights[0].wakeDay, `${zone} / stored ${wakeDay}`).toBe(wakeDay);
      }
    }
  });

  it("would red on the old raw-UTC constructor", () => {
    const mismatches: string[] = [];
    for (let h = 0; h < 24; h++) {
      const frozen = `${today}T${String(h).padStart(2, "0")}:37:00.000Z`;
      const { zone } = pinnedTimezone(frozen);
      for (let i = 1; i <= 28; i++) {
        const wakeDay = shiftDateStr(today, -i);
        const bedDay = shiftDateStr(wakeDay, -1);
        const dow = new Date(`${wakeDay}T00:00:00Z`).getUTCDay();
        const weekend = dow === 0 || dow === 6;
        const rawUtc = {
          start: weekend ? `${wakeDay}T00:30:00Z` : `${bedDay}T23:00:00Z`,
          end: weekend ? `${wakeDay}T08:30:00Z` : `${wakeDay}T07:00:00Z`,
          date: wakeDay,
        };
        const computed = mainSleepNights([rawUtc], zone)[0]?.wakeDay;
        if (computed !== wakeDay)
          mismatches.push(`${zone}:${wakeDay}->${computed}`);
      }
    }
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.some((entry) => entry.startsWith("Etc/GMT+10:"))).toBe(
      true
    );
  });
});
