// DB INTEGRATION TIER — a PAST-DAY reminder's dueness is resolved against the situations
// active ON THAT DAY (#3973), through the real gather rather than the pure resolver.
//
// The thread under test is `collectWindowDoses → gatherWindowDoses → doseDueOn`, reached
// with a date that is not today — which is what a stale Telegram keyboard rebuilding
// yesterday's message (lib/notifications/telegram-callbacks.ts) and the button-liveness
// reconcile (lib/notifications/reconcile.ts) both do. It used to score that day against
// whichever situations were declared RIGHT NOW, beside a `situationsOn` resolver in the
// same function that already dated the adherence strip.
//
// The DERIVED widening (#1292/#1298) dates with it (#3993): a logged period day, a heat
// spell and the night ending a day are all facts about that day, so a past day gets the
// verdict its own data supports rather than an empty set.
//
// AND THE SIBLING SEAM REACHED WITH THE SAME `p.date` (#3994), at the bottom of this
// file: `standingUsualOffer` -> `getUsualRoutineOffer` -> `getPendingRoutineDoses`. Two
// surfaces of one reconcile pass answered "which situations were active on that day"
// two ways, so they are asserted against each other here rather than each against a
// literal — a literal can be wrong twice and still agree with itself.
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  setTimezone,
  setActiveSituations,
  setProfileSetting,
} from "@/lib/settings";
import { resolveSituationId } from "@/lib/settings/profile-attrs";
import {
  diffSituations,
  serializeSituationEvents,
} from "@/lib/trend-annotations";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { collectWindowDoses } from "@/lib/notifications/intake";
import {
  getPendingRoutineDoses,
  pendingDayDoses,
} from "@/lib/queries/usual-routine";
import { createCycleRow } from "@/lib/cycle-store";
import { getIntakeHistory } from "@/lib/intake-history";
import { missedDoseDays } from "@/lib/intake-adherence";
import { setHomeLocation } from "@/lib/settings";
import { runWeatherSync } from "@/lib/integrations/weather-sync";
import type {
  DailyWeatherRow,
  WeatherSource,
} from "@/lib/integrations/open-meteo";
import {
  BUILTIN_HEATWAVE_SITUATION,
  HEATWAVE_ENTER_C,
} from "@/lib/weather-situations";
import {
  BUILTIN_PERIOD_SITUATION,
  BUILTIN_POOR_SLEEP_SITUATION,
} from "@/lib/derived-situations";

let seq = 0;
function newProfile(): number {
  const id = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`Past Day Situations ${seq++}`).lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// A MEDICATION with one Morning dose, either due ON `situation` (`situational`) or a
