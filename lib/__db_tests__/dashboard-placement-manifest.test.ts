// DB INTEGRATION TIER — #3080's acceptance evidence against the real dashboard
// gather. Each SeedPersona is applied to the migrated schema, the actual async
// page function runs under a scoped session, and the ranked placements passed to
// the sole canvas are captured. This is deliberately not a second surface model.

import type { ReactElement } from "react";
import crypto from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { utcInstant } from "@/lib/date";
import { zonedWallTimeToUtc } from "@/lib/calendar-ics";
import { reconcileFlags } from "@/lib/queries";
import { saveFitnessEntry } from "@/lib/fitness-assessment";
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
import { shiftDateStr } from "@/lib/date";
import { PERSONAS, type PersonaContext } from "../../scripts/seed-personas";
import type { SessionProfile } from "@/lib/auth";
import type { DashboardPlacement } from "@/lib/dashboard-relevance";
import DashboardPlacementCanvas, {
  type DashboardPlacementCanvasProps,
} from "@/components/dashboard/DashboardPlacementCanvas";

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
            layoutReviewed: true,
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

const normalizeSql = (sql: string) => sql.replace(/\s+/g, " ").trim();

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
            executed.push(normalizeSql(sql));
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.prepare);
  return {
    clear: () => executed.splice(0),
    statements: () => [...executed],
  };
}

function compactManifest(placements: readonly DashboardPlacement[]): string[] {
  return placements.map((placement) =>
    [
      placement.placementId,
      placement.zone,
      placement.visibility,
      placement.groupKey ?? "-",
    ].join(":")
  );
}

const manifests = new Map<string, string[]>();
const statementRuns = new Map<string, string[]>();

const EXPECTED_PERSONA_MANIFESTS: Record<string, readonly string[]> = {
  bodybuilder: [
    "illness-hero:priority:hidden:priority",
    "needs-attention:priority:visible:priority",
    "nutrition-today:now:visible:-",
    "recently-resolved:pre-grid:hidden:-",
    "stream-lifecycle-offers:pre-grid:hidden:-",
    "session-recap:pre-grid:hidden:-",
    "onboarding-resume:pre-grid:hidden:-",
    "onboarding-checklist:pre-grid:hidden:-",
    "household-strip:pre-grid:hidden:-",
    "symptom-log:grid:visible:-",
    "coaching:grid:visible:-",
    "goals-habits:grid:visible:-",
    "active-protocols:grid:hidden:-",
    "data-quality:grid:visible:-",
    "steps-today:grid:visible:-",
    "vitals-latest:grid:visible:-",
    "next-appointment:grid:unavailable:-",
    "recent-labs:grid:visible:-",
    "sleep-last-night:grid:visible:-",
    "naps-today:grid:unavailable:-",
    "weight-trend:grid:visible:-",
    "healthspan-pillars:grid:visible:-",
    "coaching-observations:grid:visible:-",
    "weekly-recap:grid:hidden:-",
  ],
  "marathon-runner": [
    "illness-hero:priority:hidden:priority",
    "needs-attention:priority:visible:priority",
    "recently-resolved:pre-grid:hidden:-",
    "stream-lifecycle-offers:pre-grid:hidden:-",
    "session-recap:pre-grid:hidden:-",
    "onboarding-resume:pre-grid:hidden:-",
    "onboarding-checklist:pre-grid:hidden:-",
    "household-strip:pre-grid:hidden:-",
    "symptom-log:grid:visible:-",
    "coaching:grid:visible:-",
    "goals-habits:grid:visible:-",
    "active-protocols:grid:hidden:-",
    "data-quality:grid:visible:-",
    "nutrition-today:grid:visible:-",
    "steps-today:grid:visible:-",
    "vitals-latest:grid:visible:-",
    "cycle-phase:grid:visible:-",
    "next-appointment:grid:unavailable:-",
    "recent-labs:grid:visible:-",
    "sleep-last-night:grid:visible:-",
    "naps-today:grid:unavailable:-",
    "weight-trend:grid:visible:-",
    "healthspan-pillars:grid:visible:-",
    "coaching-observations:grid:visible:-",
    "weekly-recap:grid:hidden:-",
  ],
  household: [
    "illness-hero:priority:visible:priority",
    "needs-attention:priority:visible:priority",
    "recently-resolved:pre-grid:hidden:-",
    "stream-lifecycle-offers:pre-grid:hidden:-",
    "session-recap:pre-grid:hidden:-",
    "onboarding-resume:pre-grid:hidden:-",
    "onboarding-checklist:pre-grid:hidden:-",
    "household-strip:pre-grid:visible:-",
    "symptom-log:grid:visible:-",
    "coaching:grid:visible:-",
    "goals-habits:grid:visible:-",
    "active-protocols:grid:hidden:-",
    "data-quality:grid:visible:-",
    "nutrition-today:grid:visible:-",
    "steps-today:grid:visible:-",
    "vitals-latest:grid:visible:-",
    "next-appointment:grid:visible:-",
    "recent-labs:grid:visible:-",
    "sleep-last-night:grid:visible:-",
    "naps-today:grid:unavailable:-",
    "weight-trend:grid:visible:-",
    "healthspan-pillars:grid:visible:-",
    "coaching-observations:grid:visible:-",
    "weekly-recap:grid:hidden:-",
  ],
  pregnant: [
    "illness-hero:priority:hidden:priority",
    "needs-attention:priority:visible:priority",
    "recently-resolved:pre-grid:hidden:-",
    "stream-lifecycle-offers:pre-grid:hidden:-",
    "session-recap:pre-grid:hidden:-",
    "onboarding-resume:pre-grid:hidden:-",
    "onboarding-checklist:pre-grid:hidden:-",
    "household-strip:pre-grid:visible:-",
    "symptom-log:grid:visible:-",
    "coaching:grid:visible:-",
    "goals-habits:grid:visible:-",
    "active-protocols:grid:hidden:-",
    "data-quality:grid:visible:-",
    "nutrition-today:grid:visible:-",
    "steps-today:grid:visible:-",
    "vitals-latest:grid:visible:-",
    "cycle-phase:grid:visible:-",
    "next-appointment:grid:visible:-",
    "recent-labs:grid:visible:-",
    "sleep-last-night:grid:visible:-",
    "naps-today:grid:unavailable:-",
    "weight-trend:grid:visible:-",
    "healthspan-pillars:grid:visible:-",
    "coaching-observations:grid:visible:-",
    "weekly-recap:grid:hidden:-",
  ],
  "diabetic-cgm": [
    "illness-hero:priority:hidden:priority",
    "needs-attention:priority:visible:priority",
    "recently-resolved:pre-grid:hidden:-",
    "stream-lifecycle-offers:pre-grid:hidden:-",
    "session-recap:pre-grid:hidden:-",
    "onboarding-resume:pre-grid:hidden:-",
    "onboarding-checklist:pre-grid:hidden:-",
    "household-strip:pre-grid:visible:-",
    "symptom-log:grid:visible:-",
    "coaching:grid:visible:-",
    "goals-habits:grid:visible:-",
    "active-protocols:grid:hidden:-",
    "data-quality:grid:visible:-",
    "nutrition-today:grid:visible:-",
    "steps-today:grid:visible:-",
    "vitals-latest:grid:visible:-",
    "next-appointment:grid:visible:-",
    "recent-labs:grid:visible:-",
    "sleep-last-night:grid:visible:-",
    "naps-today:grid:unavailable:-",
    "weight-trend:grid:visible:-",
    "healthspan-pillars:grid:visible:-",
    "coaching-observations:grid:visible:-",
    "weekly-recap:grid:hidden:-",
  ],
  biohacker: [
    "illness-hero:priority:hidden:priority",
    "needs-attention:priority:visible:priority",
    "recently-resolved:pre-grid:hidden:-",
    "stream-lifecycle-offers:pre-grid:hidden:-",
    "session-recap:pre-grid:hidden:-",
    "onboarding-resume:pre-grid:hidden:-",
    "onboarding-checklist:pre-grid:hidden:-",
    "household-strip:pre-grid:hidden:-",
    "symptom-log:grid:visible:-",
    "coaching:grid:visible:-",
    "goals-habits:grid:visible:-",
    "active-protocols:grid:hidden:-",
    "data-quality:grid:visible:-",
    "nutrition-today:grid:visible:-",
    "steps-today:grid:visible:-",
    "vitals-latest:grid:visible:-",
    "next-appointment:grid:unavailable:-",
    "recent-labs:grid:visible:-",
    "sleep-last-night:grid:visible:-",
    "naps-today:grid:unavailable:-",
    "weight-trend:grid:visible:-",
    "healthspan-pillars:grid:visible:-",
    "coaching-observations:grid:visible:-",
    "weekly-recap:grid:hidden:-",
  ],
};

