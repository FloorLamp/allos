import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  deleteActivityFromForm,
  followLink,
  hydratedClick,
  settledClick,
  settledFill,
} from "./helpers";
import { E2E_LOGIN_NOGEAR, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// WHICH CLICKS IN THIS FILE ARE HYDRATION-SENSITIVE, AND WHICH ARE NOT (#3254).
//
// Measured on an UNTOUCHED `origin/main`: 4 failures in 10 trials under a 20× CDP CPU
// throttle. That measurement is what exonerated PR #3249, whose diff could not reach
// this spec — the cost of the fragility is a review cycle every time it lands on
// somebody, not a red anybody owns.
//
// The class is #2742's: a tap that lands before React attaches its handler is
// SWALLOWED WITH NO ERROR — Playwright's actionability checks all pass, because the
// element is genuinely fine — and the failure surfaces later as "element(s) not
// found". A retry loop is the wrong fix (every iteration before hydration spends
// budget on a click that could not land) and so is a bigger timeout (it makes the
// assertion pass by accident). `hydratedClick` waits for the STATE.
//
// It applies to a control that was SERVER HTML in the document just navigated to.
// Every remaining bare `.click()` below targets something client React created in
// response to an earlier interaction — a combobox listbox opened by typing, the
// quick-add inside the already-open editor workspace, a portaled menu item — and is
// therefore hydrated by construction, the same reasoning `deleteActivityFromForm`
// records for a confirm dialog's own button. Converting those would state a
// dependency that does not exist. `ActivityEditorProvider` opens the editor with
// `setOpen(true)` rather than a route change, which is what puts the whole form on
// the client-created side of that line.

// Issue #342: the ACTIVITY-level equipment link. The seed links its "Zone 2 bike"
// ride to a "Road Bike" (category Bike), so the Training Log renders a session-level gear
// chip and opening the editor preloads the reusable activity-equipment picker with
// that gear — proving the link renders and round-trips on the real page.
test("a cardio session shows its gear chip and preloads the equipment picker (#342)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  // The feed renders slim rows; gear lives on the canonical activity page.
  const row = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Zone 2 bike" })
    .first(); // first-ok: the seeded "Zone 2 bike" activity row (filtered by its unique title)
  await expect(row).toBeVisible();
  await followLink(
    page,
    row.getByRole("link", { name: "Zone 2 bike", exact: true }),
    /\/training\/activity\/\d+$/
  );
  const card = page.getByTestId("training-activity-page");
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

  // Cycling titles lead to the canonical activity detail. Its primary Edit action
  // opens the shared editor with the linked gear preloaded — a real
  // equipment id is selected, labelled "Road Bike".
  await hydratedClick(page, card.getByTestId("activity-page-edit"));
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
  await page.goto("/training?tab=log");

  // Follow the run's slim row to its canonical page, then open the shared editor.
  const row = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "5k run" })
    .first(); // first-ok: the seeded "5k run" activity row (filtered by its unique title)
  await expect(row).toBeVisible();
  await followLink(
    page,
    row.getByRole("link", { name: "5k run", exact: true }),
    /\/training\/activity\/\d+$/
  );
  await hydratedClick(
    page,
    page.getByTestId("training-activity-page").getByTestId("activity-page-edit")
  );
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
    await page.goto("/training?tab=log"); // default "Log" tab

    // Open a fresh create form (the seeded activity makes the Training Log — and its
    // "New activity" button — render instead of the empty state).
    await hydratedClick(
      page,
      page.getByRole("main").getByRole("button", { name: "New activity" })
    );

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
    await expect(door).not.toHaveAttribute("target", "_blank");
    // A real navigation, and the assertion below is its destination — so make the
    // URL commit part of the same retry boundary. Re-clicking a link that already
    // committed asks for the same URL again, so followLink's retry is free here.
    await followLink(page, door, /\/equipment$/);
    await expect(page.getByTestId("activity-form")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

// ---- #1611: the STRENGTH set picker's add/manage door ----------------------
//
// The strength picker rendered its custom-equipment <select> only when the profile
// already owned equipment and offered no creation action at all, so a traveller who
// owns a home chest press could not register the different hotel machine without
// leaving the in-progress workout — and the editor's server-supplied equipment list
// would have stayed stale anyway. It now always shows an Add/Manage door and a
// compact in-form quick-add that reuses createEquipmentAction.
//
// Fixture ownership (docs/internals/e2e-hygiene.md): both the probe activity and the
// created equipment carry a UNIQUE per-run suffix and are deleted at the end, so a
// --repeat-each rerun (or a sibling spec) can never collide on a shared name.

const GEAR_PREFIX = "Travel press probe";

test("the strength picker creates and selects a travel machine without losing the workout (#1611)", async ({
  page,
}) => {
  test.slow(); // local next dev compiles /training on first hit
  await page.setViewportSize({ width: 1280, height: 900 });

  const stamp = `${Date.now()}`; // clock-ok: unique-name suffix for this run's probe activity + equipment, never a stored timestamp
  const title = `${GEAR_PREFIX} session ${stamp}`;
  const gearName = `${GEAR_PREFIX} ${stamp}`;

  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed
  await hydratedClick(
    page,
    page
      .getByTestId("training-log-actions")
      .getByRole("button", { name: "New activity" })
  );

  await page.getByRole("textbox", { name: "Activity name" }).fill(title);
  // A fully-qualified variant (never the bare base, which needs a per-set equipment
  // pick before it can save) — and its "Barbell" variant is what the quick-add
  // defaults the new row's category from.
  await page.getByPlaceholder(/What did you do/).fill("Barbell Bench Press");
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: "Barbell Bench Press" })
    .first() // first-ok: transient combobox list this spec just opened by typing the name
    .click();

  // Enter a complete working set FIRST — the whole point is that creating equipment
  // mid-workout doesn't discard it.
  const weight = page.getByTestId("set1-weight");
  const reps = page.getByTestId("set1-reps-stepper").locator("input");
  await settledFill(page, weight, "100");
  await settledFill(page, reps, "5");
  // The complete set auto-saves; Delete appearing is the stable "row exists" signal.
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // The full-registry door is ordinary same-app navigation. The activity is
  // already autosaved, so it does not need a surprise second tab.
  const door = page.getByTestId("strength-equipment-link");
  await expect(door).toBeVisible();
  await expect(door).toHaveAttribute("href", "/equipment");
  await expect(door).not.toHaveAttribute("target", "_blank");

  // Open the compact in-form quick-add.
  await page.getByTestId("strength-equipment-add").click();
  const quickAdd = page.getByTestId("strength-equipment-quickadd");
  await expect(quickAdd).toBeVisible();
  // The category is defaulted from the lift's built-in variant ("Barbell Bench
  // Press" → Barbell), so the traveller only has to type a name.
  await expect(page.getByTestId("strength-equipment-new-category")).toHaveValue(
    "Barbell"
  );

  await settledFill(
    page,
    page.getByTestId("strength-equipment-new-name"),
    gearName
  );
  await settledClick(page, page.getByTestId("strength-equipment-new-save"));

  // The created row is selected on the CURRENT part immediately — no reopen.
  const select = page.getByTestId("strength-equipment-select");
  await expect(select).toBeVisible();
  await expect(select.locator("option:checked")).toHaveText(gearName);
  // …and every set value survived the creation round trip.
  await expect(weight).toHaveValue("100");
  await expect(reps).toHaveValue("5");
  // The quick-add closed on success.
  await expect(quickAdd).toHaveCount(0);

  // A duplicate name is refused by the SHARED equipment write core, rendered inline
  // — the form stays open and the activity underneath is untouched.
  await page.getByTestId("strength-equipment-add").click();
  await settledFill(
    page,
    page.getByTestId("strength-equipment-new-name"),
    gearName
  );
  await settledClick(page, page.getByTestId("strength-equipment-new-save"));
  await expect(page.getByTestId("strength-equipment-new-error")).toContainText(
    gearName
  );
  await expect(page.getByTestId("strength-equipment-quickadd")).toBeVisible();
  await expect(weight).toHaveValue("100");

  // Cleanup: the probe session, then the probe equipment.
  //
  // Through the shared settled discard (#3267/#3287) rather than a local
  // click-then-settledClick pair. `settledClick` promises "an action POST resolved",
  // and this form has just fired TWO auto-saves and a refused quick-add save, so the
  // POST it settles on need not be the delete's (#1952). The toast is the delete's
  // own completion: `useUndoableDelete` announces "Activity deleted." only after
  // `await action(fd)` resolves. It also spends the confirm's opening click through
  // `openConfirm`, which is the one control here that a re-click may never be given.
  await deleteActivityFromForm(page);
  await page.goto("/training?tab=log");
  await expect(
    page
      .getByRole("main")
      .locator('[id^="activity-"]')
      .filter({ hasText: title })
  ).toHaveCount(0);

  await page.goto("/equipment");
  const row = page.getByTestId("equipment-row").filter({ hasText: gearName });
  await expect(row).toBeVisible();
  // Delete moved into the shared ⋯ menu (#1491): open the row's menu, then click
  // the (portaled) Delete item.
  // Client-only OverflowMenu toggle, so the click must land after hydration.
  await hydratedClick(
    page,
    row.getByRole("button", { name: "Equipment actions" })
  );
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await settledClick(
    page,
    page.getByTestId("confirm-dialog").getByRole("button", { name: "Delete" })
  );
  await expect(row).toHaveCount(0);
});

