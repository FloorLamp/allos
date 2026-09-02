// Real-schema candidate census and query budget for the dashboard cutover (#3096).

import type { ReactElement } from "react";
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
import { accessibleProfileIdsForLogin, type SessionProfile } from "@/lib/auth";
import { authorizedProfileSubset } from "@/lib/cross-profile";
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

const session = vi.hoisted(() => ({
  loginId: 0,
  profile: null as SessionProfile | null,
  accessible: [] as SessionProfile[],
}));

// A REAL memoizing stand-in for `lib/request-cache`'s `cache()` (#3369).
//
// WHY. `lib/request-cache.ts` is `React.cache ?? ((fn) => fn)`, and its own comment
// says the rest: outside a Next server request React.cache has no dispatcher and
// simply calls through. So in this tier every `cache()`-wrapped read executes once
// per CALLER, and the number counted below overstated what a production render pays
// by roughly 30 statements per persona (#3369 measured household 297 -> 267,
// biohacker 305 -> 258; the trace's top "offender", `getSleepSessions`' two
// statements at 9x each, collapses to one). A budget policed by an overstating meter
// polices a number nobody pays, so the meter gets the memo first and the reductions
// it is used to measure come after.
//
// THE SCOPE IS ONE RENDER, AND NOT ONE BYTE MORE. React's `cache()` lifetime is
// exactly one server request. Here that scope is opened around each `Dashboard()`
// call by `renderDashboard` below and closed when it settles; outside it this
// wrapper calls straight through, which is also what production does outside a
// request (scripts/seed.ts, the notify sidecar). That matters in both directions:
// persona seeding runs between renders and must not read through another persona's
// memo, and a memo that outlived a render would UNDERSTATE the budget — the wrong
// direction for a meter, because it hides queries someone is really paying for.
//
// THE KEYING IS REACT'S KEYING. React memoizes on the positional arguments by
// identity, so this walks a Map trie of the argument list rather than serializing a
// key. Two structurally equal but distinct objects miss in React and miss here; a
// serialized key would have hit, memoized harder than production, and understated.
// FAITHFUL EXCEPT IN THE SAFE DIRECTION, DELIBERATELY. Exactness against a canary
// React this tier cannot import is not on offer, so what is guaranteed instead is
// the DIRECTION of every deviation: this mock may count HIGH but never low. A meter
// that cannot under-report is the only property a budget actually needs. Errors are
// the live example — React caches a throw for the request and this does not, so a
// re-thrown read would count twice here and once in production. Do not "fix" that
// toward exactness: memoizing throws moves the deviation to the unsafe side, and a
// read that throws fails the render outright anyway, so there is nothing to buy.
//
// A single module-level slot rather than AsyncLocalStorage, for the same reason
// `lib/tick-cache.ts` uses one: the loop below awaits one render at a time.
const requestCache = vi.hoisted(() => {
  interface MemoNode {
    children: Map<unknown, MemoNode>;
    filled: boolean;
    value: unknown;
  }
  const node = (): MemoNode => ({
    children: new Map(),
    filled: false,
    value: undefined,
  });
  const childOf = (parent: MemoNode, key: unknown): MemoNode => {
    const existing = parent.children.get(key);
    if (existing) return existing;
    const created = node();
    parent.children.set(key, created);
    return created;
  };
  let open: Map<symbol, MemoNode> | null = null;
  return {
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
      const identity = Symbol(fn.name || "cached");
      return (...args: A): R => {
        const scope = open;
        if (!scope) return fn(...args);
        let root: MemoNode | undefined = scope.get(identity);
        if (!root) {
          root = node();
          scope.set(identity, root);
        }
        let current: MemoNode = root;
        for (const arg of args) current = childOf(current, arg);
        if (current.filled) return current.value as R;
        const value = fn(...args);
        current.filled = true;
        current.value = value;
        return value;
      };
    },
    /** Run `fn` with one request's worth of memoization open. */
    async during<T>(fn: () => Promise<T>): Promise<T> {
      open = new Map();
      try {
        return await fn();
      } finally {
        open = null;
      }
    },
  };
});

vi.mock("@/lib/request-cache", () => ({ cache: requestCache.cache }));

vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireSession: async () => {
      if (!session.profile) throw new Error("dashboard test session not set");
      return {
        login: {
          id: session.loginId,
          username: "dashboard-test",
          role: "admin",
        },
        profile: session.profile,
        access: "write" as const,
        deviceSessionKey: "dashboard-test-device",
      };
    },
    getAccessibleProfiles: async () => session.accessible,
    ownProfileForLogin: () => session.profile?.id ?? null,
  };
});