describe("actual dashboard placement manifests", () => {
  beforeAll(async () => {
    process.env.ALLOS_TEST_NOW = "2026-08-18T13:00:00.000Z";
    session.loginId = (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as { id: number }
    ).id;
    const trace = installStatementTrace();
    const { default: Dashboard } = await import("../../app/(app)/page");

    for (const persona of PERSONAS) {
      const before = new Set(allProfileIds());
      const profileId = newProfile(`dashboard:${persona.name}`);
      persona.apply(ctxFor(profileId));
      const createdIds = allProfileIds().filter((id) => !before.has(id));
      session.accessible = profiles(createdIds);
      session.profile = session.accessible.find((p) => p.id === profileId)!;

      trace.clear();
      const element =
        (await Dashboard()) as ReactElement<DashboardPlacementCanvasProps>;
      expect(element.type).toBe(DashboardPlacementCanvas);
      manifests.set(persona.name, compactManifest(element.props.placements));
      statementRuns.set(persona.name, trace.statements());
    }
  }, 120_000);

  for (const persona of PERSONAS) {
    it(`${persona.name}: captures the actual page manifest`, () => {
      const manifest = manifests.get(persona.name)!;
      expect(manifest).toEqual(EXPECTED_PERSONA_MANIFESTS[persona.name]);
    });
  }

  it("pins the real gather's query count and statement set", () => {
    const statements = statementRuns.get("bodybuilder")!;
    const statementSet = [...new Set(statements)].sort();
    expect(statements).toHaveLength(761);
    expect(statementSet).toHaveLength(137);
    // The digest pins every normalized SQL statement, not only the cardinality.
    // A changed statement with the same count therefore still fails the budget.
    expect(
      crypto
        .createHash("sha256")
        .update(JSON.stringify(statementSet))
        .digest("hex")
    ).toBe("b61855e73293fe61414ad24e648c1903a1c44d6d5302dd097794605b70ed79bf");
  });
});
