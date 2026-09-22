// DB INTEGRATION TIER — Home's record reads in the History day view's order (#6010),
// and states a habitual meal window that closed empty (#6011).
//
// It renders the real Home and reads the rows it hands `HistoryRows`, the way the
// #6013 placement test reads its seated rows. The gather pushes rows kind by kind, so
// a Home that skipped `mergeMemberTimelines` lists the practice before the drink and
// the workout last, and this reds.
//
// Fixtures are synthetic throwaway rows (per-file temp DB via setup.ts). No PHI.

import type { ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { logSubstanceUnitCore } from "@/lib/substance-log-write";
import { accessibleProfileIdsForLogin, type SessionProfile } from "@/lib/auth";
import { authorizedProfileSubset } from "@/lib/cross-profile";
import { resolveAsyncTree } from "@/lib/__db_tests__/dashboard-render-harness";

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
        login: { id: session.loginId, username: "day-order", role: "admin" },
        profile: session.profile,
        access: "write" as const,
        deviceSessionKey: "day-order-device",
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

const RENDER_AT = "2026-08-19T21:00:00.000Z";

/** The ids of the rows Home handed its record, in order, and the gap door's windows. */
async function renderRecord() {
  const { default: Dashboard } = await import("../../app/(app)/page");
  const resolved = await resolveAsyncTree((await Dashboard()) as ReactElement);
  const record = resolved.elements.find(
    (props) => "selectionSubjectId" in props && "foodGaps" in props
  ) as { rows: { id: string }[]; foodGaps: { id: string; window: string }[] };
  return {
    ids: record.rows.map((row) => row.id),
    gaps: record.foodGaps.map((gap) => [gap.id, gap.window]),
  };
}

let profileId = 0;

describe("Home's record (#6010, #6011)", () => {
  beforeEach(() => vi.setSystemTime(new Date(RENDER_AT)));
  beforeAll(async () => {
    session.loginId = (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as { id: number }
    ).id;
    profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('day order')").run()
        .lastInsertRowid
    );
    setTimezone(profileId, "UTC");
    session.accessible = db
      .prepare(
        "SELECT id, name, photo_path, photo_version FROM profiles WHERE id = ?"
      )
      .all(profileId) as SessionProfile[];
    session.profile = session.accessible[0];

    // The drink is tapped at 20:35; everything else states its own clock.
    vi.setSystemTime(new Date("2026-08-19T20:35:00.000Z"));
    const on = today(profileId);
    logSubstanceUnitCore(profileId, "nicotine", on, "page");
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, start_time, duration_min)
       VALUES (?, 'Red light therapy', ?, '10:01', 10)`
    ).run(profileId, on);
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, start_time, duration_min)
       VALUES (?, ?, 'strength', 'Morning Legs Workout', '10:50', 45)`
    ).run(profileId, on);
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, occurred_at)
       VALUES (?, ?, 70.5, ?)`
    ).run(profileId, on, `${on}T06:22:00.000Z`);
    // Twelve mornings of breakfast and nothing today: Morning is habitual and closed
    // at 11:00. Midday is closed too, but never logged, so it is not a gap.
    for (let d = 1; d <= 12; d++) {
      const date = shiftDateStr(on, -d);
      db.prepare(
        `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
         VALUES (?, 'berries', ?, ?)`
      ).run(profileId, date, `${date}T08:00:00.000Z`);
    }
    vi.setSystemTime(new Date(RENDER_AT));
  }, 120_000);

  it("lists the day newest first, with the closed-empty Morning at its close", async () => {
    const { ids, gaps } = await renderRecord();
    expect(ids).toEqual([
      "substance:nicotine:1", // 20:35
      "food-gap:Morning", // closed 11:00
      "feed:activity:1", // 10:50
      "practice:1", // 10:01
      "body:weight_kg:1", // 06:22
    ]);
    expect(gaps).toEqual([["food-gap:Morning", "Morning"]]);
  });

  it("drops the gap row once a Morning serving is logged", async () => {
    const on = today(profileId);
    db.prepare(
      `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at, meal_slot)
       VALUES (?, 'berries', ?, ?, 'Morning')`
    ).run(profileId, on, RENDER_AT);
    const { ids, gaps } = await renderRecord();
    expect(gaps).toEqual([]);
    expect(ids.some((id) => id.startsWith("food-gap:"))).toBe(false);
    expect(ids.some((id) => id.startsWith("food:"))).toBe(true);
  });
});
