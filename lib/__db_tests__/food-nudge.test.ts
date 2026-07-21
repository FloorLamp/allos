// DB INTEGRATION TIER — the food-log nudge GATHER (issues #682, #1016) over a realistic
// fixture. buildFoodNudge is the gather half (DB reads → the pure renderer): it must lead
// with the profile's most-eaten groups (the SAME recency-decayed ranking the web log bar
// uses — one computation, #591), carry SLOT-scoped button counts (#1016) with a DAY-total
// tally labeled "Today:", and hide entirely for an infant profile (the life-stage gate). The
// pure render/token half is covered in lib/__tests__/food-nudge.test.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { setUserBirthdate } from "@/lib/settings";
import { logFoodServingCore } from "@/lib/food-log-write";
import { buildFoodNudge } from "@/lib/notifications/food";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;
let t: string;

beforeAll(() => {
  p = seedProfile("food-nudge");
  t = today(p.profileId);
  // Heavy recent leafy-greens habit at MORNING → it leads the buttons and shows a slot
  // count on the morning nudge; one morning fatty-fish log too. Default UTC tz + 11:00/15:00
  // boundaries → an 08:00Z tap is Morning. logFoodServingCore writes BOTH the food_log day
  // counter and the food_log_events ledger the slot count reads.
  for (let i = 0; i < 4; i++)
    logFoodServingCore(p.profileId, "leafy_greens", t, `${t}T08:0${i}:00Z`);
  logFoodServingCore(p.profileId, "fatty_fish", t, `${t}T08:30:00Z`);
});

describe("buildFoodNudge", () => {
  it("leads with the most-eaten group and carries SLOT counts + a DAY tally (#1016)", () => {
    const msg = buildFoodNudge(p.profileId, "Morning", t);
    expect(msg).not.toBeNull();
    const logButtons = (msg!.actions ?? []).filter((a) =>
      a.data?.startsWith("food:")
    );
    // First button is the heavily-logged group, carrying its MORNING-slot count (4).
    expect(logButtons[0].label).toBe("Leafy greens (4)");
    expect(logButtons[0].data).toBe(
      `food:${p.profileId}:Morning:${t}:leafy_greens`
    );
    // The tally line is the DAY total, labeled.
    expect(msg!.body).toContain("✓ Today: Leafy greens ×4");
    expect(msg!.body).toContain("Fatty fish ×1");
    expect(msg!.kind).toBe("food");
  });

  it("shows a CLEAN button (no slot count) on a different slot's nudge (#1016)", () => {
    // Everything was logged in the morning, so the Midday nudge's buttons carry no slot
    // count — but the DAY tally still shows the morning's servings.
    const msg = buildFoodNudge(p.profileId, "Midday", t);
    const leafy = (msg!.actions ?? []).find((a) =>
      a.data?.endsWith(":leafy_greens")
    );
    expect(leafy?.label).toBe("Leafy greens"); // clean at midday — no "(4)"
    expect(msg!.body).toContain("✓ Today: Leafy greens ×4"); // day total persists
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
