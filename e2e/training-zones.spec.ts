import { test, expect } from "./fixtures";
import { settledFill } from "./helpers";

// Issue #159: training intensity distribution (HR zones). The seed profile is
// ~40y with a resting HR, so the zone model builds via Karvonen. e2e/seed-events
// layers a windowed cardio ride with per-minute HR (50 min Zone 2 + 10 min Zone 4)
// plus one out-of-window resting bucket that must NOT count (both dated within the
// hub's 90-day default window, so the section's shared range includes them). These
// specs prove the Trends → Fitness zone section renders that distribution, and that the Settings →
// Profile inputs persist. Reads only + a self-cleaning settings round-trip, so no
// rows other specs assert on are disturbed.

test("Trends → Fitness renders the HR training-intensity section (#159)", async ({
  page,
}) => {
  // #1492: the nested `?ftab=cardio` strip retired — zones are a SECTION of the
  // windowed Fitness lens now (and the old link still lands here, covered by
  // e2e/trends-fitness-lens.mobile.spec.ts).
  await page.goto("/trends?tab=fitness");
  const main = page.getByRole("main");

  const zones = main.getByTestId("training-zones");
  await expect(zones).toBeVisible();
  await expect(zones.getByText("Training intensity (HR zones)")).toBeVisible();

  // The zone boundary table shows the formula (no black box) — Karvonen here.
  await expect(zones.getByText(/Karvonen/)).toBeVisible();
  // Zone names render in the boundary table.
  await expect(
    zones.getByText("Zone 2", { exact: false }).first() // first-ok: "Zone 2" labels a row in the scoped HR-zone table; assert the zone renders at all
  ).toBeVisible();

  // The easy/hard polarization split renders. The fixture is ~83/17, so "easy"
  // dominates — assert the split SUMMARY ("83% easy · 17% hard"). The full
  // pattern is required: the split element's own explanatory note ("...keeps
  // ~80% easy.") also matches a bare /% easy/, a strict-mode double-match.
  const split = zones.getByTestId("polarization-split");
  await expect(split).toBeVisible();
  await expect(split.getByText(/\d+% easy · \d+% hard/)).toBeVisible();

  // The current-week Zone 2 adherence line renders against the default target.
  await expect(zones.getByTestId("zone2-adherence")).toBeVisible();
});

test("Settings → Profile persists the max-HR override and Zone 2 target (#159)", async ({
  page,
}) => {
  await page.goto("/settings/training");
  const main = page.getByRole("main");

  const form = main.getByTestId("training-zones-form");
  await expect(form).toBeVisible();

  const maxHr = form.getByTestId("max-hr-override");
  const target = form.getByTestId("zone2-target-input");

  // Round-trip: set both, blur to save (the autosave check confirms), then reload
  // and confirm they stuck. SaveStatus is icon-only — match its aria-label.
  // settledFill: land the value in React state before the autosave reads it (a
  // pre-hydration fill of a controlled input reverts, no save fires — #1188).
  await settledFill(page, maxHr, "185");
  await maxHr.blur();
  await expect(form.getByLabel("Saved")).toBeVisible();
  await settledFill(page, target, "180");
  await target.blur();
  await expect(form.getByLabel("Saved")).toBeVisible();

  await page.reload();
  await expect(main.getByTestId("max-hr-override")).toHaveValue("185");
  await expect(main.getByTestId("zone2-target-input")).toHaveValue("180");

  // Self-clean: restore the defaults so other specs / re-runs see the seed state
  // (blank max-HR clears the override; 150 is the default Zone 2 target).
  const maxHr2 = main.getByTestId("max-hr-override");
  const target2 = main.getByTestId("zone2-target-input");
  await settledFill(page, maxHr2, "");
  await maxHr2.blur();
  await expect(main.getByLabel("Saved")).toBeVisible();
  await settledFill(page, target2, "150");
  await target2.blur();
  await expect(main.getByLabel("Saved")).toBeVisible();
});

test("Settings → Training persists the daily step target (#1723)", async ({
  page,
}) => {
  await page.goto("/settings/training");
  const main = page.getByRole("main");
  const form = main.getByTestId("training-zones-form");
  await expect(form).toBeVisible();

  // The declared daily step target starts EMPTY — nothing counts steps against a
  // number nobody chose, so blank is the honest resting state, not a defaulted 10k.
  const steps = form.getByTestId("steps-daily-target-input");
  await expect(steps).toHaveValue("");

  await settledFill(page, steps, "8000");
  await steps.blur();
  await expect(form.getByLabel("Saved")).toBeVisible();

  await page.reload();
  await expect(main.getByTestId("steps-daily-target-input")).toHaveValue(
    "8000"
  );

  // Clearing it is a first-class state, not an error: self-clean back to no target.
  const steps2 = main.getByTestId("steps-daily-target-input");
  await settledFill(page, steps2, "");
  await steps2.blur();
  await expect(main.getByLabel("Saved")).toBeVisible();
  await page.reload();
  await expect(main.getByTestId("steps-daily-target-input")).toHaveValue("");
});
