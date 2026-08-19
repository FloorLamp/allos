import { describe, expect, it } from "vitest";
import { pinnedTimezone } from "../../e2e/pinned-timezone";
import { isValidTimezone } from "../timezone";
import {
  hhmmToMinutes,
  shiftDateStr,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "../date";
import { mainSleepNights } from "../sleep-regularity";
import { isLastNight } from "../sleep-summary";
import {
  mealTimeWindows,
  resolveDashboardTiming,
} from "../dashboard-relevance";
import { DEFAULT_INTAKE_REMINDER_MINUTES } from "../notifications/schedule";

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

// The #3260 band: a dashboard candidate may carry MEAL-WINDOW timing
// (`mealTimeWindows` — each intake reminder anchor ±60 min), and
// `resolveDashboardTiming` calls it `expired` once the last window of the local day
// has closed. An expired candidate is dropped before every lane is built, so
// `openDashboardAll` cannot reach it either — it is not demoted, it is absent.
//
// That makes the profile's LOCAL minute-of-day, not merely its calendar date, part of
// what the timezone pin has to make deterministic. The pin's 13:mm is exactly
// `DEFAULT_INTAKE_REMINDER_MINUTES.Midday` (13:00), so a profile that FOLLOWS the pin
// sits at the centre of a meal window at every possible UTC start hour. A profile that
// opts out to UTC has a local minute-of-day equal to the run's real UTC start hour, and
// goes dark for the ~3 hours a day after the last window closes — which is what made
// e2e/routine-usual.spec.ts red on main for runs starting in [21:00, 24:00) UTC.
describe("pinned zone × meal-window dashboard timing (#3260 band)", () => {
  const anchors = [
    DEFAULT_INTAKE_REMINDER_MINUTES.Morning,
    DEFAULT_INTAKE_REMINDER_MINUTES.Midday,
    DEFAULT_INTAKE_REMINDER_MINUTES.Evening,
  ];
  const day = "2026-08-19";
  const localMinuteOfDay = (frozen: string, zone: string) =>
    hhmmToMinutes(zonedDateParts(zone, new Date(frozen)).hhmm);

  it("a profile FOLLOWING the pin is inside a meal window at every UTC start hour and minute", () => {
    const timing = mealTimeWindows(anchors);
    for (let h = 0; h < 24; h++) {
      // Sweep the minute too: the pin preserves the frozen instant's minutes, so the
      // local time ranges over the whole 13:00–13:59 hour and every one of them has to
      // land inside the window, not just the anchor itself.
      for (const mm of ["00", "37", "59"]) {
        const frozen = `${day}T${String(h).padStart(2, "0")}:${mm}:00.000Z`;
        const { zone } = pinnedTimezone(frozen);
        const minute = localMinuteOfDay(frozen, zone);
        expect(minute, `utc ${h}:${mm} → ${zone}`).toBe(
          DEFAULT_INTAKE_REMINDER_MINUTES.Midday + Number(mm)
        );
        expect(
          resolveDashboardTiming(timing, minute),
          `utc ${h}:${mm} → ${zone} local minute ${minute}`
        ).toEqual({ kind: "active" });
      }
    }
  });

  it("documents the bug: a profile pinned to UTC instead goes `expired` for every run starting at or after 21:00 UTC", () => {
    const timing = mealTimeWindows(anchors);
    const dark: number[] = [];
    for (let h = 0; h < 24; h++) {
      const frozen = `${day}T${String(h).padStart(2, "0")}:37:00.000Z`;
      // The opt-out: read the SAME frozen instant in UTC rather than the pinned zone.
      const minute = localMinuteOfDay(frozen, "UTC");
      expect(minute, `utc hour ${h}`).toBe(h * 60 + 37);
      if (resolveDashboardTiming(timing, minute).kind === "expired")
        dark.push(h);
    }
    // Exactly the hours after the last meal window (20:00 + 60 min) closes.
    expect(dark).toEqual([21, 22, 23]);
  });
});
