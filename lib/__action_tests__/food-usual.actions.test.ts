// SERVER-ACTION TIER — the "log my usual <window>" offer (issue #2380).
//
// The invariant this tier exists to pin is the one that keeps a regularity-derived
// shortcut honest: THE FORM IS AN UPPER BOUND, NEVER AN INSTRUCTION. The action
// validates shape; the auth-blind core re-derives the offer from fresh server state and
// writes only the intersection, so a forged, replayed or merely stale submission can
// never write outside the offer that currently stands — and never on a day the user is
// not living. Also proves the read-access refusal and the authoritative counts the bar
// adopts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { logUsualFood } from "@/app/(app)/nutrition/actions";
import { getUsualFoodOffer } from "@/lib/queries";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function servings(profileId: number) {
  return db
    .prepare(
      `SELECT date, group_key, servings FROM food_log
        WHERE profile_id = ? ORDER BY date, group_key`
    )
    .all(profileId) as { date: string; group_key: string; servings: number }[];
}

function tap(profileId: number, group: string, date: string, hhmmss: string) {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key)
       DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, logged_at)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, group, date, `${date}T${hhmmss}Z`);
}

// A profile whose last twelve mornings each hold fermented + berries, and nothing
// logged today — the #2380 ledger shape, in miniature.
function seedUsualMorning(name: string) {
  const login = createLogin();
  const profile = createProfile(name, login.id);
  actAs(login, profile);
  setTimezone(profile.id, "UTC");
  const anchor = today(profile.id);
  for (let d = 1; d <= 12; d++) {
    const date = shiftDateStr(anchor, -d);
    tap(profile.id, "fermented", date, "08:00:00");
    tap(profile.id, "berries", date, "08:05:00");
  }
  return { login, profile, anchor };
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("logUsualFood", () => {
  it("logs one serving of each offered group into the window, on today", async () => {
    const { profile, anchor } = seedUsualMorning("usual-happy");
    const res = await logUsualFood(
      fd({ meal_slot: "Morning", groups: "berries,fermented" })
    );

    expect(res).toEqual({
      ok: true,
      window: "Morning",
      groups: [
        { groupKey: "berries", servings: 1, mealServings: 1 },
        { groupKey: "fermented", servings: 1, mealServings: 1 },
      ],
    });
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([
      { date: anchor, group_key: "berries", servings: 1 },
      { date: anchor, group_key: "fermented", servings: 1 },
    ]);
    // The window is a DECLARATION, and no eating time is invented (#2269).
    const written = db
      .prepare(
        `SELECT meal_slot, eaten_at FROM food_log_events
          WHERE profile_id = ? AND date = ?`
      )
      .all(profile.id, anchor) as {
      meal_slot: string | null;
      eaten_at: string | null;
    }[];
    expect(written).toHaveLength(2);
    expect(written.every((r) => r.meal_slot === "Morning")).toBe(true);
    expect(written.every((r) => r.eaten_at === null)).toBe(true);
    expect(revalidate).toHaveBeenCalledWith("/nutrition");
  });

  it("refuses a second tap rather than logging a second breakfast", async () => {
    const { profile, anchor } = seedUsualMorning("usual-repeat");
    await logUsualFood(
      fd({ meal_slot: "Morning", groups: "berries,fermented" })
    );
    const again = await logUsualFood(
      fd({ meal_slot: "Morning", groups: "berries,fermented" })
    );

    expect(again.ok).toBe(false);
    // Still one serving each — the offer is gone, so there is nothing to re-log.
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([
      { date: anchor, group_key: "berries", servings: 1 },
      { date: anchor, group_key: "fermented", servings: 1 },
    ]);
    expect(getUsualFoodOffer(profile.id, "Morning", anchor)).toEqual([]);
  });

  it("writes only the intersection with the standing offer — a forged list lands nothing extra", async () => {
    const { profile, anchor } = seedUsualMorning("usual-forged");
    const res = await logUsualFood(
      fd({
        meal_slot: "Morning",
        // Two groups that ARE offered, plus three that are not — a habitual group of
        // another window, a group with no history at all, and a nonsense slug.
        groups: "berries,fermented,alcohol,red_meat,not_a_group",
      })
    );

    expect(res.ok && res.groups.map((g) => g.groupKey)).toEqual([
      "berries",
      "fermented",
    ]);
    expect(
      servings(profile.id)
        .filter((r) => r.date === anchor)
        .map((r) => r.group_key)
    ).toEqual(["berries", "fermented"]);
  });

  it("refuses when nothing in the submitted list is still offered", async () => {
    const { profile, anchor } = seedUsualMorning("usual-stale");
    const res = await logUsualFood(
      fd({ meal_slot: "Morning", groups: "red_meat,alcohol" })
    );
    expect(res.ok).toBe(false);
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([]);
  });

  it("refuses a window with no habit", async () => {
    const { profile, anchor } = seedUsualMorning("usual-cold-window");
    const res = await logUsualFood(
      fd({ meal_slot: "Evening", groups: "berries,fermented" })
    );
    expect(res.ok).toBe(false);
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([]);
  });

  it("rejects a bad window and an empty group list without touching the ledger", async () => {
    const { profile, anchor } = seedUsualMorning("usual-shape");
    expect(
      (await logUsualFood(fd({ meal_slot: "Brunch", groups: "berries" }))).ok
    ).toBe(false);
    expect(
      (await logUsualFood(fd({ meal_slot: "Morning", groups: "  " }))).ok
    ).toBe(false);
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([]);
  });

  it("refuses a read-only grant", async () => {
    const { login, profile, anchor } = seedUsualMorning("usual-readonly");
    actAs(login, profile, "read");
    await expect(
      logUsualFood(fd({ meal_slot: "Morning", groups: "berries,fermented" }))
    ).rejects.toThrow();
    expect(servings(profile.id).filter((r) => r.date === anchor)).toEqual([]);
  });

  it("writes only to the acting profile", async () => {
    const { profile } = seedUsualMorning("usual-scope-a");
    const otherLogin = createLogin();
    const other = createProfile("usual-scope-b", otherLogin.id);
    await logUsualFood(
      fd({ meal_slot: "Morning", groups: "berries,fermented" })
    );
    expect(servings(other.id)).toEqual([]);
    expect(servings(profile.id).length).toBeGreaterThan(0);
  });
});
