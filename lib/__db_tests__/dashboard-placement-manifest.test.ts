// Real-schema row census and query budget for Home (#3096, retargeted by #5435 PR 2).
//
// WHAT THIS FILE MEASURES CHANGED WITH THE PAGE, and the meter is the part that did
// not. Home was a ranker: it built candidates, ranked them into four lanes and handed
// a placement ARRAY to one canvas component, so a census read that array off the
// canvas' props. v3 has no ranker and no canvas — every row has a fixed seat, decided
// by `lib/home-list.ts` and rendered as itself — so the census reads the rows the page
// actually renders, by the row contract's `data-candidate-id` (#5435 §5.1).
//
// The ranker's own assertions (Standing order and caps, the Ahead band, the Show
// everything tail and its fold, the four-lane placement of each persona's candidates)
// went with it. They are not replaced here and are not missing: the families they
// describe left Home by §4, and their modules — `lib/dashboard-relevance.ts`,
// `lib/dashboard-standing.ts`, the candidate directory and the canvas — are deleted in
// PR 3 with whatever of their own coverage outlives them. What must not be lost in
// that handover is THIS meter, which is why it is the part written out in full below.
//
// THE RENDER IS WALKED, NOT JUST AWAITED (#5435 §6.1). Home streams the glance card
// and Setup behind Suspense boundaries, so awaiting `Dashboard()` alone would return a
// shell and count none of their gathers — a boundary would read as a saving. The
// harness resolves the tree, which runs every async section, so what is counted is
// still the whole page.
//
// WHAT THIS GATE DOES NOT COVER, because its silence would otherwise read as coverage
// (#5199). It walks ONE ROUTE RENDER per persona with a request cache open. The
// notification tick runs the same query layer with `cache()` degraded to identity and
// no route at all — that is tick-gather-budget.test.ts, whose digest gather costs more
// per profile than a whole render here. Wall time is docs/internals/profiling.md's.