// The empty-inventory half of the same door (#1611, mirroring #592): a profile with
// no strength gear gets an "Add equipment →" bootstrap link AND the quick-add button
// from the strength form, where before it got neither — the <select> was gated on
// already owning equipment. Driven on the dedicated no-gear profile, read-only.
test("the strength form shows an equipment door with no gear on file (#1611)", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_NOGEAR,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/training?tab=log");
    await hydratedClick(
      page,
      page.getByRole("main").getByRole("button", { name: "New activity" })
    );

    await page.getByPlaceholder(/What did you do/).fill("Barbell Bench Press");
    await page
      .getByRole("listbox")
      .getByRole("button")
      .filter({ hasText: "Barbell Bench Press" })
      .first() // first-ok: transient combobox list this spec just opened by typing the name
      .click();

    // No gear on file: no <select>, but BOTH doors render (the bug was that neither
    // did, leaving this profile with no path to the registry from the strength form).
    await expect(page.getByTestId("strength-equipment-select")).toHaveCount(0);
    await expect(page.getByTestId("strength-equipment-add")).toBeVisible();
    const door = page.getByTestId("strength-equipment-link");
    await expect(door).toBeVisible();
    await expect(door).toHaveText(/Add equipment/);
    await expect(door).toHaveAttribute("href", "/equipment");
  } finally {
    await page.context().close();
  }
});
