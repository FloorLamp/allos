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
      const element =
        (await Dashboard()) as ReactElement<DashboardPlacementCanvasProps>;
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
        const switchedElement =
          (await Dashboard()) as ReactElement<DashboardPlacementCanvasProps>;
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

  it("does not exceed the phase-5 interactive-cockpit query budget", () => {
    for (const [persona, count] of queryCounts) {
      // Phase 5 restores the real symptom, temperature, medication, and episode
      // controls. Their reads are batched once per sick profile; the integrated
      // household fixture deliberately has three sick profiles, while the separate
      // multi-episode pin proves episode cardinality does not increase them.
      expect(count, persona).toBeLessThanOrEqual(535);
    }
  });
});