import type { ReactElement } from "react";
import { beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import { db, today, writeTx } from "@/lib/db";
import { utcInstant, shiftDateStr } from "@/lib/date";
import { zonedWallTimeToUtc } from "@/lib/calendar-ics";
import { reconcileFlags } from "@/lib/queries";
import { saveFitnessEntry } from "@/lib/fitness-assessment";
import { recordGlucoseTrace } from "@/lib/glucose-trace-db";
import { getTimezone, setWeekMode } from "@/lib/settings";
import { perTestCeiling } from "../../vitest.timeouts";
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
import { PERSONAS, type PersonaContext } from "../../scripts/seed-personas";
import {
  allProfileIds,
  HR_RANGE_READ,
  installStatementTrace,
  loadDashboard,
  profilesForIds as profiles,
  requestCache,
  resolveAsyncTree,
  session,
} from "@/lib/__db_tests__/dashboard-render-harness";
import { ALCOHOL_FOOD_GROUP } from "@/lib/substance-use";

vi.mock("@/lib/request-cache", async () =>
  (
    await import("@/lib/__db_tests__/dashboard-render-harness")
  ).requestCacheModule()
);
vi.mock("@/lib/auth", async (importActual) =>
  (await import("@/lib/__db_tests__/dashboard-render-harness")).authModule(
    await importActual()
  )
);
vi.mock("@/lib/scope", async (importActual) =>
  (await import("@/lib/__db_tests__/dashboard-render-harness")).scopeModule(
    await importActual(),
    await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth")
  )
);
vi.mock("@/lib/ai-log", async (importActual) =>
  (await import("@/lib/__db_tests__/dashboard-render-harness")).aiLogModule(
    await importActual()
  )
);
vi.mock("@/lib/recommendation-engine", async (importActual) =>
  (
    await import("@/lib/__db_tests__/dashboard-render-harness")
  ).recommendationEngineModule(await importActual())
);

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

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
    saveFitnessEntry: (profileId, entry) =>
      saveFitnessEntry(profileId, entry, "page"),
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

// #5010's last acceptance criterion, and it is a claim about ARGUMENTS rather than
// about a count. The owner's profile over a production snapshot saw three `hr_minutes`
// range reads per render, down from four, and could not tell from the trace whether
// three reads meant three windows or one window asked for three times — both print 3,
// and only one of them is correct. So each execution is keyed on the span it was BOUND
// to, the way #5055's probe keyed its reads on their profile ids.
//
// THE WINDOW IS THE BOUND SPAN, NOT THE ARGUMENTS THE CALLER SPELLED. `getHrMinutesInRange`
// is memoized on `(profileId, since, until)`, so a duplicate of that tuple is already
// impossible under the request cache — an assertion keyed on it could only ever restate
// the memo. What the memo cannot see is two DIFFERENT spellings resolving to one span —
// #5069 has since required `until`, which retires the spelling that used to do it — and
// that is a second full materialisation of the same rows. Keying on the statement's
// parameters catches both that and a memo that stopped collapsing at all. The pattern
// itself lives in the harness, because the profiler prints the same read's windows.
/** Render name → the windows its `hr_minutes` range reads were bound to, in order. */
const hrWindowReads = new Map<string, string[]>();
/**
 * The hand-built heart-rate render, on its own profile after the persona loop, so it
 * cannot move a single number in QUERY_BASELINE. It was the ONLY render here with
 * heart-rate minutes until #5034 gave `biohacker` a trace; it stays because it is the
 * POSITIVE CONTROL — it seeds the seam directly, so it reds if the reader or the SQL
 * moves, where a persona-only check would go quietly vacuous if the seed ever changed.
 */
const HR_FIXTURE = "hr-minutes fixture";

function windowsRead(
  trace: ReturnType<typeof installStatementTrace>
): string[] {
  return trace.bindings().map((execution) => JSON.stringify(execution.args));
}

/** Drink and dry evenings, so the alcohol pair reaches its overnight outcome series. */
function seedDrinkEvenings(profileId: number, days: number): void {
  const insert = db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, date, group_key)
       DO UPDATE SET servings = excluded.servings`
  );
  const td = today(profileId);
  for (let back = 1; back <= days; back++) {
    const day = shiftDateStr(td, -back);
    // A dry evening has to be a LOGGED evening — the pair's `logging-evidence`
    // control reads a day with no food at all as evidence about logging.
    insert.run(profileId, day, "whole-grains", 1);
    if (back % 3 === 0) insert.run(profileId, day, ALCOHOL_FOOD_GROUP, 2);
  }
}

/**
 * A quarter-hourly heart-rate trace over `days` of history. No persona seeds
 * `hr_minutes` and `npm run seed` writes none (#5034), so without this every reader
 * on this seam returns before its range read and the criterion above would be asserted
 * over zero executions.
 */
function seedHrMinutes(profileId: number, days: number): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, ?, 1, 'health-connect')`
  );
  const start = Date.parse(
    `${shiftDateStr(today(profileId), -days)}T00:00:00.000Z`
  );
  const steps = days * 24 * 4;
  for (let step = 0; step < steps; step++) {
    const at = new Date(start + step * 15 * 60_000);
    // A plain diurnal swing: low overnight, higher through the day, so the night's
    // floor and a workout window are different numbers rather than one constant.
    const hour = at.getUTCHours();
    const bpm = hour < 7 ? 52 + (step % 5) : 78 + (step % 40);
    insert.run(profileId, at.toISOString().slice(0, 16), bpm);
  }
}

/** Persona → every `data-candidate-id` the render put in the document, in order. */
const rowIds = new Map<string, string[]>();
/** Persona → every `data-testid` the render put in the document. */
const testIds = new Map<string, string[]>();
const queryCounts = new Map<string, number>();
// THE WARM READING BESIDE THE COLD ONE (#5073). A second render of the same persona
// with no write in between, so the commit-scoped gathers are answered from the memo
// instead of the database.
const warmQueryCounts = new Map<string, number>();
const personaProfileIds = new Map<string, number>();

