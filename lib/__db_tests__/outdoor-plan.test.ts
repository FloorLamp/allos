// DB / NOTIFICATION TIER — #1724 part 5: the forecast-ahead planning surfaces.
//
// ONE computation, TWO surfaces (#221): the digest's This-week glance and the calm
// Upcoming planning item both render `planningLine`'s result, so they can never
// disagree about which day to name. This asserts BOTH render the same line end-to-end
// over one realistic fixture, and — the part that matters most — that they stay SILENT
// on the weeks where a plan would be filler rather than signal.
//
// ZERO NEW SENDS is a property, not a footnote: the digest line rides the morning
// message that already goes out, and the Upcoming item is a page surface. Nothing here
// creates a channel.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setHomeLocation, setTimezone } from "@/lib/settings";
import { upsertWeatherDays } from "@/lib/integrations/weather-cache";
import type { DailyWeatherRow } from "@/lib/integrations/open-meteo";
import { collectUpcoming } from "@/lib/queries";
import { getOutdoorPlans } from "@/lib/queries/weather-training";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { buildDigest } from "@/lib/notifications/digest";
import { plainBody } from "@/lib/notifications/rich-text";

const LNG = -74;
let seq = 0;
const homeByProfile = new Map<number, { lat: number; lng: number }>();

// Own coordinate per fixture — the weather cache is global and location-keyed.
function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`${name}-${seq++}`)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  // A CALENDAR week whose START DAY IS TODAY, so the fixture always has a full six
  // remaining on-days to plan across. Pinning the week start to today's weekday (rather
  // than hard-coding one) is what keeps this deterministic: with a fixed week start the
  // number of days left drifts with the day CI happens to run on, and the fixture would
  // pass on a Monday and fail on a Friday.
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'week_mode', 'calendar')
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(id);
  const weekday = new Date(`${today(id)}T12:00:00Z`).getUTCDay();
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'week_start', ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(id, String(weekday));
  const home = { lat: 10 + seq / 10, lng: LNG };
  homeByProfile.set(id, home);
  setHomeLocation(id, home);
  return id;
}

function emptyDay(date: string): DailyWeatherRow {
  return {
    date,
    tempMaxC: null,
    tempMinC: null,
    pressureMslHpa: null,
    precipitationMm: null,
    weatherCode: null,
    uvIndexMax: null,
    aqi: null,
    pollenTree: null,
    pollenGrass: null,
    pollenWeed: null,
  };
}

function cacheDay(
  profileId: number,
  date: string,
  over: Partial<DailyWeatherRow>
): void {
  const home = homeByProfile.get(profileId)!;
  upsertWeatherDays(
    home.lat,
    home.lng,
    [{ ...emptyDay(date), ...over }],
    "test"
  );
}

