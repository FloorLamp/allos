// Real-schema candidate census and query budget for the dashboard cutover (#3096).

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { utcInstant, shiftDateStr } from "@/lib/date";
import { zonedWallTimeToUtc } from "@/lib/calendar-ics";
import { reconcileFlags } from "@/lib/queries";
import { saveFitnessEntry } from "@/lib/fitness-assessment";
import { recordGlucoseTrace } from "@/lib/glucose-trace-db";
import { getTimezone } from "@/lib/settings";
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
  renderDashboard as renderDashboardPage,
  requestCache,
  session,
} from "@/lib/__db_tests__/dashboard-render-harness";
import PageContainer from "../../components/PageContainer";
import { LoggedViaSurface } from "@/components/LoggedViaSurface";
import DashboardPlacementCanvas, {
  type DashboardPlacementCanvasProps,
} from "@/components/dashboard/DashboardPlacementCanvas";
import { STANDING_READING_ORDER } from "@/lib/dashboard-standing";
import {
  everythingTail,
  type DashboardEverythingGroup,
} from "@/lib/dashboard-relevance";
import { trackedPageFor } from "@/lib/recent-pages";
import { logSheetSegments } from "@/lib/log-sheet";
import { biomarkerFlagDismissalKey } from "@/lib/dismissal-keys";
import { dashboardAttentionCandidateId } from "@/lib/dashboard-attention-identity";
import LogPracticeButton from "@/components/practices/LogPracticeButton";
import { isNotableFlag } from "@/lib/reference-range";
import { ALCOHOL_FOOD_GROUP } from "@/lib/substance-use";
import type { MedicalFlag } from "@/lib/types";

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
 * The one render in this file that HAS heart-rate minutes. Rendered after the persona
 * loop below, on its own profile, so it cannot move a single number in QUERY_BASELINE.
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

const manifests = new Map<
  string,
  DashboardPlacementCanvasProps["placements"]
>();
const rowPresentations = new Map<
  string,
  DashboardPlacementCanvasProps["presentations"]
>();
const aheadPresentations = new Map<
  string,
  DashboardPlacementCanvasProps["aheadPresentations"]
>();
const queryCounts = new Map<string, number>();
// THE WARM READING BESIDE THE COLD ONE (#5073). A second render of the same persona
// with no write in between, so the six Show-everything gathers are answered from the
// commit-scoped memo instead of the database.
const warmQueryCounts = new Map<string, number>();
const warmManifests = new Map<
  string,
  DashboardPlacementCanvasProps["placements"]
>();
const personaProfileIds = new Map<string, number>();
let switchedHouseholdManifest: DashboardPlacementCanvasProps["placements"] = [];
let switchedHouseholdProfileId = 0;
const previousTestNow = process.env.ALLOS_TEST_NOW;

// A HOOK CEILING AS A MULTIPLE (#4002). The hook below builds every persona and
// renders the dashboard once per persona; it carried a hard-coded `}, 120_000)` that
// `ALLOS_VITEST_TIMEOUT_MS` could not reach. Measured on the dispatch box: this file
// runs 3 644 ms under coverage and 4 411 ms without, of which the 15 tests themselves
// are 22-39 ms — so the hook IS the file. 4x testTimeout is 60 000 ms on CI, ~14x
// that reading and still twice the default hook budget. Named rather than inline so
// prettier keeps hugging the hook instead of reflowing 160 lines of its body.
//
// THE BASIS IS A GREEN READING AND THERE IS NO CI ONE. This file runs in the
// `db-isolated` pool, whose lines sit outside the window `test-db`'s job log will
// return, so nobody has measured this hook on the runner that enforces the ceiling.
// The DB tier moves 3-4x per file between two GREEN runs (#3999), so read the margin
// as ~14x of a good day, not of a bad one.
const MANIFEST_HOOK_MS = perTestCeiling(4, "green");

