// DB INTEGRATION TIER — the food-log nudge GATHER (issue #682) over a realistic
// fixture. buildFoodNudge is the gather half (DB reads → the pure renderer): it must
// lead with the profile's most-eaten groups (the SAME recency-decayed ranking the
// web log bar uses — one computation, #591), carry today's serving counts, and hide
// entirely for an infant profile (the life-stage gate). The pure render/token half is
// covered in lib/__tests__/food-nudge.test.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { setUserBirthdate } from "@/lib/settings";
import { buildFoodNudge } from "@/lib/notifications/food";
import { seedProfile, type SeededProfile } from "./fixtures";

function logFood(profileId: number, date: string, group: string, n: number) {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)`
  ).run(profileId, date, group, n);
}

let p: SeededProfile;
let t: string;

beforeAll(() => {
  p = seedProfile("food-nudge");
  t = today(p.profileId);
  // Heavy recent leafy-greens habit → it should lead the buttons; a light fatty-fish
  // log on today so the tally + per-button count render.
  logFood(p.profileId, t, "leafy_greens", 4);
  logFood(p.profileId, t, "fatty_fish", 1);
});

describe("buildFoodNudge", () => {
  it("leads with the most-eaten group and carries today's counts", () => {
    const msg = buildFoodNudge(p.profileId, "Morning", t);
    expect(msg).not.toBeNull();
    const logButtons = (msg!.actions ?? []).filter((a) => a.data);
    // First button is the heavily-logged group, and it carries its running count.
    expect(logButtons[0].label).toBe("Leafy greens (4)");
    expect(logButtons[0].data).toContain("leafy_greens");
    // The token names the acting profile + window + today's date.
    expect(logButtons[0].data).toBe(
      `food:${p.profileId}:Morning:${t}:leafy_greens`
    );
    // The tally line reflects today's servings.
    expect(msg!.body).toContain("Leafy greens ×4");
    expect(msg!.body).toContain("Fatty fish ×1");
    expect(msg!.kind).toBe("food");
  });

  it("hides for an infant profile (life-stage gate)", () => {
    const infant = seedProfile("food-nudge-infant");
    // < 1 y old → food-group logging is hidden everywhere, nudge included.
    const bd = new Date(t);
    setUserBirthdate(
      infant.profileId,
      `${bd.getUTCFullYear()}-${String(bd.getUTCMonth() + 1).padStart(2, "0")}-01`
    );
    expect(buildFoodNudge(infant.profileId, "Morning", t)).toBeNull();
  });
});
