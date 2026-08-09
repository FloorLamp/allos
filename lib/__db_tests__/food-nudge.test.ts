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
import { setProfileSetting, setUserBirthdate } from "@/lib/settings";
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
    expect(plainBody(msg!.body)).toContain("✅ Today: 🥬 Leafy greens ×4");
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
    expect(plainBody(msg!.body)).toContain("✅ Today: 🥬 Leafy greens ×4");
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

// ---- Ranking does not editorialize (#1980, reversing #1822 item 5) ----
//
// #1822 item 5 pushed CAPPED groups below every floor group on this keyboard, so a
// heavily-logged "🍷 Alcohol" could not take an above-the-fold button. #1980 reversed it
// by owner ruling: a group you log often is a group you need to log FAST, and demoting it
// made the app slower at capturing exactly the intake a cap exists to measure. Driven
// through the REAL gather, so the order is proved where the buttons are actually built.
describe("capped groups rank on frecency alone (#1980 reversal pin)", () => {
  let c: SeededProfile;
  let ct: string;

  beforeAll(() => {
    c = seedProfile("food-nudge-capped");
    ct = today(c.profileId);
    // Alcohol is the profile's single heaviest morning habit — it wins the frecency blend
    // outright, and nothing may take that away from it.
    for (let i = 0; i < 6; i++)
      logFoodServingCore(c.profileId, "alcohol", ct, `${ct}T08:0${i}:00Z`);
    logFoodServingCore(c.profileId, "berries", ct, `${ct}T08:30:00Z`);
  });

  it("the top-usage capped group LEADS the visible keyboard, count intact", () => {
    const msg = buildFoodNudge(c.profileId, "Morning", ct)!;
    const labels = (msg.actions ?? [])
      .filter((a) => a.data?.startsWith("food:"))
      .map((a) => a.label);
    expect(labels[0]).toBe("🍷 Alcohol (6)");
    expect(labels[1]).toBe("🫐 Berries (1)");
  });

  it("ranks the same way in EVERY slot — the tier is never consulted", () => {
    for (const window of ["Morning", "Midday", "Evening"] as const) {
      const msg = buildFoodNudge(c.profileId, window, ct)!;
      const labels = (msg.actions ?? [])
        .filter((a) => a.data?.startsWith("food:"))
        .map((a) => a.label);
      // The morning taps carry no slot count outside Morning, but the overall frecency
      // that put alcohol first is window-independent.
      expect(labels.some((l) => l.includes("Alcohol"))).toBe(true);
    }
  });

  it("the user's own exclusion still demotes it — the ONE thing that reorders", () => {
    // #975 is a choice the user made, not a verdict the app formed.
    setProfileSetting(
      c.profileId,
      "dietary_excluded_groups",
      JSON.stringify(["alcohol"])
    );
    try {
      const msg = buildFoodNudge(c.profileId, "Morning", ct)!;
      const labels = (msg.actions ?? [])
        .filter((a) => a.data?.startsWith("food:"))
        .map((a) => a.label);
      expect(labels.some((l) => l.includes("Alcohol"))).toBe(false);
      // Demoted, never filtered (#559): a wide-enough keyboard still reaches it.
      const wide = buildFoodNudge(c.profileId, "Morning", ct, 30)!;
      const alcohol = (wide.actions ?? []).find((a) =>
        a.data?.endsWith(":alcohol")
      );
      expect(alcohol?.label).toBe("🍷 Alcohol (6)");
    } finally {
      setProfileSetting(c.profileId, "dietary_excluded_groups", "[]");
    }
  });
});
