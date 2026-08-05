// DB INTEGRATION TIER — the food-log nudge GATHER (issues #682, #1016) over a realistic
// fixture. buildFoodNudge is the gather half (DB reads → the pure renderer): it must lead
// with the profile's most-eaten groups (the SAME recency-decayed ranking the web log bar
// uses — one computation, #591), carry DAY-total button counts (#1016's slot scoping was
// retired with the read-time window derivation it depended on, #2019) beside the "Today:"
// tally, and hide entirely for an infant profile (the life-stage gate). The
// pure render/token half is covered in lib/__tests__/food-nudge.test.ts.

import { plainBody } from "@/lib/notifications/rich-text";
import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { setUserBirthdate } from "@/lib/settings";
import { logFoodServingCore } from "@/lib/food-log-write";
import { buildFoodNudge } from "@/lib/notifications/food";
import { foodGroupName } from "@/lib/food-groups";
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
  it("leads with the most-eaten group and carries DAY counts + the DAY tally", () => {
    const msg = buildFoodNudge(p.profileId, "Morning", t);
    expect(msg).not.toBeNull();
    const logButtons = (msg!.actions ?? []).filter((a) =>
      a.data?.startsWith("food:")
    );
    // First button is the heavily-logged group, carrying its day count (4).
    expect(logButtons[0].label).toBe("🥬 Leafy greens (4)");
    expect(logButtons[0].data).toBe(
      `food:${p.profileId}:Morning:${t}:leafy_greens`
    );
    // The tally line is the DAY total, labeled.
    expect(plainBody(msg!.body)).toContain("✓ Today: 🥬 Leafy greens ×4");
    expect(plainBody(msg!.body)).toContain("Fatty fish ×1");
    expect(msg!.kind).toBe("food");
  });

  it("carries the SAME count on every window's nudge — the count is the day (#2019)", () => {
    // The suffix no longer means "in this window", so a morning habit reads 4 on the
    // midday nudge too. That is the point: the count agrees with the tally beside it and
    // never depends on re-deriving which meal a serving belonged to.
    const msg = buildFoodNudge(p.profileId, "Midday", t);
    const leafy = (msg!.actions ?? []).find((a) =>
      a.data?.endsWith(":leafy_greens")
    );
    // Labels lead with the group's catalog glyph since #1710.
    expect(leafy?.label).toBe("🥬 Leafy greens (4)");
    expect(plainBody(msg!.body)).toContain("✓ Today: 🥬 Leafy greens ×4");
  });

  it("still leads with the group eaten NEAR this window (#2019 proximity ranking)", () => {
    // The ORDER is what stayed slot-aware, and it did so without a bucket: the morning
    // habit leads the morning nudge because 08:00 sits on that window's anchor.
    const morning = (buildFoodNudge(p.profileId, "Morning", t)!.actions ?? [])
      .filter((a) => a.data?.startsWith("food:"))
      .map((a) => a.data!.split(":").at(-1));
    expect(morning[0]).toBe("leafy_greens");
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

// ---- Capped groups never take an above-the-fold button (issue #1822 item 5) ----
//
// The reported screenshot: "🍷 Alcohol" as a quick-log button in the 08:00 nudge, because
// ranking was usage-only. A positive-habits nudge was leading with an encouragement-shaped
// affordance for the thing being capped, ahead of the floor groups it exists to prompt.
// Driven through the REAL gather so the ordering is proved where the buttons are actually
// built, not only in the pure partition.
describe("capped groups rank below floor groups (#1822 item 5)", () => {
  let c: SeededProfile;
  let ct: string;

  beforeAll(() => {
    c = seedProfile("food-nudge-capped");
    ct = today(c.profileId);
    // Alcohol is the profile's single heaviest morning habit — it wins the frecency blend
    // outright, exactly the situation that produced the screenshot.
    for (let i = 0; i < 6; i++)
      logFoodServingCore(c.profileId, "alcohol", ct, `${ct}T08:0${i}:00Z`);
    logFoodServingCore(c.profileId, "berries", ct, `${ct}T08:30:00Z`);
  });

  it("keeps the top-usage capped group off the visible keyboard", () => {
    const msg = buildFoodNudge(c.profileId, "Morning", ct)!;
    const labels = (msg.actions ?? [])
      .filter((a) => a.data?.startsWith("food:"))
      .map((a) => a.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels[0]).toBe("🫐 Berries (1)"); // the floor group leads despite less usage
    expect(labels.some((l) => l.includes("Alcohol"))).toBe(false);
    // Every visible button is a floor group — no capped affordance above the fold.
    for (const slug of [
      "alcohol",
      "added_sugar",
      "fried_food",
      "sugary_drinks",
    ])
      expect(labels.some((l) => l.includes(foodGroupName(slug)))).toBe(false);
  });

  it("still REACHES it through 'Show more' — the cap needs the logging", () => {
    // Demoted, never filtered (#559): a wide-enough keyboard renders it, and its slot
    // count is intact, so logging what the cap exists to track is one tap away.
    const msg = buildFoodNudge(c.profileId, "Morning", ct, 30)!;
    const alcohol = (msg.actions ?? []).find((a) =>
      a.data?.endsWith(":alcohol")
    );
    expect(alcohol).toBeDefined();
    expect(alcohol!.label).toBe("🍷 Alcohol (6)");
  });

  it("fixes EVERY slot, not just the morning one", () => {
    for (const window of ["Morning", "Midday", "Evening"] as const) {
      const msg = buildFoodNudge(c.profileId, window, ct)!;
      const labels = (msg.actions ?? [])
        .filter((a) => a.data?.startsWith("food:"))
        .map((a) => a.label);
      expect(labels.some((l) => l.includes("Alcohol"))).toBe(false);
    }
  });
});