// A HOOK CEILING AS A MULTIPLE (#4002). The hook below builds every persona and
// renders Home twice per persona; it carried a hard-coded `}, 120_000)` that
// `ALLOS_VITEST_TIMEOUT_MS` could not reach. 4x testTimeout is 60 000 ms on CI.
//
// THE BASIS IS A GREEN READING AND THERE IS NO CI ONE. This file runs in the
// `db-isolated` pool, whose lines sit outside the window `test-db`'s job log will
// return. The DB tier moves 3-4x per file between two GREEN runs (#3999), so read the
// margin as ~14x of a good day, not of a bad one.
const MANIFEST_HOOK_MS = perTestCeiling(4, "green");

describe("Home's one list, rendered", () => {
  beforeEach(() => vi.setSystemTime(new Date("2026-08-18T13:00:00.000Z")));
  beforeAll(async () => {
    vi.setSystemTime(new Date("2026-08-18T13:00:00.000Z"));
    session.loginId = (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as { id: number }
    ).id;
    const trace = installStatementTrace({ bindings: HR_RANGE_READ });
    const Dashboard = await loadDashboard();

    // ONE CALL IS ONE REQUEST, so one request-cache scope — and the walk is INSIDE it,
    // because the streamed sections are part of the same request and would otherwise
    // each get a fresh memo. `resolveAsyncTree` runs every async section and collects
    // the host elements it produced; a client component cannot run here, so the record
    // band's own rows are absent and only the server-rendered bands are censused. That
    // bound is the harness's and is stated there.
    const renderHome = async () => {
      const resolved = await requestCache.during(async () =>
        resolveAsyncTree((await Dashboard()) as ReactElement)
      );
      const attribute = (name: string) =>
        resolved.elements
          .map((props) => props[name])
          .filter((value): value is string => typeof value === "string");
      return {
        ids: attribute("data-candidate-id"),
        testIds: attribute("data-testid"),
      };
    };

    for (const persona of PERSONAS) {
      const before = new Set(allProfileIds());
      const profileId = newProfile(`dashboard:${persona.name}`);
      persona.apply(ctxFor(profileId));
      const createdIds = allProfileIds().filter((id) => !before.has(id));
      session.accessible = profiles(createdIds);
      session.profile = session.accessible.find(
        (profile) => profile.id === profileId
      )!;
      trace.clear();
      const cold = await renderHome();
      rowIds.set(persona.name, cold.ids);
      testIds.set(persona.name, cold.testIds);
      queryCounts.set(persona.name, trace.count());
      hrWindowReads.set(persona.name, windowsRead(trace));
      personaProfileIds.set(persona.name, profileId);
      // THE WARM RENDER (#5073), immediately after the cold one and before anything
      // writes again. A Home render writes nothing, so the memo survives its own first
      // load, which is the whole premise.
      trace.clear();
      await renderHome();
      warmQueryCounts.set(persona.name, trace.count());
    }

    // ── THE ONE RENDER ON THIS FILE THAT HAS HEART-RATE MINUTES (#5010).
    // After the loop and on its own profile, so no persona's count can move.
    const hrBefore = new Set(allProfileIds());
    const hrProfileId = newProfile(`dashboard:${HR_FIXTURE}`);
    PERSONAS.find((persona) => persona.name === "biohacker")!.apply(
      ctxFor(hrProfileId)
    );
    seedHrMinutes(hrProfileId, 95);
    seedDrinkEvenings(hrProfileId, 90);
    session.accessible = profiles(
      allProfileIds().filter((id) => !hrBefore.has(id))
    );
    session.profile = session.accessible.find(
      (profile) => profile.id === hrProfileId
    )!;
    trace.clear();
    await renderHome();
    hrWindowReads.set(HR_FIXTURE, windowsRead(trace));
  }, MANIFEST_HOOK_MS);

  for (const persona of PERSONAS) {
    it(`${persona.name}: renders the record's day view at today`, () => {
      const ids = testIds.get(persona.name)!;
      // §3: `/` renders what `/history?day=<today>` renders. The record band is the
      // page's floor — it is there on a day with nothing on it too, as its own empty
      // line — and the canvas wrapper is what every one of the 84 specs that visit `/`
      // addresses the page through.
      expect(ids).toContain("dashboard-canvas");
      expect(ids).toContain("home-record");
    });

    it(`${persona.name}: gives every row one seat and one id`, () => {
      // THE ROW CONTRACT'S FIRST PROMISE (§5.1): a stable id per row. Duplicates are
      // what a fixed-seat composer cannot produce and a ranker could — the same fact
      // reaching two bands — so this is the census that used to be the placement
      // array's `new Set(candidateIds).size === candidateIds.length`.
      const ids = rowIds.get(persona.name)!;
      const seen = new Map<string, number>();
      for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
      expect(
        [...seen]
          .filter(([, count]) => count > 1)
          .map(([id, count]) => `${id} × ${count}`),
        "A row id appeared twice on one render of Home.\n" +
          "The id is the e2e locator, the dismissal key and the Telegram handoff's\n" +
          "scroll target (§5.1, §6.2) — two rows carrying one id make all three\n" +
          "ambiguous. The bands are disjoint by construction in lib/home-list.ts, so a\n" +
          "duplicate here is a row rendered twice by this page rather than composed\n" +
          "twice by it."
      ).toEqual([]);
    });
  }

  it("keeps the Now band's rows under the rule and out of the record", () => {
    // A persona with due doses is what makes this a claim rather than an empty-set
    // truism: `biohacker` groups four buckets, so it has rows to seat.
    const ids = testIds.get("biohacker")!;
    expect(ids, "the biohacker fixture seated no Now band").toContain(
      "home-now-rule"
    );
    expect(ids).toContain("home-dose-slot");
  });

  it("carries the row contract's id into the document (§5.1)", () => {
    // The attribute NAME is the promise: 84 specs visit `/` and address rows by it,
    // so it survives the ranker that minted it. This reads it off the rendered
    // elements rather than off a props array, because after v3 there is no array.
    const ids = rowIds.get("biohacker")!;
    expect(ids.length).toBeGreaterThan(0);
    expect(
      ids.some((id) => id.startsWith("attention.fact:dose-slot:")),
      ids.join(", ")
    ).toBe(true);
  });

  // ── THE METER (#3077 phase 5, #3369, #5073) ───────────────────────────────────
  //
  // A RECORDED BASELINE PER PERSONA, refreshed by pasting what the run measured, so
  // every move is accounted for in the commit that makes it. It is not a bound — the
  // bound is `QUERY_CEILING` below, on what a PASTE may decide alone.
  //
  // THE TABLE IS NEW HERE AND ITS HISTORY IS NOT LOST. The per-move arithmetic that
  // carried the v2 numbers from 535 down to 279 is in this file's git history and in
  // the ceiling's own comment below; reprinting it beside numbers it no longer
  // describes is the drift this file has deleted from itself twice. What the v3
  // numbers mean is stated once, here: they are a whole Home render — Current care,
  // the day read that serves the day bar, the record band and the chart, the three
  // bands, and both streamed sections resolved.
  const QUERY_BASELINE: Record<string, number> = {
    bodybuilder: 192,
    "marathon-runner": 204,
    household: 262,
    pregnant: 197,
    "diabetic-cgm": 204,
    biohacker: 209,
  };

  // A BACKSTOP, NOT THE METER. The baseline above is the meter; this is the bound on
  // how far the baseline may be refreshed upward before the refresh needs a
  // conversation rather than a paste.
  //
  // 279 → 269, WHICH IS #5435 §7's ACCEPTANCE BEING SPENT. The previous PR left the
  // v2 number deliberately (the gathers it bounded were still being deleted); this
  // one takes the measurement the table above now records and lowers the backstop
  // onto it. 279 was biohacker 262 + the 17 of headroom frozen since #5221 — and
  // v2's heaviest persona and v3's happen to cost the same 262, so keeping 17 would
  // have left the number where it stood and quietly failed the acceptance.
  //
  //   household 262 (the measured heaviest) + 7 headroom = 269
  //
  // THE HEADROOM IS SMALLER BECAUSE WHAT IT IS FOR IS SMALLER. The 23 → 20 → 17 line
  // was sized as "one household-shaped addition — about five new per-profile reads,
  // or one new gathering surface". §2's admission test 5 forbids exactly that on v3:
  // a row that would raise this ceiling is not admitted until the cost is removed
  // elsewhere. And the growth §7 DOES admit — "the named bounded reads of a row kind
  // a persona did not have before (the forecast, the fast, the day read on a no-HR
  // day)" — is not something headroom should pre-fund either: each of those is
  // precisely the conversation this backstop exists to force, and §7 says raising the
  // number is a legitimate outcome of having it.
  //
  // WHAT IS LEFT FOR A PASTE TO DECIDE ALONE is incidental drift in shared readers
  // Home does not own, and this table's own history prices it: #4299 landed +1 on
  // every persona and +4 on biohacker, #4956 landed +1 on four and +3 on two, and
  // the comments record that they COMPOSE rather than interact. 4 + 3 = 7 is the
  // largest such composition this file has actually measured, so it is the headroom
  // rather than a round number chosen for looking like one. A refresh bigger than
  // that has stopped being drift.
  const QUERY_CEILING = 269;

  it("home query budget: each persona matches its recorded main baseline", () => {
    // THE BACKSTOP ASKS ABOUT THE TABLE, NOT THE MEASUREMENT — which is the only
    // place it can ever speak. A measured count above the ceiling has necessarily
    // drifted off its baseline first, so the drift assertion below would have thrown
    // and a ceiling checked against `queryCounts` could never be reached. What the
    // backstop is actually for is a REFRESH: someone pastes a table that has grown
    // past what a paste may decide alone.
    const overCeiling = Object.entries(QUERY_BASELINE)
      .filter(([, baseline]) => baseline > QUERY_CEILING)
      .map(
        ([persona, baseline]) =>
          `${persona}: recorded baseline ${baseline} is over the ${QUERY_CEILING} backstop by ${baseline - QUERY_CEILING}`
      );
    expect(
      overCeiling,
      "A recorded baseline is past the backstop.\n" +
        "The baseline table is refreshed by pasting; this is the bound on what a\n" +
        "paste may decide on its own. Growth this large is a design conversation\n" +
        "about what Home gathers — not a number to raise so CI goes green.\n" +
        "Raising QUERY_CEILING is a legitimate outcome of that conversation, with\n" +
        "the reasoning written into its comment the way the current number's is."
    ).toEqual([]);

    const drift = [...queryCounts].flatMap(([persona, count]) => {
      const baseline = QUERY_BASELINE[persona];
      if (baseline === undefined) {
        return [`${persona}: ${count} queries, but no recorded baseline`];
      }
      if (count === baseline) return [];
      const delta = count - baseline;
      return [
        `${persona}: ${count} queries, baseline ${baseline} ` +
          `(${delta > 0 ? `+${delta} spent by this change` : `${delta} recovered by this change`})`,
      ];
    });

    const refreshed = [...queryCounts]
      .map(([persona, count]) => `    ${JSON.stringify(persona)}: ${count},`)
      .join("\n");

    expect(
      drift,
      "Home query counts moved off the recorded baseline.\n" +
        "Each line names one persona: what it measures now, what MAIN measures, and\n" +
        "the difference — which is this change's own cost, not main's. A positive\n" +
        "delta is queries the diff in front of you added; a negative one is queries\n" +
        "it removed. Either way the fix is the same: account for the move in the\n" +
        "commit message, then refresh QUERY_BASELINE in this file with:\n\n" +
        `  const QUERY_BASELINE: Record<string, number> = {\n${refreshed}\n  };\n`
    ).toEqual([]);
  });

  // THE WARM METER (#5073). The cold table above says what a first load costs; this
  // says what the SECOND one costs when nothing has been written in between, which is
  // the whole point of the commit-scoped memo. Same paste-the-refresh ritual as the
  // cold table, and the same reason for having numbers rather than a ratio: a move
  // here has to be accounted for, in either direction.
  const WARM_BASELINE: Record<string, number> = {
    bodybuilder: 173,
    "marathon-runner": 184,
    household: 239,
    pregnant: 178,
    "diabetic-cgm": 185,
    biohacker: 189,
  };

  it("home query budget: a second load with no write in between matches its warm baseline (#5073)", () => {
    // THE COLD COUNT IS THE CONTROL. "The warm render issues fewer statements" is only
    // evidence if the cold render issued them — a memo that returned nothing at all
    // would satisfy the warm half exactly as well.
    const notCheaper = [...warmQueryCounts].flatMap(([persona, warm]) => {
      const cold = queryCounts.get(persona)!;
      return warm < cold
        ? []
        : [`${persona}: warm ${warm} is not below cold ${cold}`];
    });
    expect(
      notCheaper,
      "A warm Home load cost as much as the cold one.\n" +
        "Either the commit-scoped memo (lib/commit-cache.ts) stopped holding the\n" +
        "gathers it holds, or something wrote between the two renders — a render\n" +
        "itself writes nothing, so a write here is a regression rather than noise."
    ).toEqual([]);

    const drift = [...warmQueryCounts].flatMap(([persona, count]) => {
      const baseline = WARM_BASELINE[persona];
      if (baseline === undefined)
        return [`${persona}: ${count} warm queries, but no recorded baseline`];
      if (count === baseline) return [];
      const delta = count - baseline;
      return [
        `${persona}: ${count} warm queries, baseline ${baseline} (${
          delta > 0 ? `+${delta}` : delta
        })`,
      ];
    });
    const refreshed = [...warmQueryCounts]
      .map(([persona, count]) => `    ${JSON.stringify(persona)}: ${count},`)
      .join("\n");
    expect(
      drift,
      "Warm Home query counts moved off the recorded baseline.\n" +
        "Account for the move, then refresh WARM_BASELINE with:\n\n" +
        `  const WARM_BASELINE: Record<string, number> = {\n${refreshed}\n  };\n`
    ).toEqual([]);
  });

  it("reads each hr_minutes window once per render (#5010)", () => {
    // THE CONTROL COMES FIRST BECAUSE ZERO IS THE FLATTERING ANSWER. Every window
    // below is distinct when no window was read at all, and that is what the assertion
    // would report forever if the statement this watches were renamed or the fixture
    // stopped reaching the reader.
    expect(
      hrWindowReads.get(HR_FIXTURE) ?? [],
      `${HR_FIXTURE} made no hr_minutes range read, so the check below is vacuous.\n` +
        `Either the fixture stopped reaching a reader on this seam, or the read's\n` +
        `SQL no longer matches ${HR_RANGE_READ}.`
    ).not.toEqual([]);

    const repeated = [...hrWindowReads].flatMap(([render, windows]) => {
      const times = new Map<string, number>();
      for (const window of windows)
        times.set(window, (times.get(window) ?? 0) + 1);
      return [...times]
        .filter(([, count]) => count > 1)
        .map(([window, count]) => `${render}: ${count} reads of ${window}`);
    });
    expect(
      repeated,
      "One render read the same hr_minutes window more than once.\n" +
        "Each line names the render and the [profile_id, from, to] span it asked for\n" +
        "twice. A second read of one span is a second full materialisation of the same\n" +
        "rows — the cost #5010 removed — and it is invisible to a statement COUNT,\n" +
        "because N reads of N windows and N reads of one window are both N."
    ).toEqual([]);
  });
});

