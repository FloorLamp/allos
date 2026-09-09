// DB INTEGRATION TIER — the notification tick's statement budget (#5199).
//
// WHY THIS FILE EXISTS. Three budget gates walk a ROUTE — the dashboard
// (dashboard-placement-manifest.test.ts), /sleep (sleep-page-budget.test.ts) and the
// Trends Overview (trends-overview-budget.test.ts). None of them walks a tick, and two
// separate falsifying passes on #5128 hit that gap and each recorded it as "could not
// test": `getDerivedSituationLines` and `getReportedBurden` had each started building
// their own resolver, two reads apiece, where they used to come out of the tick memo.
// Four extra reads against a 274-query dashboard is noise, which is why #5128 merged —
// the point is that nothing would have noticed a larger one. A page render that got
// slower is felt; a tick that got slower is not.
//
// IS A TICK BUDGETABLE IN THE SHAPE THE OTHER THREE USE? #5199 asks that first, and the
// answer is: its GATHERS are, and the tick around them is not. `tickProfile` iterates
// profiles, awaits sends over a network, and writes send markers — a statement count
// over that would be measuring the dispatch stubs. `gatherDigestInput` and
// `gatherRecapInput` are synchronous reads that return a model, so each is exactly the
// shape `renderPage` is measured in, and they are the halves #5128 moved. What this
// gate therefore does NOT cover is stated at the bottom of this file rather than left
// to be inferred from its silence.
//
// NO REQUEST CACHE, ON PURPOSE, and that is the one way this differs from the page
// gates. They mock `lib/request-cache` with a real memo because a Next request has one;
// a tick does not, and `lib/request-cache.ts` degrades `cache()` to identity outside a
// server request deliberately. So this file mocks nothing: the numbers below are what
// the sidecar actually pays, memoized only by `lib/tick-cache.ts`, which is the tick's
// own lifetime and is opened here exactly where `scripts/notify.ts` opens it.
//
// EXACT EQUALITY, NEVER A CEILING. A ceiling absorbs a regression silently; the recorded
// map is what kept sleep-page-budget honest across three rounds of #5128, so the same
// discipline applies here. And the map is only as honest as the population it was
// measured over, which is what the floor test below is for: four censuses shipped blind
// to part of their population on 2026-09-04 alone.

import { beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import { db, today, writeTx } from "@/lib/db";
import { utcInstant, shiftDateStr } from "@/lib/date";
import { zonedWallTimeToUtc } from "@/lib/calendar-ics";
import { reconcileFlags } from "@/lib/queries";
import { saveFitnessEntry } from "@/lib/fitness-assessment";
import { recordGlucoseTrace } from "@/lib/glucose-trace-db";
import { getTimezone } from "@/lib/settings";
import { seedStandardMetricSaves } from "@/lib/standard-metric-seeds";
import { episodesForSituation } from "@/lib/symptom-episode";
import {
  diffSituations,
  serializeSituationEvents,
} from "@/lib/trend-annotations";
import {
  completeOnboardingState,
  initialOnboardingState,
  normalizeOnboardingFocuses,
  serializeOnboardingState,
} from "@/lib/onboarding";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { gatherRecapInput } from "@/lib/notifications/recap-data";
import { runInTickScope } from "@/lib/tick-cache";
import { PERSONAS, type PersonaContext } from "../../scripts/seed-personas";
import { installStatementTrace } from "@/lib/__db_tests__/dashboard-render-harness";

const digestCounts = new Map<string, number>();
const recapCounts = new Map<string, number>();

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// The persona seeding context, as the two route budgets build it — the personas are the
// shared fixture, so a tick and a render are measured against the same six people.
function ctxFor(profileId: number): PersonaContext {
  const daysAgo = (n: number) => shiftDateStr(today(profileId), -n);
  return {
    db,
    profileId,
    daysAgo,
    shiftDateStr,
    occurredAt: (day, hhmm) => {
      const [y, m, d] = day.split("-").map(Number);
      const [h, min] = hhmm.split(":").map(Number);
      return utcInstant(
        zonedWallTimeToUtc(y, m, d, h, min, getTimezone(profileId))
      );
    },
    reconcileFlags,
    saveFitnessEntry: (pid, entry) => saveFitnessEntry(pid, entry, "page"),
    recordGlucoseTrace,
    seedStandardMetricSaves: (pid) => seedStandardMetricSaves(db, pid),
    writeTx,
    diffSituations,
    serializeSituationEvents,
    episodesForSituation,
    onboardingStateJson: (profilePath, focuses) =>
      serializeOnboardingState(
        completeOnboardingState(
          {
            ...initialOnboardingState(),
            profilePath,
            focuses: normalizeOnboardingFocuses(focuses),
            basicsComplete: true,
            dataReviewed: true,
            notificationIntent: "later",
            notificationsReviewed: true,
            checklistDismissed: true,
          },
          new Date().toISOString()
        )
      ),
  };
}

describe("notification tick gather query budget (#5199)", () => {
  beforeEach(() => vi.setSystemTime(new Date("2026-08-18T13:00:00.000Z")));
  beforeAll(async () => {
    // The instant the two route budgets pin, for the same reason: a recap's week window
    // is a different number of days on a different weekday, so an unpinned clock would
    // move these counts by the day of the week rather than by anything in the code.
    vi.setSystemTime(new Date("2026-08-18T13:00:00.000Z"));
    const trace = installStatementTrace({});
    for (const persona of PERSONAS) {
      const profileId = newProfile(`tick:${persona.name}`);
      persona.apply(ctxFor(profileId));
      // ONE SCOPE PER PROFILE, which is what `scripts/notify.ts` opens and closes around
      // each profile's tick, so the tick memo has the lifetime it has in production.
      await runInTickScope(
        async () => {
          trace.clear();
          gatherDigestInput(profileId, persona.title);
          digestCounts.set(persona.name, trace.count());
          trace.clear();
          // The SEND-shaped weekly gather (`runRecap`'s own call): a completed week, as
          // of the profile's today, with the substance consent asked.
          gatherRecapInput(
            profileId,
            "kg",
            "week",
            true,
            today(profileId),
            true
          );
          recapCounts.set(persona.name, trace.count());
        },
        { profileId }
      );
    }
  }, 300_000);

  // Recorded per persona and per gather, measured on the merged tree. A number that
  // moves is a conversation, not a value to bump — the discipline the dashboard manifest
  // states at length and this file borrows whole.
  //
  // THE FIRST THING THESE NUMBERS SAY is that the hourly digest gather costs MORE THAN A
  // WHOLE DASHBOARD RENDER: 422-529 statements per persona against the dashboard's 274
  // backstop, and it runs once an hour per profile against a page nobody loads that
  // often. That is not a regression this gate caught; it is the standing cost, recorded
  // here for the first time because nothing had ever counted it. Whether it is too much
  // is a design question, and one that can now be asked with a number.
  //
  // THE RECAP IS THE CHEAP HALF and its spread is the informative part: `household` at
  // 43 against 110 for the two training personas. The weekly recap reads what a profile
  // has, so a persona with no training log skips most of the gather — which is also why
  // a single averaged number would have said nothing.
  //
  // THEY CAME DOWN BY 12 (14 for `biohacker`) IN #5064, and the mechanism is named
  // rather than guessed: the weekly-target rollup used to read TWO week windows —
  // today's and yesterday's — because the dashboard's met-target promotion needed a
  // prior comparable verdict. That promotion is gone, so the rollup reads one window,
  // and each dropped window cost `getWeekMode` + `getWeekStart` (weekWindowStartOn)
  // plus a timezone read per call of `getFrequencyTargetProgress`. The saving is 12
  // everywhere except `biohacker` at 14; how many times each persona's gather reaches
  // that rollup is not something this file measures, so no reason for the 14 is
  // offered here.
  //
  // THEY WENT UP BY 2 EVERYWHERE IN #5321, and the mechanism is ONE read in
  // `scheduledDoseRows` — which is not a function the digest names anywhere, so the path
  // is worth writing down: `gatherDigestInput` reads `collectUpcoming`
  // (notifications/digest-data.ts), `collectUpcoming` includes `doseItems`
  // (queries/upcoming/generators.ts), and `doseItems` is `scheduledDoseRows`
  // (queries/upcoming/intake-safety.ts). That function used to assemble four of the
  // intake day context's five fields; it now asks the shared builder, which answers the
  // fifth — `postWorkoutReady`, whether the earliest logged session has ended — and
  // knowing the current minute means resolving the profile's timezone through
  // `lib/settings.getTimezone`, an unmemoized read this path did not make before.
  // Uniform across all six personas because every one of them reaches the Today list.
  //
  // ATTRIBUTED BY MEASUREMENT, not by reading the diff, because the diff's other
  // conversions look equally plausible from here and are not. Reverting ONLY
  // `scheduledDoseRows` reproduces the whole delta and nothing else does — 468→466,
  // 481→479, 424→422, 431→429, 456→454, 531→529, the recorded pre-#5321 map exactly.
  // The recap gather is unmoved because it does not read `collectUpcoming`.
  //
  // AND THE CALL THAT DOES NOT MOVE IT IS WALKED ANYWAY — a correction to what this
  // comment said on its first two passes, and the reason the persona below exists.
  // `gatherDigestInput` holds ONE `getOfferedIntakeForSlot` call (the second lives in
  // `collapsedDigestActions`, reached only from the async keyboard refresh this harness
  // never walks). It was recorded here as "not on the counted path". It IS on it:
  // stubbing it out drops EVERY persona by exactly one statement. What it does not do is
  // move with the conversion, and the reason is a property of the FIXTURE rather than of
  // the path — the query reads the profile's active `may` rows first and returns early
  // when there are none, so the shared day-context build the conversion changed was
  // never reached. A persona that gains such an item moves the number, and until #5321
  // not one persona's own profile had one (the two `may` items in scripts/
  // seed-personas.ts belong to family members, not to the profile these gathers run for).
  //
  // SO THE NUMBER IS NOW REAL, and `bodybuilder` is the persona that makes it so: Marcus
  // gained an on-demand post-workout supplement, and his digest gather went 468 → 475.
  // Measured the same way: with that item present, stubbing the call drops him by EIGHT
  // rather than by one — the `may` row read plus the shared builder behind it (the day's
  // activities, the effective situations, the inferred prediction, the timezone the
  // session-end comparison needs) and the pause-name lookup beside it. The other five are
  // unchanged at their recorded values, which is the control: one persona holds the item,
  // one persona's number moved.
  const DIGEST_BASELINE: Record<string, number> = {
    bodybuilder: 475,
    "marathon-runner": 481,
    household: 424,
    pregnant: 431,
    "diabetic-cgm": 456,
    biohacker: 531,
  };
  const RECAP_BASELINE: Record<string, number> = {
    bodybuilder: 110,
    "marathon-runner": 109,
    household: 43,
    pregnant: 80,
    "diabetic-cgm": 80,
    biohacker: 110,
  };

  // THE FLOOR, AND WHY IT IS THE FIRST TEST. A budget that walks an empty or truncated
  // population passes green and says nothing: every recorded number is satisfied, and
  // the thing being measured never ran. So this asserts the population BEFORE the
  // numbers — the personas it expected to walk, and that each one drove both gathers
  // into a non-zero count. A persona whose gather threw never reaches this at all,
  // because `beforeAll` throws rather than skipping it.
  it("walked every persona and each one drove both gathers", () => {
    const expected = PERSONAS.map((p) => p.name);
    expect([...digestCounts.keys()]).toEqual(expected);
    expect([...recapCounts.keys()]).toEqual(expected);
    const silent = expected.filter(
      (name) => digestCounts.get(name) === 0 || recapCounts.get(name) === 0
    );
    expect(
      silent,
      "A persona produced ZERO statements from a gather. Either the fixture stopped\n" +
        "reaching the reader or the gather stopped reading — and both make every\n" +
        "number below a claim about nothing."
    ).toEqual([]);
  });

  it("digest gather stays at its recorded per-persona counts", () => {
    expect(Object.fromEntries(digestCounts)).toEqual(DIGEST_BASELINE);
  });

  it("recap gather stays at its recorded per-persona counts", () => {
    expect(Object.fromEntries(recapCounts)).toEqual(RECAP_BASELINE);
  });
});

// WHAT THIS GATE DOES NOT COVER, said out loud because its silence would otherwise read
// as coverage — the exact failure #5199 was filed about.
//
//   • The tick AROUND the gathers: `planProfileDigestTick`, `logDigestTick`, the
//     preventive/redose/refill notices, the reconcile sweep and `syncIntegrations`.
//     Those interleave awaited dispatches with reads, so a statement count over them
//     would be counting the stubs as much as the app.
//   • Every scale but the completed WEEK. A monthly or quarterly recap reads a longer
//     window; the week is the cadence that actually fires most often.
//   • Wall time. This counts statements, exactly like the three route budgets; the
//     profiler (docs/internals/profiling.md) is where time is measured.