// plain daily one HELD BY it (#1296's pause hold — the other consumer of the same
// active-situation set). A medication so the #1156 obligation floor can never be what
// decides membership, and `must` so nothing short-circuits ahead of the condition gate.
function seedItem(
  profileId: number,
  name: string,
  situation: string,
  how: "due-on" | "paused-by",
  // How long ago the item came into existence. BOTH seams now apply #430/#1442's
  // `doseWindowSince` on a past day — the routine one always did, the reminder gather
  // since #4011 — so an item born today is dropped from every past day for the LIFETIME
  // reason, which would make each case below green for a rule it is not testing. Every
  // fixture here is therefore aged past the days it reads, leaving the situation set as
  // the only rule left to disagree about.
  ageDays = 30
): void {
  const sid = resolveSituationId(profileId, situation)!;
  const on = how === "due-on";
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, active,
            situation, situation_id, pause_situation_id)
         VALUES (?, ?, 'medication', ?, 'must', 1, ?, ?, ?)`
      )
      .run(
        profileId,
        name,
        on ? "situational" : "daily",
        on ? situation : null,
        on ? sid : null,
        on ? null : sid
      ).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 tab', 'Morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  if (ageDays > 0) {
    const born = `${shiftDateStr(today(profileId), -ageDays)}T00:00:00Z`;
    db.prepare("UPDATE intake_items SET created_at = ? WHERE id = ?").run(
      born,
      itemId
    );
    db.prepare("UPDATE intake_item_doses SET created_at = ? WHERE id = ?").run(
      born,
      doseId
    );
  }
}

// The item names the Morning reminder would carry for `date`.
function morningNames(profileId: number, date: string): string[] {
  return collectWindowDoses(profileId, "Morning", date).map((e) => e.item.name);
}

// Declare `situation` and BACKDATE its start, so the profile arrives at "active since
// day-N" — the state the real writer can only reach by having been toggled then.
function activeSince(profileId: number, situation: string, days: number): void {
  setActiveSituations(profileId, [situation]);
  setProfileSetting(
    profileId,
    "situation_events",
    serializeSituationEvents(
      [],
      diffSituations([], [situation], shiftDateStr(today(profileId), -days))
    )
  );
}

const ITEM = "Loratadine";

describe("a past-day reminder scores against that day's situations (#3973)", () => {
  // Both directions of one toggle. `before`/`after` are [past day, today] membership, and
  // the BEFORE row is asserted first: without it "the past day did not change" is equally
  // true of a fixture whose dose could never appear on any day.
  it.each([
    {
      what: "declared TODAY does not reach back",
      how: "due-on" as const,
      seed: (_p: number) => {},
      toggle: (p: number) => setActiveSituations(p, ["Travel"]),
      before: [false, false],
      after: [false, true],
    },
    {
      what: "un-declared TODAY does not erase a day it was on",
      how: "due-on" as const,
      seed: (p: number) => activeSince(p, "Travel", 5),
      toggle: (p: number) => setActiveSituations(p, []),
      before: [true, true],
      after: [true, false],
    },
    {
      // The PAUSE hold (#1296) reads the same set, so it dates with it: declaring the
      // pausing situation today must not retroactively silence a day it was owed.
      what: "a pause situation declared TODAY does not silence a past day",
      how: "paused-by" as const,
      seed: (_p: number) => {},
      toggle: (p: number) => setActiveSituations(p, ["Travel"]),
      before: [true, true],
      after: [true, false],
    },
  ])("$what", ({ how, seed, toggle, before, after }) => {
    const p = newProfile();
    seedItem(p, ITEM, "Travel", how);
    const past = shiftDateStr(today(p), -2);
    seed(p);

    // PRECONDITION — the fixture really is in the state this case claims to start from.
    expect([
      morningNames(p, past).includes(ITEM),
      morningNames(p, today(p)).includes(ITEM),
    ]).toEqual(before);

    toggle(p);

    expect([
      morningNames(p, past).includes(ITEM),
      morningNames(p, today(p)).includes(ITEM),
    ]).toEqual(after);
  });
});

// A sleep_min session on `wakeDay` of `minutes` (window ending at wake time), stored as
// UTC instants so wall clock == instant under the UTC profile above.
function night(wakeDay: string, minutes: number): NormMetricSample {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return {
    metric: "sleep_min",
    date: wakeDay,
    started_at: `${shiftDateStr(wakeDay, -1)}T23:00:00Z`,
    ended_at: `${wakeDay}T${h}:${m}:00Z`,
    value: minutes,
  };
}

describe("the derived widening is DATED, not today-only (#3993)", () => {
  it("a rough night reaches today, and a past day with a healthy night stays empty", () => {
    const p = newProfile();
    seedItem(p, "Magnesium Glycinate", "Poor sleep", "due-on");
    const anchor = today(p);
    // Six ~8h nights, then 5h last night → a MEASURED rough night on today.
    const nights = [1, 2, 3, 4, 5, 6].map((i) =>
      night(shiftDateStr(anchor, -i), 480)
    );
    upsertMetricSamples(p, [...nights, night(anchor, 300)], "health-connect");

    // Today's reminder sees it through the declared ∪ derived union...
    expect(morningNames(p, anchor)).toContain("Magnesium Glycinate");
    // ...and days 1-3 do not — NOT because a past day may not hold a derived verdict,
    // but because the night ending each of those days was a healthy 8h. The dated
    // widening answers each day from that day's own data; here it answers no.
    for (const d of [1, 2, 3])
      expect(morningNames(p, shiftDateStr(anchor, -d))).toEqual([]);
  });
});

// ── THE DERIVED HALF IS DATED TOO (#3993) ────────────────────────────────────────────
//
// Owner ruling, 2026-08-31. The declared half above dates through the #654 change log.
// The derived half used to be dropped from every past day on the stated ground that
// derived context "cannot be dated" — and it can, for all three of its sources: a logged
// period day is a span in the cycle record, a heat spell is a fact in the cached daily
// series, and a rough night is the night ENDING that day measured against the baseline
// before it, through the same pure threshold the coaching engine calls.
//
// A RETROACTIVE VERDICT READS DATA AS STORED NOW. A night that syncs late changes the
// verdict for its day — like every other read this app makes of a past day, and the
// reason the reminder rebuild re-derives rather than replaying.
//
// Each row seeds its source to hold on day-2 and NOT on day-5, and asserts BOTH days in
// one object: "due on day-2" alone is equally satisfied by a widening that never turns
// off, which is the failure the today-only branch was standing in for.
function dailySource(rows: DailyWeatherRow[]): WeatherSource {
  return {
    id: "fixture",
    async fetchHourly() {
      return { ok: true, rows: [] };
    },
    async fetchDaily() {
      return { ok: true, rows };
    },
  };
}

function weatherDay(date: string, tempMaxC: number): DailyWeatherRow {
  return {
    date,
    tempMaxC,
    tempMinC: null,
    pressureMslHpa: null,
    precipitationMm: null,
    weatherCode: null,
    uvIndexMax: null,
    aqi: null,
    pollenTree: null,
    pollenWeed: null,
    pollenGrass: null,
  };
}

describe("a past day gets the derived verdict its own data supports (#3993)", () => {
  it.each([
    {
      what: "the night ending that day was rough",
      situation: BUILTIN_POOR_SLEEP_SITUATION,
      async seed(p: number, anchor: string) {
        // Healthy 8h nights back to day-9, then 5h on the night ending day-2. The night
        // ending day-5 is one of the healthy ones, so the same fixture answers NO there.
        const nights: NormMetricSample[] = [];
        for (let d = 9; d >= 3; d--)
          nights.push(night(shiftDateStr(anchor, -d), 480));
        nights.push(night(shiftDateStr(anchor, -2), 300));
        upsertMetricSamples(p, nights, "health-connect");
      },
    },
    {
      what: "a logged period covered that day",
      situation: BUILTIN_PERIOD_SITUATION,
      async seed(p: number, anchor: string) {
        // The issue's own measurement: ONE logged, closed period covering day-4 through
        // day-0. `periodOnDate` answers true for every one of those days; the past-day
        // gather used to return [] for all of them. A cycle row also makes cycle
        // tracking relevant, so the built-in Period situation applies.
        createCycleRow(p, shiftDateStr(anchor, -4), anchor, "medium", null);
      },
    },
    {
      what: "a heat spell covered that day",
      situation: BUILTIN_HEATWAVE_SITUATION,
      async seed(p: number, anchor: string) {
        // 0.1° is the storage precision, and the daily cache is keyed by coarse
        // location — so each fixture profile needs its own coordinate or one test's
        // series becomes another's weather.
        setHomeLocation(p, { lat: 20 + (p % 300) / 10, lng: -74 });
        // HEATWAVE_MIN_DAYS consecutive days at/above the enter bound ending on day-2.
        // A spell's first days are marked on retroactively, so day-4, day-3 and day-2
        // all hold; day-5 is mild and outside it.
        const rows: DailyWeatherRow[] = [];
        for (let d = 9; d >= 2; d--)
          rows.push(
            weatherDay(
              shiftDateStr(anchor, -d),
              d <= 4 ? HEATWAVE_ENTER_C + 3 : 18
            )
          );
        await runWeatherSync(p, dailySource(rows));
      },
    },
  ])("$what", async ({ situation, seed }) => {
    const p = newProfile();
    seedItem(p, ITEM, situation, "due-on");
    const anchor = today(p);
    await seed(p, anchor);

    // ONE assertion carrying both halves: the day the source held, and a day it did not.
    expect({
      "day-2": morningNames(p, shiftDateStr(anchor, -2)).includes(ITEM),
      "day-5": morningNames(p, shiftDateStr(anchor, -5)).includes(ITEM),
    }).toEqual({ "day-2": true, "day-5": false });
  });
});

// WHICH past day. The cases above pin "a past day is not today"; on their own they are
// equally satisfied by a gather that scores day-2 against day-3's situations, because
// none of their fixtures carries a transition INSIDE the span they look at. These two
// put the transition in the middle of the span and read every day either side of it, so
// the date the resolver is asked about is pinned and not merely its distance from today.
//
// The two directions are ASYMMETRIC, and that is the point of having both:
// `situationsActiveOn` decides a day by its earliest transition STRICTLY after it
// (`e.date > date`), so a start dated day-3 is already ON on day-3, while a stop dated
// day-3 is already OFF on day-3. A fixture that got the boundary backwards would still
// satisfy a symmetric assertion.

// Backdate a completed span: declared on day-`from`, un-declared on day-`to`, leaving
// the situation NOT declared now — the state the real writer reaches by two toggles.
function activeBetween(
  profileId: number,
  situation: string,
  from: number,
  to: number
): void {
  setActiveSituations(profileId, []);
  const anchor = today(profileId);
  setProfileSetting(
    profileId,
    "situation_events",
    serializeSituationEvents(
      [],
      [
        ...diffSituations([], [situation], shiftDateStr(anchor, -from)),
        ...diffSituations([situation], [], shiftDateStr(anchor, -to)),
      ]
    )
  );
}

// Is the situational item on the Morning reminder for each of these past days?
function dueByDay(
  profileId: number,
  offsets: number[]
): Record<string, boolean> {
  return Object.fromEntries(
    offsets.map((d) => [
      `day-${d}`,
      morningNames(profileId, shiftDateStr(today(profileId), -d)).includes(
        ITEM
      ),
    ])
  );
}

describe("WHICH past day the reminder is scored against (#3973)", () => {
  it("a situation that STARTED on day-3 is off before it and on from it", () => {
    const p = newProfile();
    seedItem(p, ITEM, "Travel", "due-on");
    activeSince(p, "Travel", 3);

    expect(dueByDay(p, [4, 3, 2])).toEqual({
      "day-4": false, // the day before the start
      "day-3": true, // the start day itself is INSIDE the span
      "day-2": true,
    });
  });

  it("a situation that STOPPED on day-3 is on before it and off from it", () => {
    const p = newProfile();
    seedItem(p, ITEM, "Travel", "due-on");
    activeBetween(p, "Travel", 7, 3);

    expect(dueByDay(p, [5, 4, 3, 2])).toEqual({
      "day-5": true,
      "day-4": true, // the day before the stop
      "day-3": false, // the stop day itself is OUTSIDE the span
      "day-2": false,
    });
  });
});

// ── THE SIBLING SEAM, AND WHY THIS IS AN AGREEMENT TEST (#3994) ──────────────
//
// `reconcile.ts` hands the SAME `p.date` to `collectWindowDoses` and, for a `usual:`
// token, to `standingUsualOffer` → `getUsualRoutineOffer` → `getPendingRoutineDoses`.
// That date is genuinely past: the token rides family `intake-dose`, whose reconcile
// guard is `isDoseDateAccepted` over `DOSE_LOG_DATE_WINDOW_DAYS` = 2. Until #3964 the
// routine half resolved situations through `getEffectiveActiveSituations`, whose
// declared component is an undated "active = 1" read, so one pass told a person two
// different things about one day: the reminder correctly dropped a dose that was never
// owed while the offer still claimed it, and the reminder correctly restored a day's
// owed dose while the offer had already forgotten it.
//
// Asserted as EQUALITY BETWEEN THE TWO SEAMS, not as two literals: before #3989 both
// halves were wrong in the same direction and agreed, so a pair of literals would have
// passed on that tree for the wrong reason. The expected value is carried alongside so
// a fixture that renders both seams empty cannot pass as "agreement".
//
// SCOPED TO THE SITUATION SET, and the name now says so (#4019). Every fixture here is
// a situational or paused item with NO ACTIVITY ROWS AT ALL, so the workout axis of the
// same two functions is untouched by it — and the earlier name ("answers a past day
// exactly as the reminder does") read as a claim about the whole seam, which is how a
// draft husk and a missing lifetime clamp survived underneath it. The activity-carrying
// half lives in reminder-past-day-agreement.test.ts.
describe("the routine offer answers a past day's SITUATIONS as the reminder does (#3994)", () => {
  // Both seams, one day, as a triple: [reminder, routine offer, what the day owed].
  function bothOn(profileId: number, date: string): [boolean, boolean] {
    return [
      morningNames(profileId, date).includes(ITEM),
      getPendingRoutineDoses(profileId, "Morning", date)
        .map((d) => d.name)
        .includes(ITEM),
    ];
  }

  // WHICH past day, not merely "a past day". The two shapes below put the transition
  // INSIDE the span each reads, and the asymmetry is `situationsActiveOn`'s own: a start
  // dated day-3 is already ON on day-3, a stop dated day-3 is already OFF on day-3. A
  // resolver reading day-2's situations for day-3 (or the reverse) lands on the wrong
  // side of exactly one of these rows.
  it.each([
    {
      what: "declared TODAY reaches neither seam's past day",
      seed: (p: number) => setActiveSituations(p, ["Travel"]),
      owed: { "day-3": false, "day-2": false, "day-1": false },
    },
    {
      what: "STARTED on day-3: off the day before it, on from it",
      seed: (p: number) => activeSince(p, "Travel", 3),
      owed: { "day-4": false, "day-3": true, "day-2": true },
    },
    {
      what: "STOPPED on day-3, un-declared now: on before it, off from it",
      seed: (p: number) => activeBetween(p, "Travel", 7, 3),
      owed: { "day-5": true, "day-4": true, "day-3": false, "day-2": false },
    },
  ])("$what", ({ seed, owed }) => {
    const p = newProfile();
    // Aged past every day read below, so BOTH seams' lifetime clamp is a no-op and the
    // only rule left to disagree about is the situation set (see seedItem).
    seedItem(p, ITEM, "Travel", "due-on", 30);
    seed(p);
    for (const [label, expected] of Object.entries(owed)) {
      const date = shiftDateStr(today(p), -Number(label.slice(4)));
      // One assertion carrying both halves of the claim: the two seams agree, AND they
      // agree on the day's real answer rather than on a shared blank.
      expect({ [label]: bothOn(p, date) }).toEqual({
        [label]: [expected, expected],
      });
    }
  });
});

// ── ONE ANSWER PER DAY, ACROSS BOTH CATCH-UP SURFACES (#221/#3993) ───────────────────
//
// Dating the union is only half the fix. The reminder rebuild and the catch-up sheet
// ask "was this owed on that day"; so does the adherence strip beside them, through
// `getIntakeHistory`. Give those two questions different resolvers and the sheet offers
// a dose the strip scores `na` — and a dose logged through that offer is dropped from
// the percentage entirely, because the strip returns `na` before it ever consults the
// log. So every dueness surface now reads the SAME dated resolver.
//
// THE PAUSE IS THE DIRECTION THAT BITES. #1296's hold reads the same active set, so
// widening the set SILENCES: a `daily` `must` medication held by Poor sleep drops out
// of a rough day. That is what the app did live on that day, and the strip now agrees
// instead of calling the day missed — which is the whole point. It is also why the
// pause case below asserts the strip cell, not just the two gathers.
function stripCellOn(
  profileId: number,
  date: string,
  itemName: string
): string {
  const entry = getIntakeHistory(profileId, today(profileId), 14).find(
    (e) => e.item.name === itemName
  );
  return entry?.strip.find((d) => d.date === date)?.state ?? "absent";
}

describe("the strip, the reminder and the sheet answer a day the same way (#3993)", () => {
  it("a rough night makes the day owe the dose, and the strip says so too", () => {
    const p = newProfile();
    seedItem(p, ITEM, BUILTIN_POOR_SLEEP_SITUATION, "due-on");
    const anchor = today(p);
    const nights: NormMetricSample[] = [];
    for (let d = 9; d >= 3; d--)
      nights.push(night(shiftDateStr(anchor, -d), 480));
    nights.push(night(shiftDateStr(anchor, -2), 300));
    upsertMetricSamples(p, nights, "health-connect");
    const d2 = shiftDateStr(anchor, -2);

    // Reminder, sheet and strip in ONE object: any two of them disagreeing is the bug.
    expect({
      reminder: morningNames(p, d2).includes(ITEM),
      sheet: pendingDayDoses(p, d2).some((d) => d.name === ITEM),
      strip: stripCellOn(p, d2, ITEM),
    }).toEqual({ reminder: true, sheet: true, strip: "missed" });
  });

  it("a derived PAUSE removes the day from all three, and nothing calls it missed", () => {
    const p = newProfile();
    // A daily `must` medication HELD by Poor sleep (#1296) — the inverse link, so the
    // derived context takes the dose away rather than adding it.
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, kind, condition, obligation, active, pause_situation_id)
           VALUES (?, ?, 'medication', 'daily', 'must', 1, ?)`
        )
        .run(
          p,
          "Levothyroxine",
          resolveSituationId(p, BUILTIN_POOR_SLEEP_SITUATION)
        ).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 tab', 'Morning', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    const born = `${shiftDateStr(today(p), -30)}T00:00:00Z`;
    db.prepare("UPDATE intake_items SET created_at = ? WHERE id = ?").run(
      born,
      itemId
    );
    db.prepare("UPDATE intake_item_doses SET created_at = ? WHERE id = ?").run(
      born,
      doseId
    );

    const anchor = today(p);
    const nights: NormMetricSample[] = [];
    for (let d = 9; d >= 3; d--)
      nights.push(night(shiftDateStr(anchor, -d), 480));
    nights.push(night(shiftDateStr(anchor, -2), 300));
    upsertMetricSamples(p, nights, "health-connect");
    const d2 = shiftDateStr(anchor, -2);
    const d3 = shiftDateStr(anchor, -3);

    // day-3 is the single-variable control: same medication, healthy night, still owed.
    // Without it "day-2 is empty" is equally true of a fixture that owes nothing ever.
    expect({
      heldReminder: morningNames(p, d2).includes("Levothyroxine"),
      heldSheet: pendingDayDoses(p, d2).some((d) => d.name === "Levothyroxine"),
      heldStrip: stripCellOn(p, d2, "Levothyroxine"),
      heldMissed: missedDoseDays(
        getIntakeHistory(p, anchor, 14).find(
          (e) => e.item.name === "Levothyroxine"
        )!.strip
      ).includes(d2),
      controlReminder: morningNames(p, d3).includes("Levothyroxine"),
      controlStrip: stripCellOn(p, d3, "Levothyroxine"),
    }).toEqual({
      heldReminder: false,
      heldSheet: false,
      heldStrip: "na",
      heldMissed: false,
      controlReminder: true,
      controlStrip: "missed",
    });
  });

  // The reminder LINE carries its own adherence figure, computed from the same strip.
  // Built through a declared-only resolver it had a zero denominator, so a Poor-sleep
  // item printed as due with no percentage and no dots — a dose named as owed on a
  // closed day with nothing on the line saying why.
  it("the reminder line can state the adherence of a derived-reason dose", () => {
    const p = newProfile();
    seedItem(p, ITEM, BUILTIN_POOR_SLEEP_SITUATION, "due-on");
    const anchor = today(p);
    const nights: NormMetricSample[] = [];
    for (let d = 9; d >= 3; d--)
      nights.push(night(shiftDateStr(anchor, -d), 480));
    nights.push(night(shiftDateStr(anchor, -2), 300));
    upsertMetricSamples(p, nights, "health-connect");

    const entry = collectWindowDoses(p, "Morning", shiftDateStr(anchor, -2))[0];
    expect({
      name: entry?.item.name,
      pct: entry?.adherence.pct,
      applicableDays: entry?.adherence.applicableDays,
      // 0%, not null: the dose was owed that day and nothing was logged. The figure
      // being ZERO is the point — a declared-only strip had no applicable day at all,
      // so `pct` was null and the line printed a due dose with no adherence column.
    }).toEqual({ name: ITEM, pct: 0, applicableDays: 1 });
  });
});
