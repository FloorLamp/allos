import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import {
  hydratedClick,
  openConfirm,
  settledClick,
  settledFill,
} from "./helpers";

// Issue #2888 — /training's weekly targets are the TRAINING targets.
// (#3474 renamed the card from "Weekly routine" to "Weekly targets"; the scoping
// guarantee this file pins is unchanged.)
//
// `frequency_targets` is scope-generic: one table, seven scope kinds, four domains,
// and `getFrequencyTargetProgress` hands back every floor target a profile has. The
// training hub read it whole, so a fatty-fish food habit and a red-light-therapy
// wellness practice rendered as weekly-target chips there — the food one under a
// caption ("counts distinct training days") that states the wrong counting rule for it
// (`food_group` counts SERVINGS, #579), and, on the Plan tab, as a clickable EDIT
// control that could not save: the Scope select has no food option, so the submitted
// scope_kind was blank, the action returned without writing, and the form toasted
// "Routine updated" anyway (that toast now reads "Target updated").
//
// Membership is now declared per scope in `CADENCE_SCOPES.home` and read through one
// predicate. This spec pins the user-visible half at the only tier that can see a chip
// on a page:
//
//   • containment — neither the food habit nor the practice appears on EITHER training
//     surface (the Overview week card, and the Plan tab's editor card);
//   • the mobility target — the member a strict "training domain" reading would have
//     dropped — still renders here, with its "Mobility: " label;
//   • nothing is hidden from the user: both targets are still on their own pages;
//   • the edit that used to be silently discarded now persists, asserted after a
//     RELOAD rather than from the toast, because the toast is the thing that lied.
//
// The first three run READ-ONLY against the shared seeded profile, which already owns
// exactly the mix the report describes: five training-scope targets (Upper, Lower,
// Chest, cardio, Mobility: Legs) plus a `fatty_fish` food habit and a "Red light
// therapy" practice range. The last is create-and-clean (#868): it adds its own target
// through the form, edits it, and deletes it again, so no seeded row moves.

const FOOD_HABIT = "Fatty fish"; // scripts/seed.ts — a food_group target, home: nutrition
const PRACTICE = "Red light therapy"; // a practice range target, home: wellness
const MOBILITY_CHIP = "Mobility: Legs"; // a mobility_region target, home: training
// A scope the seed does not use, so the write test can own its own row end to end.
const OWNED = "Shoulders";

// The chips of one card, as their label text (the chip's first line).
async function chipLabels(card: Locator): Promise<string[]> {
  const chips = card.getByTestId("weekly-target-chip");
  await expect(chips.first()).toBeVisible(); // first-ok: asserts the card has chips at all — the full set is read below, order-agnostic
  return (await chips.allInnerTexts()).map((t) => t.split("\n")[0].trim());
}

// The Plan tab's Weekly targets card, which is both the chips' editing home and the
// second surface that used to leak.
const planCard = (page: Page) => page.getByRole("main").locator("#targets");

test("the Overview week card's weekly targets carry training scopes only (#2888)", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");
  const card = page.getByRole("main").getByTestId("training-week");
  await expect(card).toBeVisible();
  await expect(card.getByText("Weekly targets", { exact: true })).toBeVisible();

  const labels = await chipLabels(card);
  // The food habit and the practice live elsewhere and do not render here.
  expect(labels).not.toContain(FOOD_HABIT);
  expect(labels).not.toContain(PRACTICE);
  // Mobility DOES: the hub's own Mobility card mints these targets (#840), so a page
  // that hid them would be creating a target it then refuses to show.
  expect(labels).toContain(MOBILITY_CHIP);
  // …and the training routine proper is untouched.
  expect(labels).toContain("Chest");
});

test("the Plan tab's weekly-targets editor shows the same set (#2888)", async ({
  page,
}) => {
  await page.goto("/training?tab=plan");
  const card = planCard(page);
  await expect(card).toBeVisible();

  const labels = await chipLabels(card);
  expect(labels).not.toContain(FOOD_HABIT);
  expect(labels).not.toContain(PRACTICE);
  expect(labels).toContain(MOBILITY_CHIP);
  expect(labels).toContain("Chest");

  // The editor's Scope select is what makes that the right set rather than a narrower
  // one: every chip above has an option here, so no chip can load a scope this form
  // cannot submit — which is the silent-no-op the report's second half describes.
  // The form folds since #3474, so the options are read with it open.
  await hydratedClick(page, card.getByTestId("frequency-target-toggle"));
  await expect(card.locator('select[name="scope_kind"] option')).toHaveText([
    "Muscle region",
    "Body group",
    "Activity type",
    "Mobility region",
  ]);
});

test("both targets are still fully present on their own pages (#2888)", async ({
  page,
}) => {
  // Nothing was hidden from the user — each target renders where it already lived.
  await page.goto("/nutrition");
  const habits = page.getByTestId("weekly-habits");
  await expect(habits).toBeVisible();
  await expect(habits.getByTestId("habit-fatty_fish")).toContainText(
    FOOD_HABIT
  );

  await page.goto("/wellness");
  await expect(
    page
      .getByRole("main")
      .getByTestId("wellness-practice-card")
      .filter({ hasText: PRACTICE })
  ).toBeVisible();
});

test("a routine edited from its chip actually persists (#2888)", async ({
  page,
}) => {
  await page.goto("/training?tab=plan");
  const card = planCard(page);
  await expect(card).toBeVisible();

  const chip = () =>
    planCard(page).getByTestId("weekly-target-chip").filter({ hasText: OWNED });

  // The entry form folds since #3474 (#1497's rare-cadence rule): open it first.
  // Opening is a pure client toggle, so hydratedClick, not the Server Action one.
  await hydratedClick(page, card.getByTestId("frequency-target-toggle"));
  await expect(card.getByTestId("frequency-target-toggle")).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  await page.locator('select[name="scope_kind"]').selectOption("region");
  await page.locator('select[name="scope_value"]').selectOption(OWNED);
  await settledFill(page, card.locator('input[name="per_week"]'), "2");
  await settledClick(page, card.getByRole("button", { name: "Save" }));
  await expect(chip()).toHaveAttribute(
    "title",
    new RegExp(`${OWNED}: \\d+/2 this week`)
  );

  try {
    // Clicking a chip loads it into the form — a pure client state change, so the
    // hydration-safe SINGLE click, not the Server Action one.
    await hydratedClick(page, chip());
    await expect(card.locator('input[name="per_week"]')).toHaveValue("2");
    await settledFill(page, card.locator('input[name="per_week"]'), "4");
    // Selecting a chip OPENS the fold with that target loaded (#3474 item 2).
    await expect(card.getByTestId("frequency-target-toggle")).toHaveText(
      "Update target"
    );
    await settledClick(page, card.getByRole("button", { name: "Save" }));

    // The edit survives a fresh server render: four squares, not two.
    await page.reload();
    await expect(chip()).toHaveAttribute(
      "title",
      new RegExp(`${OWNED}: \\d+/4 this week`)
    );
    await expect(chip().locator("span.h-3")).toHaveCount(4);
  } finally {
    // Leave the fixture as found.
    if (await chip().count()) {
      await hydratedClick(page, chip());
      const dialog = await openConfirm(
        page,
        planCard(page).getByRole("button", { name: "Delete" })
      );
      await settledClick(page, dialog.getByRole("button", { name: "Delete" }));
      await expect(chip()).toHaveCount(0);
    }
  }
});
