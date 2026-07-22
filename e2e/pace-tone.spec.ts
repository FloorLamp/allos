import { test, expect, type Locator } from "@playwright/test";

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
const FILL: Record<string, string> = {
  met: "bg-emerald-500",
  "on-pace": "bg-brand-500",
  behind: "bg-amber-500",
  failed: "bg-rose-500",
};
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

test("dashboard goal bars read on-pace/met on fresh goals — never a rose failing bar (#780)", async ({
  page,
}) => {
  await page.goto("/");
  const card = page.getByRole("main").getByTestId("goals-habits");
  await expect(card).toBeVisible();

  const bars = card.getByTestId("goal-bar");
  const n = await bars.count();
  expect(
    n,
    "the seeded profile has active goals with progress bars"
  ).toBeGreaterThan(0);

  for (let i = 0; i < n; i++) {
    const bar = bars.nth(i);
    const tone = await toneOf(bar);
    // Seed goals are created today with future deadlines → 0% elapsed owes 0%, so
    // every one is on-pace (or met once complete). Never behind, never failed.
    expect(["met", "on-pace"]).toContain(tone);
    // Colour is the shared fill class for that exact tone (format over ONE map).
    await expect(bar).toHaveClass(new RegExp(FILL[tone]));
    await expect(bar).not.toHaveClass(/bg-rose-500/);
    await expect(bar).not.toHaveClass(/sky-/);
  }
});

test("dashboard habit chips are pace-coloured and rose-free (#780)", async ({
  page,
}) => {
  await page.goto("/");
  const card = page.getByRole("main").getByTestId("goals-habits");
  await expect(card).toBeVisible();

  const chips = card.getByTestId("weekly-target-chip");
  // The dashboard hides MET habits, and by mid-week the scripts/seed.ts activity
  // history satisfies all of its targets — so determinism comes from the dedicated
  // e2e/seed-events.ts fixture: a "Glutes 5×/week" region target that no seeded
  // exercise can ever satisfy (nothing Glutes-primary is logged). It stays 0/5 open
  // all week, so at least one chip always renders, and its pace is on-pace/behind.
  expect(await chips.count()).toBeGreaterThan(0);
  for (let i = 0; i < (await chips.count()); i++) {
    const chip = chips.nth(i);
    const tone = await toneOf(chip);
    // A weekly chip is 3-state — never "failed" (weeks reset, they don't fail).
    expect(["met", "on-pace", "behind"]).toContain(tone);
    await expect(chip).toHaveClass(new RegExp(BORDER[tone]));
    await expect(chip).not.toHaveClass(/rose-/);
    await expect(chip).not.toHaveClass(/sky-/);
  }
});

test("Training weekly routine chips are pace-coloured, rose-free, and sky-free (#780)", async ({
  page,
}) => {
  await page.goto("/training");
  const main = page.getByRole("main");
  // Overview is the default tab; the seed plants 4 weekly frequency targets, so the
  // Weekly routine renders every one (met + partial), not just the open subset.
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
