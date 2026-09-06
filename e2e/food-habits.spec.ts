import { test, expect } from "./fixtures";
import { hydratedClick, settledClick } from "./helpers";
import {
  expectDesktopOrdinarySubmit,
  expectPhoneOrdinarySubmit,
} from "./ordinary-submit-actions";
import { withProtocolFact } from "./protocol-form-helpers";
// Food-habit targets (issue #580): the /nutrition Weekly habits card shows a food_group
// frequency target with its #579-rollup progress, and a new habit can be tracked/removed.
// The seed plants a "fatty fish 2×/week" habit. Idempotent — the tracked-then-removed
// habit leaves the fixture as found.

test("Weekly habits shows the seeded fatty-fish target with progress (#580)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  const card = page.getByTestId("weekly-habits");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("habit-fatty_fish")).toBeVisible();
  // "N" on the row, "of 2" on the habit's own span — the rollup count and the target
  // read as one sentence in ONE list (#3987) — and a pace badge (#748 item 3) only where
  // there is a verdict to print (#5395). The seed logs fish on two fixed weekdays, so on
  // the week's first day nothing is logged yet and the row is quiet: count, no badge.
  await expect(page.getByTestId("habit-fatty_fish")).toContainText("of 2");
  const servings = Number(
    (await card.getByTestId("rollup-fatty_fish").innerText()).match(/^\d+/)![0]
  );
  const pace = card.getByTestId("habit-pace-fatty_fish");
  if (servings === 0) await expect(pace).toHaveCount(0);
  else await expect(pace).toHaveText(/On track|On pace|Behind/);
});

test("tracking a new food habit adds it, and removing it leaves the fixture as found (#580)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  // Track "Legumes & beans" as a weekly habit. The form is ONE folded affordance now
  // (#3987): tracking a habit is a rare act and a standing form taxes every visit.
  await hydratedClick(page, page.getByTestId("track-habit-summary"));
  await page
    .getByTestId("add-habit-form")
    .getByLabel("Food group")
    .selectOption("legumes");
  // Scoped to the add form: the suggestion cards render their own "Track"
  // buttons (7 on the seeded page), a strict-mode collision unscoped.
  const form = page.getByTestId("add-habit-form");
  const submit = form.getByRole("button", { name: "Track" });
  const servings = form.getByLabel("Servings per week");
  await expectDesktopOrdinarySubmit({
    form,
    owner: form,
    submit,
    adjacent: servings,
    name: "weekly habit Track",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectPhoneOrdinarySubmit({
    form,
    owner: form,
    submit,
    adjacent: servings,
    name: "weekly habit Track",
  });
  await settledClick(page, submit);

  await expect(page.getByTestId("habit-legumes")).toBeVisible();

  // Remove it (leave as found).
  await page
    .getByTestId("habit-legumes")
    .getByRole("button", { name: "Stop tracking this habit" })
    .click();
  await expect(page.getByTestId("habit-legumes")).toHaveCount(0);
});

test("untracking a habit a protocol measures confirms first (#748 item 6)", async ({
  page,
}) => {
  test.slow(); // next dev compiles the protocols route on first hit

  const protocolName = `E2E Habit Protocol ${Date.now()}`; // clock-ok: unique fixture-name suffix, never a stored timestamp

  // Create a protocol that adopts the "Shellfish" food habit as its practice — the
  // #580 protocol↔target link. This also creates the shellfish habit target.
  await page.goto("/longevity#protocols");
  const main = page.getByRole("main");
  await main.getByTestId("new-protocol-toggle").click();
  const form = page.getByTestId("protocol-form");
  await form.getByLabel("Name").fill(protocolName);
  // The practice and its cadence are two facts behind two chips now (#3219).
  await withProtocolFact(form, "practice", async () => {
    await form
      .getByTestId("protocol-practice-type")
      .selectOption("food_group:shellfish");
  });
  await withProtocolFact(form, "cadence", async () => {
    await form.getByTestId("protocol-practice-per-week").fill("2");
  });
  await form.getByRole("button", { name: "Create protocol" }).click();
  await page.waitForURL(/\/protocols\/\d+/);
  const protocolUrl = page.url();

  // The habit now shows on /nutrition and is protocol-referenced.
  await page.goto("/nutrition");
  await expect(page.getByTestId("habit-shellfish")).toBeVisible();

  // First tap of the X → a confirm dialog naming the protocol; cancelling keeps it.
  await page
    .getByTestId("habit-shellfish")
    .getByRole("button", { name: "Stop tracking this habit" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(protocolName);
  await dialog.getByRole("button", { name: "Keep tracking" }).click();
  await expect(page.getByTestId("habit-shellfish")).toBeVisible();

  // Second tap → confirm → the habit is untracked.
  await page
    .getByTestId("habit-shellfish")
    .getByRole("button", { name: "Stop tracking this habit" })
    .click();
  const dialog2 = page.getByRole("dialog");
  await expect(dialog2).toBeVisible();
  await dialog2.getByRole("button", { name: "Stop tracking" }).click();
  await expect(page.getByTestId("habit-shellfish")).toHaveCount(0);

  // Clean up the protocol through the app confirmation — leave the fixture as found.
  await page.goto(protocolUrl);
  await hydratedClick(
    page,
    page.getByRole("button", { name: "More protocol actions" })
  );
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: "Delete", exact: true })
    .click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete protocol" })
  );
  await page.waitForURL(/\/longevity(?:#|$)/);
});

test("a food-group habit that conflicts with an active medication carries the interaction note (#661)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  // Track leafy greens — the seed has an active Warfarin medication, so the habit
  // should carry the vitamin-K food–drug note (same fact the medication row shows).
  await hydratedClick(page, page.getByTestId("track-habit-summary"));
  await page
    .getByTestId("add-habit-form")
    .getByLabel("Food group")
    .selectOption("leafy_greens");
  await page
    .getByTestId("add-habit-form")
    .getByRole("button", { name: "Track" })
    .click();

  await expect(page.getByTestId("habit-leafy_greens")).toBeVisible();
  const warning = page.getByTestId("habit-warning-leafy_greens");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Warfarin");

  // Remove it (leave the fixture as found).
  await page
    .getByTestId("habit-leafy_greens")
    .getByRole("button", { name: "Stop tracking this habit" })
    .click();
  await expect(page.getByTestId("habit-leafy_greens")).toHaveCount(0);
});
