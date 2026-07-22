import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_NOGEAR, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Issue #342: the ACTIVITY-level equipment link. The seed links its "Zone 2 bike"
// ride to a "Road Bike" (category Bike), so the Journal renders a session-level gear
// chip and opening the editor preloads the reusable activity-equipment picker with
// that gear — proving the link renders and round-trips on the real page.
test("a cardio session shows its gear chip and preloads the equipment picker (#342)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  const card = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Zone 2 bike" })
    .first(); // first-ok: the seeded "Zone 2 bike" activity card (filtered by its unique title)
  await expect(card).toBeVisible();

  // Session gear is quiet metadata in the card's third row, not a standalone
  // prominent chip/link between the activity and its provenance.
  const gear = card.getByTestId("activity-gear");
  await expect(gear).toBeVisible();
  await expect(gear).toContainText("Road Bike");
  await expect(gear).not.toHaveClass(/font-medium|text-brand/);
  expect(
    await gear.evaluate(
      (node) => node.closest('[data-testid="activity-metrics"]') != null
    )
  ).toBe(true);

  // Opening the editor (via the card title) preloads the activity-level picker with
  // the linked gear — a real equipment id is selected, labelled "Road Bike".
  await card.getByRole("button", { name: "Zone 2 bike" }).click();
  const select = page.getByTestId("activity-equipment-select");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue(/\d+/);
  await expect(select.locator("option:checked")).toHaveText("Road Bike");
  // The bike ride offers the Bike but NOT the Shoes (issue #339 narrowing).
  await expect(select.locator("option", { hasText: "Road Bike" })).toHaveCount(
    1
  );
  await expect(
    select.locator("option", { hasText: "Trail Shoes" })
  ).toHaveCount(0);
});

// Issue #339: the cardio picker is filtered by the activity's gear affinity — a run
// offers Shoes, a ride offers Bikes — not all cardio gear. The seed owns a "Road
// Bike" (Bike) and "Trail Shoes" (Shoes); opening the "5k run" (a Running cardio
// session) must surface the shoes and hide the bike, the mirror of the ride above.
test("a run offers shoes (not the bike) in the equipment picker (#339)", async ({
  page,
}) => {
  await page.goto("/training");

  const card = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "5k run" })
    .first(); // first-ok: the seeded "5k run" activity card (filtered by its unique title)
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "5k run" }).click();
  const select = page.getByTestId("activity-equipment-select");
  await expect(select).toBeVisible();
  // Shoes present, bike absent — the run narrows to footwear.
  await expect(
    select.locator("option", { hasText: "Trail Shoes" })
  ).toHaveCount(1);
  await expect(select.locator("option", { hasText: "Road Bike" })).toHaveCount(
    0
  );
});

// #592: the activity-level equipment picker used to render NOTHING when the profile
// owned no fitting gear — hiding the "Manage equipment" link, which is the ONE
// bootstrap path to the /equipment registry (every other entry point is gated on
// already having gear). It now shows an empty-state "Add equipment" door instead.
// Driven on a DEDICATED no-gear profile (see seed-events / fixture-logins) so the
// empty inventory is provable — profile 1 always owns gear. Read-only (never saves).
test("the activity form shows an 'Add equipment' door when the profile owns no gear (#592)", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_NOGEAR,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training"); // default "Log" tab

    // Open a fresh create form (the seeded activity makes the Journal — and its
    // "New activity" button — render instead of the empty state).
    await page
      .getByRole("main")
      .getByRole("button", { name: "New activity" })
      .click();

    // Pick a known cardio activity so the session-level equipment picker mounts;
    // picking commits the part TYPE (typing the name alone doesn't).
    await page.getByPlaceholder(/What did you do/).fill("Running");
    await page
      .getByRole("listbox")
      .getByRole("button", { name: "Running", exact: true })
      .click();

    // With no gear on file the picker renders its empty-state door, not a <select>.
    await expect(page.getByTestId("activity-equipment-empty")).toBeVisible();
    await expect(page.getByTestId("activity-equipment-select")).toHaveCount(0);
    const door = page.getByTestId("activity-equipment-link");
    await expect(door).toBeVisible();
    await expect(door).toHaveText(/Add equipment/);
    await expect(door).toHaveAttribute("href", "/equipment");
  } finally {
    await page.context().close();
  }
});
