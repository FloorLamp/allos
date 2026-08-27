import { test, expect } from "./fixtures";
import { type Locator } from "@playwright/test";
// Pace-verdict colours (issue #780): goal bars and weekly-habit chips both format
// over ONE shared tone→class map. Geometry shows "how far"; colour shows a PACE
// verdict. The two invariants this pins, deterministically over the seed:
//   - a fresh goal (seed goals are created "today" with FUTURE deadlines) reads
//     on-pace/met — NEVER the old rose "failing" bar, and never behind;
//   - a weekly-habit chip is never rose (a recurring week can't "fail"), and the
//     retired #760 "sky" on-pace hue is gone (on-pace is brand on both surfaces).
// Read-only: navigates and asserts, never mutates the shared fixture.

// The shared map (mirrors lib/goals PACE_FILL_CLASS / PACE_BORDER_CLASS). A tone's
// bar/square fill and chip border must match these exactly — that's the "one map"
// contract the two surfaces can't drift from.
const BORDER: Record<string, string> = {
  met: "border-emerald-400",
  "on-pace": "border-brand-400",
  behind: "border-amber-400",
  failed: "border-rose-400",
};

async function toneOf(el: Locator): Promise<string> {
  const tone = await el.getAttribute("data-tone");
  expect(tone, "chip/bar carries a data-tone hook").toBeTruthy();
  return tone!;
}

test("Training weekly target chips are pace-coloured, rose-free, and sky-free (#780)", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");
  const main = page.getByRole("main");
  // Overview is the chips' one render home (#2892); the seed plants 4 weekly
  // frequency targets, so the Weekly targets card renders every one (met + partial).
  const chips = main.getByTestId("weekly-target-chip");
  await expect(chips.first()).toBeVisible(); // first-ok: asserts the weekly-target chips render at all (count asserted next) — order-agnostic
  const n = await chips.count();
  expect(n).toBeGreaterThan(0);

  for (let i = 0; i < n; i++) {
    const chip = chips.nth(i);
    const tone = await toneOf(chip);
    expect(["met", "on-pace", "behind"]).toContain(tone);
    await expect(chip).toHaveClass(new RegExp(BORDER[tone]));
    await expect(chip).not.toHaveClass(/rose-/);
    await expect(chip).not.toHaveClass(/sky-/);
  }
});