vi.mock("@/lib/scope", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/scope")>();
  return {
    ...actual,
    requireScope: async () => {
      if (!session.profile) throw new Error("dashboard test scope not set");
      const ids = authorizedProfileSubset(
        accessibleProfileIdsForLogin(session.loginId),
        session.accessible.map((profile) => profile.id)
      );
      return {
        loginId: session.loginId,
        role: "admin" as const,
        actingProfileId: session.profile.id,
        ownProfileId: session.profile.id,
        profiles: session.accessible,
        ids,
        viewIds: authorizedProfileSubset(ids, [session.profile.id]),
        access: new Map(ids.map((id) => [id, "write" as const])),
      };
    },
  };
});

vi.mock("@/lib/ai-log", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ai-log")>();
  return { ...actual, withAiLogContext: () => undefined };
});

vi.mock("@/lib/recommendation-engine", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/recommendation-engine")>();
  return { ...actual, runRecommendation: () => undefined };
});

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

function allProfileIds(): number[] {
  return (
    db.prepare("SELECT id FROM profiles ORDER BY id").all() as { id: number }[]
  ).map((row) => row.id);
}

function profiles(ids: readonly number[]): SessionProfile[] {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, name, photo_path, photo_version FROM profiles
       WHERE id IN (${marks}) ORDER BY id`
    )
    .all(...ids) as SessionProfile[];
}

function installStatementTrace() {
  const executed: string[] = [];
  const realPrepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const statement = realPrepare(sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (
          typeof value === "function" &&
          ["get", "all", "run", "iterate"].includes(String(property))
        ) {
          return (...args: unknown[]) => {
            executed.push(sql.replace(/\s+/g, " ").trim());
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.prepare);
  return { clear: () => executed.splice(0), count: () => executed.length };
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
    const trace = installStatementTrace();
    const { default: Dashboard } = await import("../../app/(app)/page");
    // One call = one request, so one request-cache scope. Everything outside this
    // helper — persona seeding above all — runs unmemoized, exactly as production
    // does outside a request.
    // The page's root element is its declared-width wrapper (#3253), and the canvas
    // is the child inside it. Unwrapped HERE rather than asserted around, so this
    // tier keeps reading the manifest off the canvas' own props — the width is
    // presentation, and a presentation change must not be able to make the placement
    // meter stop measuring.
    const renderDashboard = async () => {
      const page = (await requestCache.during(
        async () => await Dashboard()
      )) as ReactElement<{ children: ReactElement }>;
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
      personaProfileIds.set(persona.name, profileId);
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

  it("orders real safety, three illness groups, then the live workout", () => {
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
    expect(Math.max(...illnesses.map((id) => now.indexOf(id)))).toBeLessThan(
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
  const QUERY_BASELINE: Record<string, number> = {
    // −3 each (#4228 A): the recap's adherence walk stops before today, so no
    // persona makes today's three per-day reads any more — the day's activities,
    // its taken set and its skipped set. `household` is unmoved because its acting
    // profile has no active intake items, so `windowAdherence` returns before the
    // walk and never made them; measured by instrumenting the walk and rendering
    // all six personas, which reported five walking one day fewer and household
    // short-circuiting.
    // +1 on EVERY persona (#4767 item 2), MEASURED ON THE MERGED TREE and not
    // reconciled by arithmetic against the pre-merge numbers: the Today band's
    // intraday chart asks for the profile's latest worn HR day before anything
    // else, and none of these six has one on today, so all six pay exactly that
    // one indexed read and stop. The gate doing its job — a profile that DOES
    // have today's minutes pays the day gather too, which is the cost of DRAWING
    // the chart rather than of asking whether to. The +1 is the same on both
    // sides of the #4228 A walk change above, so the two do not interact.
    bodybuilder: 224,
    "marathon-runner": 223,
    household: 270,
    pregnant: 220,
    "diabetic-cgm": 231,
    // +9 (#4424 ruling 7): Upcoming's practice rows mount the shared row control, so
    // the row now resolves what that control renders — `getTrackedPractices`, which is
    // one grouped today-tally and one live sweep however many practices there are,
    // plus the usual-duration vote per practice. Assembling the same four fields
    // per-target instead measured +13.
    biohacker: 246,
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
  //   household 270 (the heaviest baseline) + 20 headroom = 290
  //
  // RE-DERIVED, NOT LEFT BEHIND (#3410/#3316/#3100). The line above read
  // "267 + 23 = 290" after the household baseline moved to 270, which is the one
  // arithmetic this comment cannot afford to get wrong: the whole subject here is
  // that these numbers are honest. The CEILING did not move — only the split of it
  // into "what a render costs" and "what is left".
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
  const QUERY_CEILING = 290;

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
});
