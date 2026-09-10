// DB INTEGRATION TIER — the /training hub's statement budget (#5669).
//
// WHY THIS FILE EXISTS. Route meters walk Home (dashboard-placement-manifest.test.ts),
// /sleep (sleep-page-budget.test.ts) and the Trends Overview
// (trends-overview-budget.test.ts), and tick-gather-budget.test.ts walks the
// notification tick. Nothing metered /training, whose Overview gathers the week's
// activities and sets, the cadence ledger, fitness checks, injuries, niggles,
// endurance plans and a clinical context before the first card renders. Owner ruling
// 2026-09-09: the Home test — fewer statements per render, downward only — applies to
// the surfaces opened daily, and the Training hub is one of them.
//
// LOWERING IS THE ONLY ALLOWED EDIT TO THE TABLE BELOW. A count above its recorded
// baseline is a gather this change added, and the fix is in the code in front of you,
// never in the number. A count below it is a saving, and the same change records it by
// lowering the number. There is no backstop constant beside the table because a rule
// that forbids raising is already stronger than any ceiling.
//
// WHAT THIS GATE DOES NOT COVER, because its silence would otherwise read as coverage
// (#5199). It walks ONE ROUTE RENDER per persona with a request cache open, of the tab
// `/training` opens on — Overview, the server-selected default. The Log, Analyze and
// Plan tabs are separate URL states and are not walked. The app shell around the page
// (`app/(app)/layout.tsx`) is not inside this count. Client components in the tree are
// skipped by the walk and cannot query. The notification tick runs the same query layer
// with `cache()` degraded to identity and is tick-gather-budget.test.ts's; wall time is
// docs/internals/profiling.md's.
//
// THE TREE IS RESOLVED, NOT JUST THE PAGE FUNCTION. /sleep gathers inline, so awaiting
// its page function is the whole render. The training page puts its entire query load
// in the selected section behind `Suspense` and `StreamedSection` (#2641): awaiting
// `TrainingPage()` alone runs ONE statement (the head's age gate), measured. So each
// render here awaits the page and then walks the returned tree with `resolveAsyncTree`
// — the harness helper the profiler uses for the same reason — inside the SAME request
// scope, which is what one production request is.

import { beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { PERSONAS } from "../../scripts/seed-personas";
import { personaContextFor } from "@/lib/__db_tests__/persona-fixture";
import { perTestCeiling } from "../../vitest.timeouts";
import {
  allProfileIds,
  installStatementTrace,
  loadPage,
  pageProps,
  profilesForIds as profiles,
  requestCache,
  resolveAsyncTree,
  session,
} from "@/lib/__db_tests__/dashboard-render-harness";

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

const counts = new Map<string, number>();
/** Async components the walk awaited per persona — the positive control below. */
const awaitedSections = new Map<string, number>();

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A HOOK CEILING AS A MULTIPLE (#4002), the dashboard meter's. The hook seeds every
// persona and renders the hub once each; the six renders are under a second between
// them and the seeding is the hook. Measured on the dispatch box: 8.0 s for
// the hook against a 60 000 ms ceiling on CI (4x the 15 s test budget), and this
// tier moves 3-4x per file between two green runs (#3999), so read it as ~7x of a
// good day. The basis is a green local reading; nothing has timed it on the runner.
const SEED_AND_RENDER_HOOK_MS = perTestCeiling(4, "green");

describe("/training hub query budget (#5669)", () => {
  beforeEach(() => vi.setSystemTime(new Date("2026-08-18T13:00:00.000Z")));
  beforeAll(async () => {
    // The instant the other route meters pin, so a week window is the same number of
    // days on every run.
    vi.setSystemTime(new Date("2026-08-18T13:00:00.000Z"));
    session.loginId = (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as { id: number }
    ).id;
    const trace = installStatementTrace({});
    const TrainingPage = await loadPage("app/(app)/training/page");
    for (const persona of PERSONAS) {
      const before = new Set(allProfileIds());
      const profileId = newProfile(`training:${persona.name}`);
      persona.apply(personaContextFor(profileId));
      const createdIds = allProfileIds().filter((id) => !before.has(id));
      session.accessible = profiles(createdIds);
      session.profile = session.accessible.find((p) => p.id === profileId)!;
      trace.clear();
      const resolved = await requestCache.during(async () =>
        resolveAsyncTree(await TrainingPage(pageProps()))
      );
      counts.set(persona.name, trace.count());
      awaitedSections.set(persona.name, resolved.awaited);
    }
  }, SEED_AND_RENDER_HOOK_MS);

  // THE RECORDED MAIN BASELINE, one cold Overview render per persona, measured at
  // landing. The statements fall into these groups, heaviest first on `bodybuilder`:
  //   - settings key-value reads: the profile's, the login's and the global rows,
  //     one statement per key (timezone, units, week start, age, format prefs and
  //     the rest), read by many gathers — over a third of every persona's count;
  //   - activities: the trailing windows the week spine, load, zones, heatmap,
  //     presence and mobility rows read, plus the typed cardio and sport series;
  //   - exercise sets: strength history and ladder, sets per exercise, the recent
  //     dated exercises and the cadence ledger's set-day scan;
  //   - frequency targets and their cadence ledger;
  //   - body metrics: latest weight, resting HR and body fat, the weight series and
  //     the resting-HR signal;
  //   - fitness assessments and their entries, with the set history the standards
  //     ladder reads per test;
  //   - clinical context: deduplicated biomarker records per family, conditions,
  //     illness episodes, active situations and the day's symptom and mood rows;
  //   - the rest of the coaching inputs, one or two reads each: equipment, the
  //     active routine, injuries, niggles, endurance plans, upcoming dismissals,
  //     the hr_minutes span and the latest sleep-session day.
  // The personas differ by which coaching branches their data reaches — a sport arm,
  // an illness episode, a household member's rows — never by history length.
  const BASELINES: Record<string, number> = {
    bodybuilder: 121,
    "marathon-runner": 130,
    household: 134,
    pregnant: 115,
    "diabetic-cgm": 115,
    biohacker: 127,
  };

  it("training hub query budget: each persona matches its recorded main baseline", () => {
    const drift = [...counts].flatMap(([persona, count]) => {
      const baseline = BASELINES[persona];
      if (baseline === undefined) {
        return [`${persona}: ${count} statements, but no recorded baseline`];
      }
      if (count === baseline) return [];
      const delta = count - baseline;
      return [
        `${persona}: ${count} statements, baseline ${baseline} ` +
          (delta > 0
            ? `(+${delta} spent by this change — remove the gather; the baseline is not raised)`
            : `(${delta} recovered by this change — lower the baseline to ${count})`),
      ];
    });
    expect(
      drift,
      "Training hub statement counts moved off the recorded baseline.\n" +
        "Each line names one persona: what it measures now, what MAIN measures, and\n" +
        "the difference — this change's own cost, not main's. Lowering a number in\n" +
        "BASELINES is the only allowed edit to it."
    ).toEqual([]);
  });

  it("reaches the Overview section on every persona", () => {
    // THE POSITIVE CONTROL. The page head alone is one statement; the section is the
    // rest. A walk that stopped reaching it — a client boundary around the section,
    // say — would read as a 100-statement saving above, and this says it is not one.
    for (const [persona, awaited] of awaitedSections)
      expect(awaited, `${persona}: async sections awaited`).toBeGreaterThan(1);
  });
});