describe("actual atomic dashboard manifests", () => {
  beforeAll(async () => {
    process.env.ALLOS_TEST_NOW = "2026-08-18T13:00:00.000Z";
    session.loginId = (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as {
        id: number;
      }
    ).id;
    const trace = installStatementTrace({ bindings: HR_RANGE_READ });
    const Dashboard = await loadDashboard();
    // One call = one request, so one request-cache scope. Everything outside this
    // helper — persona seeding above all — runs unmemoized, exactly as production
    // does outside a request.
    // The page's root element is its declared-width wrapper (#3253), and the canvas
    // is the child inside it. Unwrapped HERE rather than asserted around, so this
    // tier keeps reading the manifest off the canvas' own props — the width is
    // presentation, and a presentation change must not be able to make the placement
    // meter stop measuring.
    const renderDashboard = async () => {
      const page = (await renderDashboardPage(Dashboard)) as ReactElement<{
        children: ReactElement;
      }>;
      expect(page.type).toBe(PageContainer);
      // …and the SURFACE DECLARATION inside it (#3087): the dashboard names itself
      // `dashboard-widget` once, at the region root, so every logging control it
      // places posts the surface it is actually on instead of the domain page's
      // `page` fallback. Unwrapped here for the same reason the width wrapper above
      // is: it is a fact about the region, not about the placement, and this tier
      // must keep reading the manifest off the canvas' own props.
      const surface = page.props.children as ReactElement<{
        value: string;
        children: ReactElement;
      }>;
      expect(surface.type).toBe(LoggedViaSurface);
      expect(surface.props.value).toBe("dashboard-widget");
      return surface.props
        .children as ReactElement<DashboardPlacementCanvasProps>;
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
      const element = await renderDashboard();
      expect(element.type).toBe(DashboardPlacementCanvas);
      manifests.set(persona.name, element.props.placements);
      rowPresentations.set(persona.name, element.props.presentations);
      aheadPresentations.set(persona.name, element.props.aheadPresentations);
      queryCounts.set(persona.name, trace.count());
      hrWindowReads.set(persona.name, windowsRead(trace));
      personaProfileIds.set(persona.name, profileId);
      // THE WARM RENDER (#5073), immediately after the cold one and before anything
      // writes again. A dashboard render writes nothing — measured with
      // `total_changes()` around three persona renders, 0 rows each — so the memo
      // survives its own first load, which is the whole premise.
      trace.clear();
      const warmElement = await renderDashboard();
      warmQueryCounts.set(persona.name, trace.count());
      warmManifests.set(persona.name, warmElement.props.placements);
      if (persona.name === "household") {
        const switched = session.accessible.find(
          (profile) => profile.name === "Riley"
        )!;
        session.profile = switched;
        switchedHouseholdProfileId = switched.id;
        const switchedElement = await renderDashboard();
        switchedHouseholdManifest = switchedElement.props.placements;
        session.profile = session.accessible.find(
          (profile) => profile.id === profileId
        )!;
      }
    }

    // ── THE ONE RENDER ON THIS FILE THAT HAS HEART-RATE MINUTES (#5010).
    // After the loop and on its own profile, so no persona's count can move: the
    // budget above is captured before this line runs, and nothing below reads
    // `trace.count()`. It reuses a persona's own shape — the trained profile with
    // synced nights, which is what puts the zone reader, the overnight reader and the
    // event windows on one render — and adds only the minutes those readers ask for.
    //
    // IT REACHES THE STATE THE ASSERTION FORBIDS, which the six personas above do not:
    // this render issues three range reads — the trailing zone window, the span of the
    // nights the alcohol pair judges, and the recent event window. The personas issue
    // NONE, so on them the check below is a claim about an empty list.
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
    await renderDashboard();
    hrWindowReads.set(HR_FIXTURE, windowsRead(trace));
  }, MANIFEST_HOOK_MS);

  afterAll(() => {
    if (previousTestNow === undefined) delete process.env.ALLOS_TEST_NOW;
    else process.env.ALLOS_TEST_NOW = previousTestNow;
  });

  for (const persona of PERSONAS) {
    it(`${persona.name}: matches semantic expectations and identity invariants`, () => {
      const placements = manifests.get(persona.name)!;
      const candidates = placements.map((placement) => placement.candidate);
      const candidateIds = candidates.map((candidate) => candidate.candidateId);
      const factKeys = candidates.map((candidate) => candidate.factKey);
      expect(new Set(candidateIds).size).toBe(candidateIds.length);
      expect(new Set(factKeys).size).toBe(factKeys.length);
      for (const expected of persona.dashboard.expect) {
        expect(candidateIds.some((id) => id.startsWith(expected))).toBe(true);
      }
      for (const absent of persona.dashboard.absent) {
        expect(candidateIds.some((id) => id.startsWith(absent))).toBe(false);
      }
      expect(
        placements.every((placement) =>
          candidateIds.includes(placement.candidate.candidateId)
        )
      ).toBe(true);
    });
  }

  it("names the protein reading's tail moment without duplicating its Standing label", () => {
    const protein = [...rowPresentations.values()]
      .flatMap((presentations) => [...presentations.entries()])
      .find(([candidateId]) => candidateId.startsWith("nutrition.protein:"));
    expect(protein?.[1].moment).toEqual({
      title: "Nutrition today",
      href: "/nutrition",
    });
    expect(protein?.[1].label).toBeUndefined();
  });

  it("exercises both manual and external engagement evidence", () => {
    const engagement = [...manifests.values()]
      .flat()
      .map((placement) => placement.candidate.relevance)
      .filter((relevance) => relevance.kind === "profile-data")
      .map((relevance) => relevance.engagement);
    expect(engagement).toContain("manual");
    expect(engagement).toContain("external");
  });

  it("keeps semantic Standing order, scope, caps, and external readings", () => {
    const familyIndex = new Map(
      STANDING_READING_ORDER.map((family, index) => [family.key, index])
    );
    let externalStanding = 0;
    for (const [persona, placements] of manifests) {
      const profileId = personaProfileIds.get(persona)!;
      const presentations = rowPresentations.get(persona)!;
      const standing = placements.filter(
        (placement) => placement.lane === "standing"
      );
      expect(
        standing.every(({ candidate }) =>
          presentations.has(candidate.candidateId)
        ),
        `${persona}:Standing presentation`
      ).toBe(true);
      // #3548 SUPERSEDED #3103's fully-fixed order exactly this far and #4232
      // narrowed it again: the registry's order survives INSIDE each band, and the
      // bands themselves run attention → rest. There is no third band — a quiet
      // member is not claimed at all — so the sortedness claim is per band, and the
      // band sequence is the claim that replaces the global one.
      const bandOrder = ["attention", "rest"] as const;
      const bands = standing.map((placement) => placement.standingBand!);
      expect(
        bands.map((band) => bandOrder.indexOf(band)),
        `${persona}:band order`
      ).toEqual(
        bands.map((band) => bandOrder.indexOf(band)).toSorted((a, b) => a - b)
      );
      for (const band of bandOrder) {
        // The attention tier ranks by CLAIM, not by family, so only the two
        // fixed-order bands carry the registry-order claim.
        if (band === "attention") continue;
        const indices = standing
          .filter((placement) => placement.standingBand === band)
          .map((placement) => familyIndex.get(placement.standingFamilyKey!));
        expect(indices, `${persona}:${band}`).toEqual(
          indices.toSorted((a, b) => a! - b!)
        );
      }
      expect(
        standing.every(
          ({ candidate }) =>
            candidate.subject.scope === "profile" &&
            candidate.subject.profileId === profileId
        ),
        persona
      ).toBe(true);
      for (const family of STANDING_READING_ORDER) {
        if (family.cap == null) continue;
        expect(
          standing.filter(
            (placement) => placement.standingFamilyKey === family.key
          ).length,
          `${persona}:${family.key}`
        ).toBeLessThanOrEqual(family.cap);
      }
      externalStanding += standing.filter(
        ({ candidate }) =>
          candidate.relevance.kind === "profile-data" &&
          candidate.relevance.engagement === "external"
      ).length;
    }
    expect(externalStanding).toBeGreaterThan(0);
  });

  it("keeps Ahead active-profile-only with complete read-only presentations", () => {
    const seen = new Set<string>();
    for (const [persona, placements] of manifests) {
      const profileId = personaProfileIds.get(persona)!;
      const presentations = aheadPresentations.get(persona)!;
      for (const placement of placements.filter(
        (placement) => placement.lane === "ahead"
      )) {
        seen.add(placement.aheadBucket);
        expect(placement.candidate.subject, persona).toEqual({
          scope: "profile",
          profileId,
        });
        expect(
          presentations.has(placement.candidate.candidateId),
          persona
        ).toBe(true);
        if (placement.aheadBucket === "later-today") {
          expect(placement.candidate, persona).toMatchObject({
            kind: "action",
            rankReasons: { owed: true, safety: false },
          });
          expect(placement.timingDisposition).toEqual({
            kind: "future-today",
            opensAt: placement.opensAt,
          });
        } else {
          expect(placement.candidate.candidateId).toBe(
            `attention.fact:${placement.upcomingKey}`
          );
          expect(placement.candidate.factKey).toBe(
            `upcoming.${placement.upcomingKey}`
          );
        }
      }
    }
    expect(seen).toEqual(new Set(["later-today", "horizon"]));
  });

  it("excludes ordinary other-profile facts and keeps typed illness context", () => {
    let illnessContext = 0;
    for (const [persona, placements] of manifests) {
      const profileId = personaProfileIds.get(persona)!;
      for (const { candidate } of placements) {
        if (
          candidate.subject.scope === "profile" &&
          candidate.subject.profileId !== profileId
        ) {
          expect(
            candidate.episodeGroup != null ||
              candidate.dashboardScope === "illness-context",
            `${persona}:${candidate.candidateId}`
          ).toBe(true);
        }
        expect(
          candidate.candidateId.startsWith("household.attention:"),
          persona
        ).toBe(false);
        if (candidate.dashboardScope === "illness-context") illnessContext += 1;
      }
    }
    expect(illnessContext).toBeGreaterThan(0);
  });

  it("orders Show everything by its fixed groups", () => {
    const order = ["act", "read", "understand", "setup", "active-states"];
    const seen = new Set<string>();
    for (const [persona, placements] of manifests) {
      const groups = placements
        .filter((placement) => placement.lane === "everything")
        .map((placement) => {
          seen.add(placement.everythingGroup);
          return order.indexOf(placement.everythingGroup);
        });
      expect(groups, persona).toEqual(groups.toSorted((a, b) => a - b));
    }
    expect(seen).toEqual(new Set(order));
  });

  // THE #3077 COMPLETENESS CONTRACT, NOW THE ONLY TIER THAT CARRIES IT (#3366/#4076).
  //
  // Show everything no longer renders every placement, so "nothing the ranker gathers
  // can go missing" stopped being something a reader could verify by scrolling. #3366
  // moved half of it here and left the other half as a rendered "Elsewhere" list of
  // page names; #4076 retired that list (owner: "utterly useless"), so this is now
  // the whole of the guarantee. It is asserted against the REAL manifests and by
  // ITERATING THE DROPS: each non-admitted placement names a page, and the app has a
  // name for that page. A candidate builder that starts dropping without a named page
  // fails here, on the day the guarantee would have quietly stopped holding rather
  // than the day someone noticed.
  it("keeps every dropped Show everything fact on a page the app can name", () => {
    const dropped: string[] = [];
    for (const [persona, placements] of manifests) {
      for (const placement of placements) {
        if (placement.lane !== "everything" || placement.admitted) continue;
        const page = placement.candidate.navDuplicateOf;
        dropped.push(`${persona}:${placement.candidate.candidateId}`);
        expect(
          page && trackedPageFor(page)?.label,
          `${persona}:${placement.candidate.candidateId} has no named page`
        ).toBeTruthy();
      }
    }
    // The loop above is satisfiable by admitting everything, so the seeded profiles
    // must actually exercise a drop for it to have asserted anything.
    expect(dropped.length).toBeGreaterThan(0);
  });

  // AND THE CONVERSE, WHICH THE DROP LOOP ABOVE IS STRUCTURALLY UNABLE TO STATE
  // (#3366). That loop walks the drops, so it stays green on a tree that drops far
  // too MUCH: a builder that put `navDuplicateOf` on a whole group would hand every
  // one of those candidates a named door, satisfy every clause up there, and empty
  // the group out of the tail. `dropped.length > 0` cannot see it either — it only
  // asks that SOMETHING dropped. The ruling's acceptance is that the tail stays
  // exhaustive, so that is asserted here in the direction it is written: these facts
  // are still DRAWN, and the drop reaches exactly one candidate and no further.
  //
  // The survivor list is short and hand-written on purpose, one per tail group. A
  // list derived from the manifests would restate whatever the manifests happen to
  // say and could never contradict them.
  it("keeps drawing the tail it did not drop", () => {
    const drawn = new Map(
      [...manifests].map(([persona, placements]) => [
        persona,
        everythingTail(placements),
      ])
    );
    const survivors: readonly {
      persona: string;
      group: DashboardEverythingGroup;
      candidate: string;
    }[] = [
      {
        persona: "biohacker",
        group: "act",
        candidate: "attention.fact:review",
      },
      { persona: "biohacker", group: "read", candidate: "protocol.adherence:" },
      {
        persona: "biohacker",
        group: "active-states",
        candidate: "protocol.state:",
      },
      {
        persona: "household",
        group: "understand",
        candidate: "appointment.next",
      },
      {
        persona: "marathon-runner",
        group: "setup",
        candidate: "attention.fact:screening:hiv_screening",
      },
    ];
    for (const { persona, group, candidate } of survivors) {
      expect(
        drawn
          .get(persona)!
          .some(
            (placement) =>
              placement.everythingGroup === group &&
              placement.candidate.candidateId.startsWith(candidate)
          ),
        `${persona}: ${candidate} is no longer drawn in ${group}`
      ).toBe(true);
    }
    // Exactly one candidate in the whole seeded population is a link the nav already
    // carries, which is what `care.ts` claims in prose. Widening the drop reddens
    // here rather than quietly shortening the tail.
    //
    // SO A NEW CANDIDATE THAT LEGITIMATELY DECLARES `navDuplicateOf` REDDENS THIS
    // LINE, AND THAT IS THE PIN WORKING, NOT A STALE FIXTURE. Add it to the list
    // deliberately, having satisfied yourself the tail is meant to stop drawing it;
    // the whole point of pinning the set rather than counting it is that widening
    // the drop has to be a decision somebody wrote down.
    expect(
      [...manifests].flatMap(([persona, placements]) =>
        placements.flatMap((placement) =>
          placement.lane === "everything" && !placement.admitted
            ? [`${persona}:${placement.candidate.candidateId}`]
            : []
        )
      )
    ).toEqual(["household:household.episode-history"]);
    // Drawn against dropped against the lane, per persona: a member the split loses
    // on its way to the canvas is neither, and no absence assertion can see that.
    for (const [persona, placements] of manifests) {
      const lane = placements.filter(
        (placement) => placement.lane === "everything"
      );
      const dropped = lane.filter((placement) => !placement.admitted);
      expect(drawn.get(persona)!.length, persona).toBe(
        lane.length - dropped.length
      );
    }
  });

  // THE COMPLETENESS CONTRACT EXTENDED TO THE BAND CAP (owner ruling 2026-09-03,
  // #4065). "Keeps drawing the tail it did not drop" above is a claim about the
  // MANIFEST — the placement the ranker hands the canvas. Since #4065 the Understand
  // and Setup bands can fold most of what they draw behind a count, so completeness
  // now also has to survive RENDERING: a candidate the manifest admits must still be
  // ON THE PAGE once the cap and its fold are applied, open or closed. Real persona
  // data is what actually exercises a folded family (the unit-tier fixtures in
  // lib/__tests__/dashboard-placement-canvas.test.ts prove the mechanism in
  // isolation; this proves it against the same seeded populations #3366's baseline
  // measured — 74 Understand rows, 65+ Setup rows across six personas).
  it("keeps every folded Understand/Setup candidate on the page, and the fold is exercised", () => {
    // THE CAP UNIT, reproduced from DashboardPlacementCanvas.tsx's own `momentBlocks`
    // grouping key (`candidate.groupKey ?? <unique>`) rather than re-imported, since
    // that function is private to the component. This is the POSITIVE half of the
    // measurement below (which bands actually trigger the fold), not the guard
    // itself — the guard is the presence assertion inside the loop, which reuses
    // nothing from this count.
    const blockCount = (
      group: DashboardEverythingGroup,
      placements: DashboardPlacementCanvasProps["placements"]
    ) => {
      const members = placements.filter(
        (placement) =>
          placement.lane === "everything" &&
          placement.everythingGroup === group &&
          placement.admitted
      );
      return new Set(
        members.map(
          (placement) =>
            placement.candidate.groupKey ?? placement.candidate.candidateId
        )
      ).size;
    };

    // STRIP THE LIVE CONTROLS, KEEP THE STRUCTURE. A real persona's presentations
    // carry write controls (`DoseConfirmButton`, snooze/dismiss menus) that reach
    // into app-shell context (toast, quick-entry, offline queue, …) this isolated
    // render does not have — and does not need, since candidacy and fold placement
    // never depend on what a control renders. `data-candidate-id` sits on the row
    // itself, so dropping `value`/`detail`/`control` proves the same completeness
    // claim without reconstructing the shell.
    const structuralOnly = (
      presentations: DashboardPlacementCanvasProps["presentations"]
    ): DashboardPlacementCanvasProps["presentations"] =>
      new Map(
        [...presentations].map(([id, presentation]) => [
          id,
          {
            label: presentation.label,
            href: presentation.href,
            actionLabel: presentation.actionLabel,
            moment: presentation.moment,
          },
        ])
      );

    let cappedBandsExercised = 0;
    for (const [persona, placements] of manifests) {
      const presentations = structuralOnly(rowPresentations.get(persona)!);
      const html = renderToStaticMarkup(
        createElement(DashboardPlacementCanvas, {
          dateLabel: "September 3, 2026",
          placements,
          presentations,
          aheadPresentations: structuralOnly(aheadPresentations.get(persona)!),
          attentionBadgeCount: 0,
          // A placeholder — some personas carry an open illness episode and the
          // canvas requires this whenever they do; its content is irrelevant to
          // the Understand/Setup bands under test.
          illnessGroupNode: createElement("div"),
        })
      );
      for (const group of ["understand", "setup"] as const) {
        const admitted = placements.filter(
          (placement) =>
            placement.lane === "everything" &&
            placement.everythingGroup === group &&
            placement.admitted
        );
        // THE POSITIVE CONTROL, per band: nothing in this loop can mean anything on
        // an empty band.
        if (admitted.length === 0) continue;
        for (const placement of admitted)
          expect(
            html,
            `${persona}/${group}: ${placement.candidate.candidateId} missing from the rendered page`
          ).toContain(`data-candidate-id="${placement.candidate.candidateId}"`);
        if (blockCount(group, placements) > 3) {
          cappedBandsExercised += 1;
          expect(
            html,
            `${persona}/${group}: has >3 blocks but rendered no fold`
          ).toContain(`data-testid="dashboard-everything-${group}-fold"`);
        }
      }
    }
    // The loop above is satisfiable by a population that never exceeds the cap
    // anywhere — the seeded personas are what makes the fold assertion above mean
    // something rather than never firing.
    expect(cappedBandsExercised).toBeGreaterThan(0);
  });

  // THE TAIL'S GENERIC WRITE CARDS ARE GONE, AND THE SHEET HAS THEM (#3366/#4064).
  //
  // Owner ruling: the quick logger is the app's one quick-write surface, so an
  // always-available write control does not also sit in the dashboard tail. An
  // absence assertion alone would pass on a tree where the writes vanished
  // altogether, so each retired candidate is checked against the quick-log row that
  // now carries it — the sheet gained first, the tail dropped second.
  //
  // EACH ROW IS ASKED FOR AT THE LEAST PERMISSIVE FLAGS ITS CAPABILITY CLAIMS, not
  // at `(true, true)`. `logSheetSegments` filters on the #1042 cycle bit and the
  // #3279 substance bit, so the most permissive input cannot distinguish a row every
  // profile reaches from one only a cycle-tracking profile reaches — and the profile
  // that matters here is the FRESH one, which is what `vitals.manual-log` also served
  // as a Setup bootstrap row before it retired. `cycle.control` keeps `cycleRelevant`
  // because cycle relevance is the precondition of that capability itself, not an
  // accident of the fixture. Measured: gating `log-measurements` behind the cycle bit
  // leaves the `(true, true)` form 20/20 green and turns this one red.
  it.each([
    { candidateId: "weight.quick-add", row: "log-measurements", cycle: false },
    { candidateId: "vitals.manual-log", row: "log-measurements", cycle: false },
    { candidateId: "symptom.well-day-log", row: "log-symptom", cycle: false },
    { candidateId: "cycle.control", row: "log-period", cycle: true },
  ] as const)(
    "$candidateId left the dashboard for the quick logger's $row",
    ({ candidateId, row, cycle }) => {
      for (const [persona, placements] of manifests) {
        expect(
          placements.map((placement) => placement.candidate.candidateId),
          persona
        ).not.toContain(candidateId);
      }
      expect(
        logSheetSegments(cycle, false).flatMap((segment) =>
          segment.items.map((item) => item.id)
        )
      ).toContain(row);
    }
  );

  // Re-pointed by #4232: a quiet pillar is not a Standing member any more, so the
  // family key it used to be asserted through is gone with the band. What replaces it
  // is the MOMENT the tail folds the pillars into — the same claim (this reading
  // belongs to the healthspan family and nowhere else) read off the surface that now
  // carries it. Counted, so a re-point onto something the personas never produce
  // cannot go green by matching nothing.
  it("keeps sleep regularity only in its healthspan moment", () => {
    let seen = 0;
    for (const [persona, placements] of manifests) {
      expect(
        placements.some(({ candidate }) =>
          candidate.candidateId.startsWith("sleep.regularity:")
        )
      ).toBe(false);
      for (const placement of placements.filter((entry) =>
        entry.candidate.candidateId.includes("sleep-regularity")
      )) {
        seen += 1;
        expect(
          [placement.lane, placement.candidate.groupKey],
          `${persona}:${placement.candidate.candidateId}`
        ).toEqual(["everything", "healthspan.pillars"]);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  // WHERE THE FORMER QUIET POPULATION WENT (#4232), against the real personas.
  //
  // Standing shrank to its attention tier and its stable rest, so the members the
  // registry calls quiet stopped being claimed and the exact-once partition routes
  // them on their own model. The ruling names the destinations, so they are asserted
  // as destinations rather than as "not in Standing" — an absence that would pass on
  // a tree where the rows vanished with the band.
  //
  // EACH ROW CARRIES ITS OWN REACH COUNT, because a prefix no persona produces makes
  // its clause vacuous while looking exactly like a clause that held. Measured on this
  // fixture: pillars 12, out-ranked cold-start CTAs 16, quiet results 5, results
  // claiming the freshness window 28. The dormant replacements (`weight.dormant`,
  // `sleep.dormant`) are NOT here — no persona seeds a dormant domain, so a clause for
  // them would have been the vacuum this comment exists to prevent; e2e's
  // DORMANT_DOMAINS_PROFILE is where that route is asserted.
  it("routes every former quiet member into the fold's correct group, exactly once", () => {
    const expected: readonly [string, DashboardEverythingGroup][] = [
      ["healthspan.pillar:", "read"],
      ["activity.steps-bootstrap", "setup"],
      ["nutrition.bootstrap", "setup"],
      ["sleep.bootstrap", "setup"],
    ];
    const reach = new Map<string, number>();
    for (const [persona, placements] of manifests) {
      const ids = placements.map(({ candidate }) => candidate.candidateId);
      for (const [prefix, group] of expected) {
        for (const placement of placements.filter((entry) =>
          entry.candidate.candidateId.startsWith(prefix)
        )) {
          reach.set(prefix, (reach.get(prefix) ?? 0) + 1);
          expect(
            [
              placement.lane,
              placement.lane === "everything"
                ? placement.everythingGroup
                : placement.lane,
            ],
            `${persona}:${placement.candidate.candidateId}`
          ).toEqual(["everything", group]);
          // EXACTLY once — the lane is the exact-once remainder, and a member that
          // left Standing must not have left a copy behind.
          expect(
            ids.filter((id) => id === placement.candidate.candidateId).length,
            `${persona}:${placement.candidate.candidateId}`
          ).toBe(1);
        }
      }
      // A quiet clinical result reads; one inside the freshness window claims the
      // tier instead (#4232 ruling 3). Both are asserted, so neither branch can be
      // the only one this fixture ever meets.
      for (const placement of placements.filter((entry) =>
        entry.candidate.candidateId.startsWith("labs.latest:")
      )) {
        const fresh = placement.candidate.rankReasons.owed;
        reach.set(
          fresh ? "labs.latest:fresh" : "labs.latest:quiet",
          (reach.get(fresh ? "labs.latest:fresh" : "labs.latest:quiet") ?? 0) +
            1
        );
        expect(
          [
            placement.lane,
            placement.lane === "standing"
              ? placement.standingBand
              : placement.lane === "everything"
                ? placement.everythingGroup
                : placement.lane,
          ],
          `${persona}:${placement.candidate.candidateId}`
        ).toEqual(fresh ? ["standing", "attention"] : ["everything", "read"]);
      }
      // …and the converse the routing loop cannot state: Standing still DRAWS, and
      // it draws no band but the two.
      const standing = placements.filter(
        (placement) => placement.lane === "standing"
      );
      expect(standing.length, persona).toBeGreaterThan(0);
      expect(
        [
          ...new Set(standing.map((placement) => placement.standingBand)),
        ].sort(),
        persona
      ).not.toContain("tail");
    }
    for (const key of [
      "healthspan.pillar:",
      "activity.steps-bootstrap",
      "nutrition.bootstrap",
      "sleep.bootstrap",
      "labs.latest:fresh",
      "labs.latest:quiet",
    ])
      expect(reach.get(key) ?? 0, `${key} was never produced`).toBeGreaterThan(
        0
      );
  });

  // WHERE THE ACKNOWLEDGMENT IS OFFERED (#3225). It spends a CLAIM, so the control
  // belongs on the rows that still hold one — fresh, or notable — and nowhere a
  // second control would post the same signal, which is a row whose
  // `biomarker-flag:` key already carries an attention fact.
  //
  // "chronic notable" is this issue's own population and the state that moved. A
  // notable result too old to be fresh is also too old to carry an attention item:
  // the flagged window bounds the COLLECTION date at 14 days, inside the 30-day
  // freshness window — so #4232's freshness-only rule left the owner's 37 June
  // notables with no acknowledge control on the dashboard at all, only on the detail
  // page each row links to. Reach is counted per state because a table over real
  // personas says nothing about a state no persona reaches.
  it("offers the acknowledgment on every unspent claim and nowhere twice", () => {
    const reach = new Map<string, number>();
    for (const [persona, placements] of manifests) {
      const presentations = rowPresentations.get(persona)!;
      const placed = new Set(
        placements.map(({ candidate }) => candidate.candidateId)
      );
      for (const placement of placements.filter((entry) =>
        entry.candidate.candidateId.startsWith("labs.latest:")
      )) {
        const name = placement.candidate.candidateId.slice(
          "labs.latest:".length
        );
        const presentation = presentations.get(
          placement.candidate.candidateId
        )!;
        // The flag the ROW ITSELF prints, read off its `MedicalValue`, so notability
        // here is the word the person sees and not a second read of the record.
        const flag = (
          presentation.value as ReactElement<{ flag: MedicalFlag | null }>
        ).props.flag;
        const state = placed.has(
          dashboardAttentionCandidateId(biomarkerFlagDismissalKey(name))
        )
          ? "hosted on its attention row"
          : placement.candidate.rankReasons.owed
            ? "fresh"
            : isNotableFlag(flag)
              ? "chronic notable"
              : "quiet and ordinary";
        reach.set(state, (reach.get(state) ?? 0) + 1);
        expect(
          presentation.control != null,
          `${persona}:${name} (${state})`
        ).toBe(state === "fresh" || state === "chronic notable");
      }
    }
    for (const state of [
      "fresh",
      "hosted on its attention row",
      "chronic notable",
      "quiet and ordinary",
    ])
      expect(
        reach.get(state) ?? 0,
        `${state} was never produced`
      ).toBeGreaterThan(0);
  });

  // NOW GATHERS BY SUBJECT ON A REAL HOUSEHOLD MANIFEST (#4752 item 6). The layers
  // are unchanged — safety is uncapped and still leads — but a cross-profile Now
  // clusters each subject's rows before drawing them, so the viewer's own live
  // workout sits under the viewer's own illness instead of trailing two other
  // people's. This is the manifest that says it over the real personas rather than
  // over a hand-built candidate list.
  it("orders real safety, then whole subject clusters, on the household manifest", () => {
    const placements = manifests
      .get("household")!
      .filter((placement) => placement.lane === "now");
    const now = placements.map((placement) => placement.candidate.candidateId);
    const illnesses = now.filter((id) => id.startsWith("illness.state:"));
    const safetyIndex = placements.findIndex(
      ({ candidate }) => candidate.rankReasons.safety
    );
    const workoutIndex = now.findIndex((id) => id.startsWith("workout.live:"));
    expect(illnesses).toHaveLength(3);
    expect(safetyIndex).toBeGreaterThanOrEqual(0);
    expect(safetyIndex).toBeLessThan(
      Math.min(...illnesses.map((id) => now.indexOf(id)))
    );
    expect(workoutIndex).toBeGreaterThan(-1);

    // THE GROUPING IS REAL HERE, and the assertions below would be vacuous if it
    // were not: more than one subject, and every subject labelled.
    const subjects = placements.map((placement) =>
      placement.lane === "now" ? placement.nowSubject : null
    );
    expect(subjects.filter((subject) => subject == null)).toEqual([]);
    expect(new Set(subjects).size).toBeGreaterThan(1);
    // EACH CLUSTER IS CONTIGUOUS — that IS "group by subject". A subject whose rows
    // were interleaved with another's would open twice here.
    const opens = subjects.filter(
      (subject, index) => subject !== subjects[index - 1]
    );
    expect(opens).toEqual([...new Set(subjects)]);

    // The viewer's own illness leads the viewer's own workout, INSIDE one cluster:
    // rank survives the gathering.
    const viewer = String(personaProfileIds.get("household"));
    expect(subjects[workoutIndex]).toBe(viewer);
    const viewerIllness = now.findIndex(
      (id, index) =>
        id.startsWith("illness.state:") && subjects[index] === viewer
    );
    expect(viewerIllness).toBeGreaterThanOrEqual(0);
    expect(viewerIllness).toBeLessThan(workoutIndex);
    // And the other two households' illnesses follow that whole cluster rather than
    // being overtaken by it — gathering promotes nobody.
    const otherIllnesses = now
      .map((id, index) => ({ id, index, subject: subjects[index] }))
      .filter(
        (row) => row.id.startsWith("illness.state:") && row.subject !== viewer
      );
    expect(otherIllnesses).toHaveLength(2);
    expect(Math.min(...otherIllnesses.map((row) => row.index))).toBeGreaterThan(
      workoutIndex
    );
  });

  it("leads with the acting illness before two household profiles and reorders on switch", () => {
    const illnessProfiles = (
      placements: DashboardPlacementCanvasProps["placements"]
    ) =>
      placements
        .filter(
          ({ lane, candidate }) =>
            lane === "now" && candidate.episodeGroup?.memberRole === "state"
        )
        .map(({ candidate }) => candidate.episodeGroup!.profileId);
    const original = illnessProfiles(manifests.get("household")!);
    expect(original).toHaveLength(3);
    expect(original[0]).toBe(personaProfileIds.get("household"));
    expect(original.slice(1)).toEqual(
      original.slice(1).toSorted((a, b) => a - b)
    );
    const switched = illnessProfiles(switchedHouseholdManifest);
    expect(switched).toHaveLength(3);
    expect(switched[0]).toBe(switchedHouseholdProfileId);
    expect(switched.slice(1)).toEqual(
      switched.slice(1).toSorted((a, b) => a - b)
    );
  });

  // THE DASHBOARD QUERY BUDGET (#3096, #3151, #3184, #3164, #3369).
  //
  // How many database statements one dashboard render issues, per seeded persona,
  // with the memoizing request cache installed at the top of this file — so these
  // are the queries a production render actually pays, not the test tier's
  // once-per-caller inflation of them.
  //
  // MEASURED, NOT CHOSEN. Every number below was read off a run of this file on
  // main; none is a target, a round number, or a ceiling with headroom baked in.
  // That is what lets the assertion report a DELTA: a red says whether the change
  // in front of you spent the queries or whether main already had.
  //
  // HOW TO REFRESH. Run this file, read the failure — it prints the paste-ready
  // block — and paste it here IN THE SAME COMMIT as the change that moved it.
  // A LEGITIMATE refresh comes with a sentence saying which reads moved and why:
  // a new dashboard surface that gathers, a candidate builder that now asks one
  // more question, or (the good direction) a dedup that removed some. Editing a
  // number so CI goes green, with no account of what moved, is the failure this
  // table exists to make visible — a stale-high baseline silently absorbs the next
  // regression, which is exactly how the old single cap stopped meaning anything.
  // #3723 batches additive metric totals, recovering two statements for the
  // bodybuilder and four for the biohacker while preserving source election.
  // #3366 retires the tail's four generic write cards. Only the SYMPTOM bar gathered
  // anything of its own — severities, notes, custom names and log order, 13 statements
  // — so every persona that renders it recovers exactly those. `household` is flat
  // because its acting profile is sick, and the well-day bar never rendered there.
  // #1851 makes the sleep read per-night, which DELETES the profile-wide source
  // election and the DISTINCT source scan that fed it — one statement back for every
  // persona, household included, since every dashboard reaches a sleep session.
  // −1 on every persona EXCEPT household (#4076): retiring the PRN dose candidates
  // retired the `getPrnIntakeItemsForQuickLog` read that gathered them. Household is
  // unchanged because that read was already skipped there — it is gated on a WELL day
  // and the household fixture carries an open illness.
  // +4 on household ONLY (#4609): the illness cockpit gather asked for the profile's
  // pediatric figures and nothing else, so the "Add medication" fold it renders mounted
  // the intake form with no stack, variants, conditions or local day — an unknown-age
  // alcohol note over a child's weight-band dosing. It now loads the whole
  // intake-form context per cockpit. This fixture renders three cockpits; measured by
  // stubbing the loader out of the gather alone, that is +7 for the context and −3 for
  // the per-cockpit pediatric read it subsumes. Every other persona is flat because
  // none carries an open illness, and /medications is unmoved: med-data now reads the
  // same rows through the one loader instead of assembling its own copy.
  // −1 on EVERY persona (#5010): `getHrMinutesInRange` joined the request cache.
  // `getDayLoadInputs` and `getIntensitySignal` both read the same trailing 42-day
  // window on one render, so the memo collapses two identical reads into one. It moves
  // every persona, including those with no `hr_minutes` at all, because the second read
  // was issued regardless of what it returned.
  // −20 on every persona and −21 on household (#3369 item 2): eight reads that one
  // render asked the SAME question of, more than once, joined the request cache at
  // their existing author. Measured LEAVE-ONE-OUT on this file — each wrap disabled
  // alone against the other seven — so these are contributions, not a split of the
  // total guessed after the fact; they sum to exactly the move above, so the eight
  // compose rather than overlap. Per persona: getActiveRoutine 4, getWeights 3,
  // getOutcomeGoals 3, getEpisodeRowForDate 3, getLatestBodyMetricDated 2 (3 on
  // household), getFoodDailyServingTotals 2, mostRecentClosedEpisodeRow 2,
  // getActiveMedicationFamilies 1.
  //
  // WHAT WAS DELIBERATELY NOT WRAPPED, because a memo there would have hidden real
  // work rather than removed it: `getEpisodeRowsForDate` runs 4× on household and
  // its four executions carry FOUR DIFFERENT profile ids — the household's own
  // per-profile fan-out — and `preloadProfileSettings` is likewise one read per
  // profile already. Both would have shown a green count and cost the same queries.
  // Every wrap above keys on `profile_id`, so what collapses is one profile asking
  // twice and never one profile answering for another; the two-profile assertion
  // below is what holds that.
  const QUERY_BASELINE: Record<string, number> = {
    // +1 on four personas and +3 on two (#4956): the attention read now also asks
    // whether a live source is DROPPING a record type. That is one scan of this
    // profile's CONNECTED sources, plus one bounded window of recent runs per
    // connected source that declares a silence tolerance. Four personas have no such
    // source and pay the scan alone; `marathon-runner` and `biohacker` each have two
    // (health-connect and strava) and pay a window read for each, hence +3. Counted
    // per persona in this file's own statement trace: the scan 1 everywhere, the
    // window 0/2/0/0/0/2. Bounded by the number of connected sources and never by
    // history — DROPPING_RUN_CAP caps what each window read returns.
    //
    // RE-MEASURED ON THE MERGED TREE after #4953's +1/+4 landed, and the +1/+3 came
    // back unchanged on every persona, so the two compose. Re-measuring was not a
    // formality here: on three personas this branch's +1 and #4953's +1 produced the
    // SAME number from the same base, so git auto-merged them as one change and the
    // merge was quietly a query short on each.
    // +2 each (#2921): the Vision/Dental relevance bits now ask the SPECIALTY LENS
    // as well as their own table, so a profile whose only eye care is VISITS stops
    // having its pane hidden. That is one representative-id encounters read plus
    // the shared conditions list, once per render under the request memo.
    // `household` spends +1 rather than +2 because `hasSpecialtyLensContent`
    // short-circuits: it reads conditions only when the visits read found nothing,
    // and on that persona one of the two lines stops at the visits read.
    // The two bits gate the Records › Specialty panes and nothing else (no nav leaf
    // carries them), so this is a cost the dashboard pays for a question asked on
    // another page — recorded here rather than absorbed, and the cheapest way to
    // remove it later is to drop the two vestigial bits from NavRelevance.
    // −3 each (#4228 A): the recap's adherence walk stops before today, so no
    // persona makes today's three per-day reads any more — the day's activities,
    // its taken set and its skipped set. `household` is unmoved because its acting
    // profile has no active intake items, so `windowAdherence` returns before the
    // walk and never made them; measured by instrumenting the walk and rendering
    // all six personas, which reported five walking one day fewer and household
    // short-circuiting.
    // +1 on EVERY persona (#4767 item 2), MEASURED ON THE MERGED TREE each time and
    // never added to main's numbers by hand: the Today band's intraday chart asks
    // for the profile's latest worn HR day before anything else, and none of these
    // six has one on today, so all six pay exactly that one indexed read and stop.
    // The gate doing its job — a profile that DOES have today's minutes pays the day
    // gather too, which is the cost of DRAWING the chart rather than of asking.
    //
    // Re-measured against three different mains while this branch waited to land
    // (#4228 A's −3 on five personas, then household's +4 above), and the +1 came
    // back unchanged every time, on every persona. So it composes with all of them
    // rather than interacting with any — which is a measurement, not an assumption
    // about independence.
    // +1 on EVERY persona and +4 on biohacker (#4299): the sleep clock-skew check asks
    // whether any synced sleep session's stored instants disagree with the heart rate
    // recorded across them. A persona with no synced sleep pays the candidate read and
    // stops — that is the +1 — while biohacker, which has synced nights AND a heart-rate
    // trace, pays the candidate read, ONE batched read of the minutes across the judged
    // span, its travel log, and the narrow last-night repeat of the same question the
    // bed/wake row asks.
    //
    // MEASURED AT +33 BEFORE THE GATHER WAS BATCHED, on this same test: the first
    // version issued one heart-rate SELECT per night, so its cost grew with the
    // profile's sleep history rather than with the question. That is what this baseline
    // is for, and it is why biohacker moves by 4 here instead of by 33.
    //
    // RE-MEASURED ON THE MERGED TREE, with #4775's −1 already in main's numbers: the
    // same +1/+4 came back on every persona, so the two moves compose rather than
    // interact. Measured, not arithmetic on two branches' deltas.
    // +1 on EVERY persona (#3195): the day's ride-best recap is one statement for the
    // day's rides. None of the six has a ride with a stored summary today, so the
    // per-ride prior read and the segment read never execute — the +1 is the statement
    // asking, not answering. A persona that DID ride today pays the reads that produce
    // the sentence, which is the cost of having one rather than of looking.
    //
    // RE-MEASURED ON THE MERGED TREE against #4967's numbers, which were themselves
    // measured against #4299's, which were measured against #4775's: the same +1 came
    // back on all six every time. Four independent moves in this baseline today and
    // each composes with the others — measured each time, never summed.
    //
    // AND NEVER TAKEN FROM THE MERGE. On the merge against #4967, four of these six
    // numbers were IDENTICAL on both sides while meaning different things — each side
    // had added its own +1 to a different base — so git auto-merged them as agreement
    // and only flagged the two that happened to differ. Taking that merge would have
    // left four personas a query short with nothing to show for it. The numbers below
    // came from running the gate on the merged tree, which is the only thing that can
    // tell "we agree" from "we both landed on 227 by coincidence".
    // −2 EACH (#5073), and the sign is the surprise: this change ADDS one statement
    // per render (`SELECT total_changes()`, the memo's own version read) and still
    // comes out negative, because three of the six memoized gathers' calls inside ONE
    // render were duplicates. `getScheduledAppointments` is reached four times on a
    // dashboard render — the page's Upcoming list, `kindedScheduled` from the Upcoming
    // generators, the intake warnings and the surgery bridge — and it was request-
    // cached by nobody. The commit memo collapses those to one, so −3 +1 = −2. The
    // WARM table below is where this change's actual subject shows up.
    bodybuilder: 204,
    "marathon-runner": 205,
    household: 252,
    pregnant: 200,
    "diabetic-cgm": 211,
    // +9 (#4424 ruling 7): Upcoming's practice rows mount the shared row control, so
    // the row now resolves what that control renders — `getTrackedPractices`, which is
    // one grouped today-tally and one live sweep however many practices there are,
    // plus the usual-duration vote per practice. Assembling the same four fields
    // per-target instead measured +13.
    biohacker: 231,
    // −1 each (#5061): `getDayLoadInputs` and `getIntensitySignal` ask the same
    // question of the same 42 days — the shared HR read, kept to the activity windows
    // that bound it — and only the READ was request-cached (#5010), so each one still
    // fetched the windows and walked every minute again. `windowScopedBuckets` in
    // lib/queries/zones.ts caches the scoped answer instead, and the second fetch of
    // `activities` goes with it. The statement is the only one that moved: diffing the
    // profiler's per-statement counts over one snapshot render, before and after,
    // reports exactly `SELECT date, start_time, end_time, duration_min FROM activities`
    // ×3 → ×2 and nothing else. The walk it also removed is not a statement and so is
    // invisible here — 144,000 of the render's 295,200 bucket comparisons, counted with
    // a probe rather than read off this meter.
    // −1 each (#4775): the paired-observation registry gained a third alcohol entry
    // (`alcohol-overnight-hr`), which reads the SAME `food_daily_totals` window the
    // other two already read — and the factor read happens before each entry's
    // short-circuit, so it was being paid once per entry. `factorDaysReader` memoizes
    // it per gather the way `outcomeSeriesReader` already memoized the outcome side,
    // so three entries now cost one read where two cost two. The new entry's own
    // outcome series is lazy and is not reached on these personas.
  };

  // A BACKSTOP, NOT THE METER. The baseline above is the meter; this is the bound
  // on how far the baseline may be refreshed upward before the refresh needs a
  // conversation rather than a paste.
  //
  // DERIVED FROM THE BASELINES, WHICH IS THE ONLY WAY IT CAN FIRE. This was the
  // historical phase-5 cap of 535 (#3184) until the memoizing request cache above
  // showed what a render really costs. Against the heaviest persona's 267 that left
  // ~270 statements of slack — a bound at twice the real number, which is decoration
  // rather than a bound, and decoration is exactly what the single cap had already
  // decayed into by the time #3164 filed against it. So it is re-derived here:
  //
  //   household 254 (the heaviest baseline) + 20 headroom = 274
  //
  // RE-DERIVED, NOT LEFT BEHIND (#3410/#3316/#3100). This line has read "267 + 23"
  // and then "270 + 20" as the household baseline moved, and it is the one arithmetic
  // this comment cannot afford to get wrong: the whole subject here is that these
  // numbers are honest. What changes is the split of the ceiling into "what a render
  // costs" and "what is left", and the split has to be re-done every time either half
  // moves — including, as below, when it moves DOWN.
  //
  // WHAT THE HEADROOM IS FOR: one household-shaped addition landing without a
  // conversation. The integrated household fixture carries four profiles, so an
  // UNCONDITIONAL new per-profile dashboard read costs four statements there and 20
  // is five such reads, or one new gathering surface. A read behind a per-profile
  // CONDITION costs less: the stack vocabulary added to getIntakeCatalogOptions
  // (#3100) is one statement per profile that renders an illness cockpit, and this
  // fixture has three, which is exactly the +3 that moved household 267 → 270.
  // Ordinary work pastes its refreshed baseline and moves on; a change that needs
  // more than a whole new surface's worth of queries has to say so out loud.
  //
  // RE-DERIVE IT WHENEVER THE BASELINES MOVE MATERIALLY DOWN — same one-line edit.
  // #3369's items 1 and 2 (deferring the closed tail's gathers, and cache()-wrapping
  // the residual duplicates) are each expected to take a bite out of these numbers;
  // when they do, this number follows them down. A ceiling left behind by a
  // reduction stops being able to fire, and then it is decoration again.
  //
  // 290 → 275 (#3369 item 2), WHICH IS THAT RULE BEING FOLLOWED RATHER THAN AN
  // OPTIMISATION BANKED. Wrapping the eight repeated reads took household 276 → 255,
  // so the derivation above re-runs as 255 + 20 = 275 and the ceiling follows the
  // baselines down. Leaving it at 290 would have parked 35 statements of slack over
  // the heaviest persona — room for a 20-query regression to be pasted in without
  // anyone having the conversation this bound exists to force, which is the exact
  // decay the 535 suffered. Re-deriving is one line and is meant to happen every
  // time a gather moves these numbers.
  //
  // 275 → 274 (#5061), the same rule again and the smallest it will ever look. The
  // zone reads stopped fetching the activity windows twice, which is −1 on every
  // persona, so household is 254 and the derivation above re-runs as 254 + 20 = 274.
  // A one-statement reduction is exactly the size at which leaving the ceiling alone
  // feels reasonable, and that is the decay: nothing here ever moves by 15 at once,
  // it moves by one several times and the slack is what accumulates. The arithmetic
  // in this comment is the whole product, so it follows the number down or it is
  // false — which is the same defect #5062 deleted from this file, one paragraph up.
  //
  // WHAT IS NOT COMING: #3369 item 1 said the closed Show-everything tail's node
  // payloads would move behind the disclosure and take a bite out of the table
  // above. Measured on 5045340d by attributing every statement to the page frame
  // that issued it — one stack capture per statement, six personas, the per-line
  // counts summing to exactly the six baselines — the tail's payloads are not what
  // this page spends. The whole candidate-and-row region of `app/(app)/page.tsx`,
  // every `add(...)` and every presentation built for one, issues ONE statement per
  // persona (`getLastSleepRecordDate`, itself a dormancy date and so candidacy) and
  // none at all on biohacker. Every other statement comes from the shared gathers
  // ABOVE the first candidate — which is also where the candidate IDS come from.
  // Six of those gathers do feed nothing but everything-lane candidates and are
  // worth 32-47% of a render (collectCoachingFindings 38-44, gatherCoachingInput
  // 17-22, getRecapCard 8-16, getHealthspanPillars 10-18, getActiveProtocolSummaries
  // 1-13, getScheduledAppointments 1), but each MINTS the ids it feeds —
  // `data-quality.finding:<dedupeKey>`, `recap.<line>`, `healthspan.pillar:<key>` —
  // so deferring one defers CANDIDACY, not a payload, and that is the #3077
  // exact-once partition rather than a cost question.
  //
  // 274 → 272 (#5073), the same rule a fourth time. The commit-scoped memo takes
  // household 254 → 252, so the derivation above re-runs as 252 + 20 = 272. Note it
  // still tracks the COLD number: a ceiling derived from the warm one would be a bound
  // on a render nobody's first load ever gets.
  const QUERY_CEILING = 272;

  it("dashboard query budget: each persona matches its recorded main baseline", () => {
    // THE BACKSTOP ASKS ABOUT THE TABLE, NOT THE MEASUREMENT — which is the only
    // place it can ever speak. A measured count above the ceiling has necessarily
    // drifted off its baseline first, so the drift assertion below would have thrown
    // and a ceiling checked against `queryCounts` could never be reached. What the
    // backstop is actually for is a REFRESH: someone pastes a table that has grown
    // past what a paste may decide alone. That is a question about the pasted
    // numbers, so it is asked of them, and asked BEFORE the drift check so a bad
    // paste is named as a bad paste instead of hiding behind whatever else moved.
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
        "about what the dashboard gathers — not a number to raise so CI goes green.\n" +
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
      "Dashboard query counts moved off the recorded baseline.\n" +
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
  //
  // WHAT IS LEFT is everything the memo does not cover: the Now/Standing/Ahead gathers,
  // the suppression bus and `routineOrder` (deliberately unmemoized — a dismissal taken
  // since the last commit must still be read fresh), and one `SELECT total_changes()`
  // for the memo's own version read.
  const WARM_BASELINE: Record<string, number> = {
    bodybuilder: 119,
    "marathon-runner": 121,
    household: 177,
    pregnant: 119,
    "diabetic-cgm": 128,
    biohacker: 134,
  };

  it("dashboard query budget: a second load with no write in between matches its warm baseline (#5073)", () => {
    // THE COLD COUNT IS THE CONTROL. "The warm render issues none of the six gathers'
    // statements" is only evidence if the cold render DID issue them — a memo that
    // returned nothing at all would satisfy the warm half exactly as well.
    const notCheaper = [...warmQueryCounts].flatMap(([persona, warm]) => {
      const cold = queryCounts.get(persona)!;
      return warm < cold
        ? []
        : [`${persona}: warm ${warm} is not below cold ${cold}`];
    });
    expect(
      notCheaper,
      "A warm dashboard load cost as much as the cold one.\n" +
        "Either the commit-scoped memo (lib/commit-cache.ts) stopped holding the six\n" +
        "tail gathers, or something wrote between the two renders — a render itself\n" +
        "writes nothing, so a write here is a regression rather than noise."
    ).toEqual([]);

    const drift = [...warmQueryCounts].flatMap(([persona, count]) => {
      const baseline = WARM_BASELINE[persona];
      if (baseline === undefined)
        return [`${persona}: ${count} warm queries, but no recorded baseline`];
      if (count === baseline) return [];
      const delta = count - baseline;
      return [
        `${persona}: ${count} warm queries, baseline ${baseline} ` +
          `(${delta > 0 ? `+${delta}` : `${delta}`})`,
      ];
    });
    const refreshed = [...warmQueryCounts]
      .map(([persona, count]) => `    ${JSON.stringify(persona)}: ${count},`)
      .join("\n");
    expect(
      drift,
      "Warm dashboard query counts moved off the recorded baseline.\n" +
        "Refresh WARM_BASELINE in this file with:\n\n" +
        `  const WARM_BASELINE: Record<string, number> = {\n${refreshed}\n  };\n`
    ).toEqual([]);
  });

  it("places exactly the same candidates on a warm load (#3077 through #5073)", () => {
    // #3077's partition is what the memo must not touch: every candidate the ranker
    // sees on a cold load it sees on a warm one, in the same lane and the same order.
    // Compared as the ordered lane+candidateId census rather than by deep equality, so
    // this reads the identity the partition is actually about.
    const census = (
      placements: DashboardPlacementCanvasProps["placements"]
    ): string[] =>
      placements.map(
        (placement) => `${placement.lane}:${placement.candidate.candidateId}`
      );
    for (const persona of PERSONAS) {
      const cold = census(manifests.get(persona.name)!);
      expect(cold.length).toBeGreaterThan(0);
      expect(census(warmManifests.get(persona.name)!), persona.name).toEqual(
        cold
      );
    }
  });

  it("reads each hr_minutes window once per render (#5010)", () => {
    // THE CONTROL COMES FIRST BECAUSE ZERO IS THE FLATTERING ANSWER. Every window
    // below is distinct when no window was read at all, which is the state all six
    // personas are in — and it is what the assertion would report forever if the
    // statement this watches were renamed or the fixture stopped reaching the reader.
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
        "because N reads of N windows and N reads of one window are both N.\n" +
        "The usual cause is a caller reaching the reader outside the request memo, or\n" +
        "two callers spelling one span differently — separate keys, one window. #5069\n" +
        "required `until`, so the trailing window now has a single spelling."
    ).toEqual([]);
  });
});

// THE PRACTICE-TARGET ROW LOGS IN PLACE (#4076, the 2026-08-30 "#4384 thread"
// ruling). Self-contained: its own profiles, its own render — it does not touch
// PERSONAS or QUERY_BASELINE above, so a change here cannot silently move either.
//
// Rolling mode (the default; no week_start/week_mode setting is written) makes the
// window always fully elapsed (#748 item 3's `elapsedDays: 7`), so a fresh
// per_week >= 1 target with zero sessions in the trailing week is BEHIND by
// construction — no calendar alignment to pin. That is the fixture every case below
// reuses, varied on exactly the one axis each case is about.
describe("the practice-target row logs in place (#4076)", () => {
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
    const page = (await requestCache.during(
      async () => await Dashboard()
    )) as ReactElement<{ children: ReactElement }>;
    const surface = page.props.children as ReactElement<{
      children: ReactElement;
    }>;
    const canvas = surface.props
      .children as ReactElement<DashboardPlacementCanvasProps>;
    return {
      candidateIds: canvas.props.placements.map(
        (placement) => placement.candidate.candidateId
      ),
      presentations: canvas.props.presentations,
    };
  }

  function seedTarget(
    name: string,
    scopeKind: "practice" | "type",
    scopeValue: string,
    perWeek: number
  ): number {
    const profileId = newProfile(`dashboard:${name}`);
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

  it("carries LogPracticeButton in the row's control slot and drops the target.log door", async () => {
    const profileId = seedTarget("practice-behind", "practice", "Sauna", 2);
    const { candidateIds, presentations } = await renderFor(profileId);

    const rowId = candidateIds.find((id) =>
      id.startsWith("target.weekly-progress:")
    );
    expect(rowId, candidateIds.join(", ")).toBeDefined();
    expect(candidateIds.some((id) => id.startsWith("target.log:"))).toBe(false);

    const control = presentations.get(rowId!)?.control as ReactElement<{
      practice: string;
      todayCount: number;
      today: string;
      compact?: boolean;
    }> | null;
    expect(control, "no control on the behind practice-target row").not.toBe(
      null
    );
    expect(control!.type).toBe(LogPracticeButton);
    expect(control!.props.practice).toBe("Sauna");
    expect(control!.props.todayCount).toBe(0);
    expect(control!.props.compact).toBe(true);
  });

  // THE CONVERSE (a removal guard proves nothing alone): an ON-PACE practice
  // target — met, so never behind — keeps NO control and no door either, because
  // an already-met target offers nothing to log. Distinguishes "logs in place" from
  // "every practice row gets a button".
  it("an on-pace (met) practice target's row carries no control and no door", async () => {
    const profileId = seedTarget("practice-met", "practice", "Sauna", 1);
    const today0 = today(profileId);
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, logged_via) VALUES (?, 'Sauna', ?, 'page')`
    ).run(profileId, today0);
    const { candidateIds, presentations } = await renderFor(profileId);

    const rowId = candidateIds.find((id) =>
      id.startsWith("target.weekly-progress:")
    );
    expect(rowId, candidateIds.join(", ")).toBeDefined();
    expect(presentations.get(rowId!)?.control).toBeFalsy();
    // A met target is never "owed" a log — this asserts the family's existing
    // `!progress.met` applicability, not anything this change touches.
    expect(candidateIds.some((id) => id.startsWith("target.log:"))).toBe(false);
  });

  // THE OTHER CONVERSE: a behind target OUTSIDE the practice domain (training's
  // `type`/cardio scope, the marathon-runner persona's own shape) keeps the
  // ORIGINAL door and gets no control — the ruling is scoped to
  // `scope_kind === "practice"`, and #4083's dose precedent (and every other habit
  // domain) is untouched by it. Not `group`/`region` — those are STRENGTH-
  // programming scopes (`isStrengthProgrammingScope`), gated on a known adult-ish
  // age this fixture does not set, and would drop out of `freqTargets` entirely for
  // an unrelated reason before ever reaching the row this test is about.
  it("a behind training (type/cardio-scope) target keeps its door and carries no control", async () => {
    const profileId = seedTarget("cardio-behind", "type", "cardio", 2);
    const { candidateIds, presentations } = await renderFor(profileId);

    const rowId = candidateIds.find((id) =>
      id.startsWith("target.weekly-progress:")
    );
    expect(rowId, candidateIds.join(", ")).toBeDefined();
    expect(presentations.get(rowId!)?.control).toBeFalsy();
    expect(candidateIds.some((id) => id.startsWith("target.log:"))).toBe(true);
  });
});
