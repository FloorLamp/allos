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
import DashboardPlacementCanvas, {
  type DashboardPlacementCanvasProps,
} from "@/components/dashboard/DashboardPlacementCanvas";
import { STANDING_READING_ORDER } from "@/lib/dashboard-standing";

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
    saveFitnessEntry,
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
const standingPresentations = new Map<
  string,
  DashboardPlacementCanvasProps["standingPresentations"]
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
    const renderDashboard = () =>
      requestCache.during(
        async () =>
          (await Dashboard()) as ReactElement<DashboardPlacementCanvasProps>
      );

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
      standingPresentations.set(
        persona.name,
        element.props.standingPresentations
      );
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
  }, 120_000);

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
      const presentations = standingPresentations.get(persona)!;
      const standing = placements.filter(
        (placement) => placement.lane === "standing"
      );
      expect(
        standing.every(({ candidate }) =>
          presentations.has(candidate.candidateId)
        ),
        `${persona}:Standing presentation`
      ).toBe(true);
      const indices = standing.map((placement) =>
        familyIndex.get(placement.standingFamilyKey!)
      );
      expect(indices, persona).toEqual(indices.toSorted((a, b) => a! - b!));
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

  it("keeps sleep regularity only in its healthspan family", () => {
    for (const placements of manifests.values()) {
      expect(
        placements.some(({ candidate }) =>
          candidate.candidateId.startsWith("sleep.regularity:")
        )
      ).toBe(false);
      for (const placement of placements.filter(
        (
          placement
        ): placement is Extract<
          DashboardPlacementCanvasProps["placements"][number],
          { lane: "standing" }
        > =>
          placement.lane === "standing" &&
          placement.candidate.candidateId.includes("sleep-regularity")
      )) {
        expect(placement.standingFamilyKey).toBe("healthspan-pillars");
      }
    }
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
  const QUERY_BASELINE: Record<string, number> = {
    bodybuilder: 243,
    "marathon-runner": 240,
    household: 270,
    pregnant: 237,
    "diabetic-cgm": 248,
    biohacker: 258,
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
  //   household 267 (the heaviest baseline) + 23 headroom = 290
  //
  // WHAT THE HEADROOM IS FOR: one household-shaped addition landing without a
  // conversation. The integrated household fixture carries four profiles, so a new
  // per-profile dashboard read costs four statements there; 23 is about five such
  // reads, or one new gathering surface. Ordinary work pastes its refreshed baseline
  // and moves on; a change that needs more than a whole new surface's worth of
  // queries has to say so out loud.
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
