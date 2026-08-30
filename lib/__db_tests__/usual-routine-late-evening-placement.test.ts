// DB INTEGRATION TIER — issue #3265, at the SURFACE: the dashboard placed the composed
// one-tap in a window it had already left.
//
// lib/__db_tests__/usual-routine-window.test.ts pins the two windows against each other.
// This file asks the only question that binds `app/(app)/page.tsx` itself: at 22:30 local,
// does the candidate reach a lane? It renders the real dashboard and reads the placement
// manifest off `DashboardPlacementCanvas`' own props, the same way the #3096 census does.
//
// It exists because a composed unit test cannot see a revert. Put
// `mealTimeWindows(nowMealAnchors)` back on the usual-routine candidate and every
// assertion about windows still passes, because nothing about the page's own wiring was
// ever asserted — the candidate is simply dropped, silently, before any lane is built.
// This test reds on exactly that.
//
// The 22:30 pin is the whole fixture: inside a meal window the two windows agree, which is
// why the defect stood. A midday render cannot see it.
//
// Fixtures are synthetic throwaway rows (per-file temp DB via setup.ts). No PHI.

import type { ReactElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { accessibleProfileIdsForLogin, type SessionProfile } from "@/lib/auth";
import { authorizedProfileSubset } from "@/lib/cross-profile";
import PageContainer from "../../components/PageContainer";
import { LoggedViaSurface } from "@/components/LoggedViaSurface";
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
          username: "routine-window-test",
          role: "admin",
        },
        profile: session.profile,
        access: "write" as const,
        deviceSessionKey: "routine-window-device",
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

// 22:30 local for a UTC profile: past the 21:00 close of the last meal-reminder window,
// with ninety minutes of the Evening FOOD window still to run.
const LATE_EVENING = "2026-08-19T22:30:00.000Z";
const previousTestNow = process.env.ALLOS_TEST_NOW;

function tap(profileId: number, group: string, date: string, hhmmss: string) {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, group, date, `${date}T${hhmmss}Z`);
}

let placements: DashboardPlacementCanvasProps["placements"] = [];

describe("the composed one-tap at 22:30 reaches the dashboard (#3265)", () => {
  beforeAll(async () => {
    process.env.ALLOS_TEST_NOW = LATE_EVENING;
    session.loginId = (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as { id: number }
    ).id;
    const profileId = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES (?)")
        .run("routine-late-evening").lastInsertRowid
    );
    setTimezone(profileId, "UTC");
    // Twelve evenings of the same two groups, today deliberately empty, so the offer
    // stands on arrival exactly as the e2e fixture's does.
    const anchor = today(profileId);
    for (let d = 1; d <= 12; d++) {
      const date = shiftDateStr(anchor, -d);
      tap(profileId, "fermented", date, "19:00:00");
      tap(profileId, "berries", date, "19:05:00");
    }
    session.accessible = db
      .prepare(
        `SELECT id, name, photo_path, photo_version FROM profiles WHERE id = ?`
      )
      .all(profileId) as SessionProfile[];
    session.profile = session.accessible[0];

    const { default: Dashboard } = await import("../../app/(app)/page");
    const page = (await Dashboard()) as ReactElement<{
      children: ReactElement;
    }>;
    expect(page.type).toBe(PageContainer);
    const surface = page.props.children as ReactElement<{
      value: string;
      children: ReactElement;
    }>;
    expect(surface.type).toBe(LoggedViaSurface);
    const canvas = surface.props
      .children as ReactElement<DashboardPlacementCanvasProps>;
    expect(canvas.type).toBe(DashboardPlacementCanvas);
    placements = canvas.props.placements;
  }, 120_000);

  afterAll(() => {
    if (previousTestNow === undefined) delete process.env.ALLOS_TEST_NOW;
    else process.env.ALLOS_TEST_NOW = previousTestNow;
  });

  it("places the Evening usual-routine candidate rather than dropping it", () => {
    const routine = placements.find((placement) =>
      placement.candidate.candidateId.startsWith("nutrition.usual-routine:")
    );
    // Under the meal-window timing this find returns undefined: `expired` candidates are
    // removed before any lane is built, so the offer is absent rather than demoted.
    expect(routine).toBeDefined();
    expect(routine?.candidate.candidateId).toBe(
      "nutrition.usual-routine:Evening"
    );
    expect(routine?.timingDisposition).toEqual({ kind: "active" });
  });
});