// A season of rides, so the tolerance envelope is REVEALED rather than assumed.
function seedRideHistory(profileId: number): void {
  const anchor = today(profileId);
  [10, 12, 14, 16, 18, 20, 22, 24].forEach((t, i) => {
    const date = shiftDateStr(anchor, -(7 * (i + 1)));
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'cardio', 'Cycling', 60)`
    ).run(profileId, date);
    cacheDay(profileId, date, { tempMaxC: t, precipitationMm: 0 });
  });
}

// A weekly cardio target the profile is BEHIND on (0 of 2 done this week).
function seedBehindCardioTarget(profileId: number): void {
  db.prepare(
    `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
     VALUES (?, 'type', 'cardio', 2)`
  ).run(profileId);
}

// Forecast the rest of the week: every remaining day wet except `dryOffset` days ahead.
function seedForecast(
  profileId: number,
  dryOffset: number | null,
  days = 6
): void {
  const anchor = today(profileId);
  for (let i = 0; i <= days; i++) {
    cacheDay(profileId, shiftDateStr(anchor, i), {
      tempMaxC: 16,
      precipitationMm: i === dryOffset ? 0 : 60,
    });
  }
}

function upcomingPlanItems(profileId: number) {
  return collectUpcoming(profileId, today(profileId)).filter((i) =>
    i.key.startsWith("outdoor-plan:")
  );
}

function digestText(profileId: number, name: string): string {
  const model = buildDigest(gatherDigestInput(profileId, name));
  return (model?.sections ?? [])
    .flatMap((s) => [s.heading, ...s.lines.map(plainBody)])
    .join("\n");
}

describe("outdoor planning — one computation, two surfaces (#1724 part 5)", () => {
  it("names the one viable day on BOTH the digest and Upcoming, identically", () => {
    const p = newProfile("plan-scarce");
    seedRideHistory(p);
    seedBehindCardioTarget(p);
    // One dry day two days out, everything else wet — viability is scarce, so the plan
    // is signal.
    seedForecast(p, 2);

    const plans = getOutdoorPlans(p, today(p));
    expect(plans).toHaveLength(1);
    expect(plans[0].bestDate).toBe(shiftDateStr(today(p), 2));
    expect(plans[0].line).toContain("best window for your cycling");
    expect(plans[0].line).toContain("cycling 0/2");

    // The calm Upcoming planning item renders that exact line, banded `week` and with
    // no due date — it is a plan, not a debt.
    const items = upcomingPlanItems(p);
    expect(items).toHaveLength(1);
    expect(items[0].detail).toBe(plans[0].line);
    expect(items[0].band).toBe("week");
    expect(items[0].dueDate).toBeNull();

    // And the digest carries the SAME string as a glance.
    expect(digestText(p, "PlanScarce")).toContain(plans[0].line);
  });

  it("says nothing when EVERY day is viable — the quiet-day rule", () => {
    const p = newProfile("plan-allfine");
    seedRideHistory(p);
    seedBehindCardioTarget(p);
    seedForecast(p, null);
    // Nothing is wet: rewrite the week as uniformly fine.
    const anchor = today(p);
    for (let i = 0; i <= 6; i++) {
      cacheDay(p, shiftDateStr(anchor, i), {
        tempMaxC: 16,
        precipitationMm: 0,
      });
    }

    expect(getOutdoorPlans(p, anchor)).toEqual([]);
    expect(upcomingPlanItems(p)).toEqual([]);
    expect(digestText(p, "PlanAllFine")).not.toContain("best window");
  });

  it("says nothing when NO day is viable — never nag about weather nobody can change", () => {
    // The attention-doctrine case: zero viable days means the outdoor target is not
    // achievable this week, so the honest response is to go quiet, not to escalate.
    const p = newProfile("plan-none");
    seedRideHistory(p);
    seedBehindCardioTarget(p);
    seedForecast(p, null); // every day wet

    expect(getOutdoorPlans(p, today(p))).toEqual([]);
    expect(upcomingPlanItems(p)).toEqual([]);
    expect(digestText(p, "PlanNone")).not.toContain("best window");
  });

  it("says nothing with no cached forecast at all (silence over guessing)", () => {
    const p = newProfile("plan-nodata");
    seedRideHistory(p);
    seedBehindCardioTarget(p);
    // History is cached (the envelope is revealed) but the week ahead is not.
    expect(getOutdoorPlans(p, today(p))).toEqual([]);
    expect(upcomingPlanItems(p)).toEqual([]);
  });

  it("says nothing when the cardio target is already met", () => {
    const p = newProfile("plan-met");
    seedRideHistory(p);
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'type', 'cardio', 1)`
    ).run(p);
    // A ride logged today meets the 1×/week target — nothing is owed, nothing to plan.
    const anchor = today(p);
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'cardio', 'Cycling', 60)`
    ).run(p, anchor);
    seedForecast(p, 2);

    expect(getOutdoorPlans(p, anchor)).toEqual([]);
  });

  it("says nothing for a profile with no OUTDOOR activity to plan", () => {
    const p = newProfile("plan-indoor");
    seedBehindCardioTarget(p);
    const anchor = today(p);
    [10, 12, 14, 16, 18, 20, 22, 24].forEach((t, i) => {
      const date = shiftDateStr(anchor, -(7 * (i + 1)));
      db.prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'cardio', 'Treadmill', 60)`
      ).run(p, date);
      cacheDay(p, date, { tempMaxC: t, precipitationMm: 0 });
    });
    seedForecast(p, 2);

    expect(getOutdoorPlans(p, anchor)).toEqual([]);
  });

  it("is dismissible per week — declining this week never silences next", () => {
    const p = newProfile("plan-dismiss");
    seedRideHistory(p);
    seedBehindCardioTarget(p);
    seedForecast(p, 2);

    const [item] = upcomingPlanItems(p);
    expect(item).toBeDefined();
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
       VALUES (?, ?, datetime('now'))`
    ).run(p, item.key);
    expect(upcomingPlanItems(p)).toEqual([]);

    // The key carries this week's start, so next week's plan is a different key.
    expect(item.key).toContain("cycling");
    expect(item.key.endsWith(today(p))).toBe(true);
  });

  it("creates NO new send — the line rides the digest that already goes out", () => {
    // The digest is assembled from one input; there is no planning-specific dispatcher,
    // marker or channel anywhere. If the plan were its own send, removing every OTHER
    // digest-worthy fact would still produce a message — it must not.
    const p = newProfile("plan-nosend");
    seedRideHistory(p);
    seedBehindCardioTarget(p);
    seedForecast(p, 2);

    const input = gatherDigestInput(p, "PlanNoSend");
    // The plan is a LINE on the shared input, not a channel of its own.
    expect(input.weatherPlanLines?.length).toBe(1);
    const text = digestText(p, "PlanNoSend");
    expect(text).toContain("best window for your cycling");
  });
});
