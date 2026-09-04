// DB INTEGRATION TIER — the /sleep route's statement budget (#3993).
//
// WHY THIS FILE EXISTS. Two budget gates walk a route today: the dashboard
// (dashboard-placement-manifest.test.ts, `QUERY_CEILING = 274`) and the Trends Overview
// (trends-overview-budget.test.ts). Neither walks /sleep — and #3993 put an
// `effectiveSituationResolver` inside `bedtimeSupplementsByWakeDay`, which /sleep renders
// for every night of its history. That made the sleep page's cost a number taken on
// trust: nothing in the suite could say whether the route can reach the same ceiling the
// dashboard is held to. It can be measured, so it is.
//
// THE CEILING IS THE DASHBOARD'S, borrowed rather than re-derived. /sleep is a single
// domain page against the dashboard's whole placement census, so it has no business
// costing what the dashboard costs; 274 is a backstop it should not come near, and the
// recorded per-persona counts below are the real gate. Both are asserted, for the reason
// the dashboard's own comment gives: a recorded number catches drift, a backstop catches
// the thing nobody thought to record.

import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
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
import { PERSONAS, type PersonaContext } from "../../scripts/seed-personas";
import {
  allProfileIds,
  installStatementTrace,
  loadPage,
  pageProps,
  profilesForIds as profiles,
  renderPage,
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

const previousTestNow = process.env.ALLOS_TEST_NOW;
const counts = new Map<string, number>();

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// The persona seeding context, exactly as lib/__db_tests__/dashboard-placement-manifest
// .test.ts builds it — the personas are the shared fixture, so the two route budgets are
// measured against the same six people.
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

describe("/sleep route query budget (#3993)", () => {
  beforeAll(async () => {
    process.env.ALLOS_TEST_NOW = "2026-08-18T13:00:00.000Z";
    session.loginId = (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as { id: number }
    ).id;
    const trace = installStatementTrace({});
    const SleepPage = await loadPage("app/(app)/sleep/page");
    for (const persona of PERSONAS) {
      const before = new Set(allProfileIds());
      const profileId = newProfile(`sleep:${persona.name}`);
      persona.apply(ctxFor(profileId));
      const createdIds = allProfileIds().filter((id) => !before.has(id));
      session.accessible = profiles(createdIds);
      session.profile = session.accessible.find((p) => p.id === profileId)!;
      trace.clear();
      await renderPage(SleepPage, pageProps());
      counts.set(persona.name, trace.count());
    }
  }, 120_000);

  afterAll(() => {
    if (previousTestNow === undefined) delete process.env.ALLOS_TEST_NOW;
    else process.env.ALLOS_TEST_NOW = previousTestNow;
  });

  // Recorded per persona, the same discipline the dashboard manifest uses: a number that
  // moves is a conversation, not a value to bump. Measured on the merged tree.
  //
  // FIVE OF THE SIX ARE UNMOVED BY #3993 at 69, and one moved: `biohacker` 90 → 109. Only
  // that persona has a bedtime supplement dose to score, so it is the only one whose
  // gather builds a resolver at all — the others return before it. The +19 is the derived
  // inputs read ONCE for the history's span (the declared set and its change log, the
  // suppression bus, the nightly series, the cycle relevance bit, the home location and
  // the weather gate), not once per night: the page draws 30 nights, and 30 gathers is
  // what the per-DATE resolver would have cost.
  //
  // It was 111 until the declared pair came OUT of the tick memo: the seam and the memo's
  // passthrough were each reading `getActiveSituations` + `getSituationEvents`, and one
  // shared read serves both halves now. Fixing the torn read made the page two queries
  // cheaper, not dearer.
  const BASELINES: Record<string, number> = {
    bodybuilder: 69,
    "marathon-runner": 69,
    household: 69,
    pregnant: 69,
    "diabetic-cgm": 69,
    biohacker: 109,
  };

  // The dashboard's backstop, borrowed. /sleep is one domain page; reaching this would
  // mean it costs what the entire dashboard census costs. The heaviest persona is 109
  // against it — the answer to the question nobody had asked, which was whether this
  // route could exceed a ceiling no gate applies to it.
  const QUERY_CEILING = 274;

  it("stays at its recorded per-persona counts", () => {
    expect(Object.fromEntries(counts)).toEqual(BASELINES);
  });

  it("no persona reaches the dashboard's backstop", () => {
    for (const [persona, count] of counts)
      expect(
        count,
        `${persona}: ${count} against ${QUERY_CEILING}`
      ).toBeLessThan(QUERY_CEILING);
  });
});