// THE PRACTICE-TARGET ROW IS A DUE ACTION IN ITS OWN RIGHT (#5435 §3.2, carrying
// #4076's 2026-08-30 ruling across the cutover). Self-contained: its own profiles, its
// own render — it does not touch PERSONAS or QUERY_BASELINE above, so a change here
// cannot silently move either.
//
// WHAT CHANGED WITH v3 AND WHAT DID NOT. v2 stated weekly targets in the Standing
// cluster and gave the behind PRACTICE one an in-place log control; v3 deletes Standing
// (§4), so the progress ROW is gone for every scope. The practice target comes back
// under the Now rule because it is the one of those rows carrying a control whose write
// is TODAY's — and its training-scope twins do not, because "unmet weekly pace never
// becomes a newly owed action" (§3.2). So the three cases below are the same three
// questions with the ranker's vocabulary removed: behind practice → a row with the log
// control; met practice → no row; behind training scope → no row.
//
// Rolling week mode is SET, not assumed (#5410). The default is calendar
// (`DEFAULT_WEEK_MODE`), whose window grows from the week-start day, so `elapsedDays`
// is the weekday + 1 and #4758's rule reads a fresh 2x/week target with zero sessions
// as BEHIND only once the window is fully elapsed — one day a week. Rolling makes the
// window the trailing 7 days whatever the calendar day, so the target is BEHIND by
// construction. That is the fixture every case below reuses, varied on exactly the one
// axis each case is about.
describe("the practice-target row is a due action in its own right (#5435 §3.2)", () => {
  const adminLoginId = (): number =>
    (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as { id: number }
    ).id;

  async function renderFor(profileId: number) {
    session.loginId = adminLoginId();
    session.accessible = profiles([profileId]);
    session.profile = session.accessible[0];
    const { default: Dashboard } = await import("../../app/(app)/page");
    const resolved = await requestCache.during(async () =>
      resolveAsyncTree((await Dashboard()) as ReactElement)
    );
    const rows = resolved.elements.filter(
      (props) => typeof props["data-candidate-id"] === "string"
    );
    return {
      ids: rows.map((props) => String(props["data-candidate-id"])),
      // The control a row put in its trailing slot, by row id. `HomeRow` renders it
      // into a `<span className="shrink-0">`, so the element itself is what this walk
      // reached and the props carry it whole.
      controls: new Map(
        rows.map((props) => [String(props["data-candidate-id"]), props.control])
      ),
      testIds: resolved.elements
        .map((props) => props["data-testid"])
        .filter((value): value is string => typeof value === "string"),
    };
  }

  function seedTarget(
    name: string,
    scopeKind: "practice" | "type",
    scopeValue: string,
    perWeek: number
  ): number {
    const profileId = newProfile(`dashboard:${name}`);
    setWeekMode(profileId, "rolling");
    // `practice` rows carry a NOT-NULL `scope_identity` (#123's trigger) — the same
    // lowercase key every practice write already uses.
    db.prepare(
      `INSERT INTO frequency_targets
         (profile_id, scope_kind, scope_value, scope_identity, per_week, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      profileId,
      scopeKind,
      scopeValue,
      scopeKind === "practice" ? scopeValue.toLowerCase() : null,
      perWeek,
      `${shiftDateStr(today(profileId), -60)} 00:00:00`
    );
    return profileId;
  }

  it("seats a behind practice target under the Now rule with its log control", async () => {
    const profileId = seedTarget("practice-behind", "practice", "Sauna", 2);
    const { ids, testIds } = await renderFor(profileId);

    expect(
      ids.some((id) => id.startsWith("attention.fact:practice:")),
      ids.join(", ")
    ).toBe(true);
    expect(testIds).toContain("home-now-rule");
  });

  // THE CONVERSE (a removal guard proves nothing alone): an ON-PACE practice target —
  // met, so never behind — takes no seat at all, because an already-met target offers
  // nothing to log. Distinguishes "the practice target is a due action" from "every
  // practice target gets a row".
  it("gives an on-pace (met) practice target no seat", async () => {
    const profileId = seedTarget("practice-met", "practice", "Sauna", 1);
    const today0 = today(profileId);
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, logged_via) VALUES (?, 'Sauna', ?, 'page')`
    ).run(profileId, today0);
    const { ids } = await renderFor(profileId);

    expect(ids.some((id) => id.startsWith("attention.fact:practice:"))).toBe(
      false
    );
  });

  // THE OTHER CONVERSE, and the one §3.2 states in words: a behind target OUTSIDE the
  // practice domain (training's `type`/cardio scope, the marathon-runner persona's own
  // shape) takes no seat either. Unmet weekly pace never becomes a newly owed action —
  // the analysis is the hub's (#5198), and `isTrainingFrequencyScope` is the predicate
  // that excludes `practice` from it. Not `group`/`region` — those are STRENGTH-
  // programming scopes, gated on a known adult-ish age this fixture does not set, and
  // would drop out for an unrelated reason before reaching the question this is about.
  it("gives a behind training (type/cardio-scope) target no seat", async () => {
    const profileId = seedTarget("cardio-behind", "type", "cardio", 2);
    const { ids } = await renderFor(profileId);

    expect(ids.some((id) => id.startsWith("attention.fact:practice:"))).toBe(
      false
    );
    expect(ids.some((id) => id.startsWith("target."))).toBe(false);
  });
});
