import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  comboboxRows,
  deleteActivityFromForm,
  followLink,
  hydratedClick,
  openConfirm,
  settledClick,
  settledFill,
  settledSelect,
} from "./helpers";
import { E2E_LOGIN_NOGEAR, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import {
  assertNoStrandedDrafts,
  SHARED_PROFILE_DRAFT_SCOPE,
} from "./shared-profile-guard";
import { workerDbPath } from "./worker-env";

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
  // REACHED BY SEARCH, because this fixture sits on the far side of a boundary
  // (#4079). The Log renders through the shared history substrate, whose default
  // view expands the last TIMELINE_RECENT_DAYS = 14 days and folds everything older
  // into month and year cards; the seed logs this ride at exactly 14 days back, so it
  // is one day outside the expanded band. A search is a question about the whole
  // record and renders its matches open, which is how a reader would find it.
  await page.goto("/training?tab=log&q=" + encodeURIComponent("Zone 2 bike"));

  // The feed renders slim rows; gear lives on the canonical activity page.
  const row = page
    .getByTestId("history-row")
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

  // Since #3334 the editor STATES the link rather than rendering the machinery that
  // produced it: a fact chip on the shared facts-with-editors primitive (#3218), with
  // the picker one tap behind. A STORED link is something the person asserted, so the
  // chip carries no suggestion marking — that marking belongs to the recency default a
  // fresh log gets, and the difference between the two is the whole of #846.
  const chip = page.getByTestId("activity-fact-equipment");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Road Bike");
  await expect(chip).toHaveAttribute("data-fact-state", "stated");
  await expect(chip).toHaveAttribute("data-suggested", "0");
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await chip.click();
  const select = page.getByTestId("activity-equipment-select");
  await expect(select).toBeVisible();
  // The chip opened THIS fact's editor and no other.
  await expect(page.getByTestId("activity-fact-editor")).toHaveAttribute(
    "data-panel",
    "equipment"
  );
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
    .getByTestId("history-row")
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
  // The picker lives behind the session equipment chip (#3334). The chip carries one
  // testid in BOTH its shapes — a stated gear name, or the "+ equipment" prompt when
  // nothing is linked — so this run does not depend on whether the seeded run has
  // shoes attached; the narrowing below is what this test is about.
  await page.getByTestId("activity-fact-equipment").click();
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
    // "Add activity" button — render instead of the empty state).
    await hydratedClick(
      page,
      page.getByRole("main").getByRole("button", { name: "Add activity" })
    );

    // Pick a known cardio activity so the session-level equipment picker mounts;
    // picking commits the part TYPE (typing the name alone doesn't).
    await page.getByPlaceholder(/What did you do/).fill("Running");
    await page
      .getByRole("listbox")
      .getByRole("option", { name: "Running", exact: true })
      .click();

    // The door moved INSIDE the fact editor (#3334) — it is still the one bootstrap
    // path, now one tap deep, and the chip that opens it is the "+ equipment" prompt
    // because a session with no gear is complete rather than waiting on a field.
    const chip = page.getByTestId("activity-fact-equipment");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/equipment/);
    await chip.click();

    // With no gear on file the picker renders its empty-state door, not a <select>.
    await expect(page.getByTestId("activity-equipment-empty")).toBeVisible();
    await expect(page.getByTestId("activity-equipment-select")).toHaveCount(0);
    const door = page.getByTestId("activity-equipment-link");
    await expect(door).toBeVisible();
    await expect(door).toHaveText(/Add equipment/);
    await expect(door).toHaveAttribute("href", "/equipment");
    await expect(door).not.toHaveAttribute("target", "_blank");
    // THE DOOR ASKS BEFORE IT LEAVES (#5111). This draft is a picked activity
    // with no set behind it — rowless and unsavable — and `leaveFor` has always
    // discarded it on the way out; what changed is that the guard now covers a
    // draft with no row, so the discard is a question instead of a silence.
    // `openConfirm` carries the hydration wait the followLink here used to.
    const discard = await openConfirm(page, door);
    await expect(discard).toContainText("Discard unsaved changes?");
    await discard.getByRole("button", { name: "Close anyway" }).click();
    await page.waitForURL(/\/equipment$/);
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

// THE ONE PLACE IN THIS FILE A LONGER BUDGET IS THE HONEST ANSWER (#3254).
//
// `settledFill` guarantees a value reached React state; it promises NOTHING about the
// DEBOUNCED AUTO-SAVE that follows, and the row's Delete control is the first thing on
// screen that depends on the server having stored the row. There is no settle point
// between the two — no POST to await by name, no marker that appears earlier — so the
// wait is a duration, and it needs a ceiling that says so.
//
// MEASURED, 20x CDP CPU throttle, five trials per tree, identical harness:
//
//   origin/main, default 5s ceiling                   0 pass / 5 fail  @ this line
//   this branch WITH the hydration fixes, default 5s  0 pass / 5 fail  @ this line
//   this branch WITH the hydration fixes, 25s ceiling see below
//
// The middle row is why this constant exists and why it is not a budget widened to
// paper over a swallowed tap. hydratedClick did not move this assertion by one trial,
// because there is no swallowed tap here to fix: the editor is already open (the fills
// above prove it), so everything in it is hydrated by construction. A pre-hydration
// swallow and a slow write are different failures that read identically as
// "element(s) not found", and the e2e-hygiene test for telling them apart is whether a
// bigger ceiling rescues it. Here it does — which is the same answer imaging.spec.ts
// got the other way round, and the reason that entry says latency was DISPROVEN there.
//
// TWO CALL SITES SINCE #3334, both the identical wait: settledFill on a set/duration
// field, then the row's Delete as the first thing on screen that needs the server to
// have stored the row. The measurement above was taken at the #1611 one; the #3334
// probe below reaches the same assertion by the same route, which is why it borrows the
// number rather than declaring a second one that would drift from its evidence.
const AUTOSAVE_ROW_MS = 25_000;

const GEAR_PREFIX = "Travel press probe";

test("the strength picker creates and selects a travel machine without losing the workout (#1611)", async ({
  page,
}) => {
  test.slow(); // local next dev compiles /training on first hit
  await page.setViewportSize({ width: 1280, height: 900 });

  const stamp = `${Date.now()}`; // clock-ok: unique-name suffix for this run's probe activity + equipment, never a stored timestamp
  const title = `${GEAR_PREFIX} session ${stamp}`;
  const gearName = `${GEAR_PREFIX} ${stamp}`;

  // THE PROBE SESSION IS A LIVE DRAFT ON THE SHARED PROFILE FROM ITS FIRST AUTO-SAVE,
  // so its disposal cannot sit only on the happy path. Observed directly while
  // measuring the throttle above: when this test failed at the Delete assertion it
  // left `activity <id> "Travel press probe session …"` on profile 1, and the standing
  // guard (#3173) had to clean up after it. Same defect as #3290/#3291, in the file
  // those two are being fixed alongside.
  try {
    await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed
    await hydratedClick(page, page.getByTestId("training-log-add-activity"));

    await page.getByRole("textbox", { name: "Activity name" }).fill(title);
    // A fully-qualified variant (never the bare base, which needs a per-set equipment
    // pick before it can save) — and its "Barbell" variant is what the quick-add
    // defaults the new row's category from.
    await page.getByPlaceholder(/What did you do/).fill("Barbell Bench Press");
    await comboboxRows(page)
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
    ).toBeVisible({ timeout: AUTOSAVE_ROW_MS });

    // The part states its implement and nothing else (#3349) — the picker, the
    // quick-add and the registry door are all behind this one chip.
    const chip = page.getByTestId("strength-equipment-chip");
    await expect(chip).toHaveText("Barbell");
    await expect(page.getByTestId("strength-equipment-link")).toHaveCount(0);
    await expect(page.getByTestId("strength-equipment-add")).toHaveCount(0);
    await chip.click();

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
    await expect(
      page.getByTestId("strength-equipment-new-category")
    ).toHaveValue("Barbell");

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
    await expect(
      page.getByTestId("strength-equipment-new-error")
    ).toContainText(gearName);
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
        .getByTestId("history-row")
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
    // Absence cannot prove the revalidated tree applied (#3303). Read it from a
    // fresh server render, after its positive page marker has settled.
    await page.goto("/equipment");
    await expect(page.getByTestId("equipment-index")).toBeVisible();
    await expect(row).toHaveCount(0);
  } finally {
    assertNoStrandedDrafts(workerDbPath(), SHARED_PROFILE_DRAFT_SCOPE);
  }
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
      page.getByRole("main").getByRole("button", { name: "Add activity" })
    );

    await page.getByPlaceholder(/What did you do/).fill("Barbell Bench Press");
    await comboboxRows(page)
      .filter({ hasText: "Barbell Bench Press" })
      .first() // first-ok: transient combobox list this spec just opened by typing the name
      .click();

    // No gear on file and a lift with a normal implement: the row STATES that
    // implement, and one tap opens the picker behind it (#3349).
    const chip = page.getByTestId("strength-equipment-chip");
    await expect(chip).toHaveText("Barbell");
    await chip.click();

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

// ---- #3334: what survives a CLOSED editor panel ---------------------------
//
// THE TWO THINGS THIS PINS, and why they need a browser rather than a code read.
//
// #3228 warned that the activity editor is a DOM-collected `<form action={handle}>`,
// where a field the browser cannot see is a field the save CLEARS (#2359), and that an
// unmounted panel's value is invisible to the dirty-form registry (`recordIsDirty` skips
// `!field.isConnected`) — so a fact moved behind a disclosure would be lost twice over,
// once on save and once on dismiss, the second time with no "Discard your changes?" to
// warn anybody.
//
// THAT PREMISE IS FALSE FOR THIS FORM, which is why the chip could be drawn at all: the
// <form> only `preventDefault`s, `buildFormData` composes every field by hand out of
// React state, and the dirty registry tracks NAMED controls of which this tree has none
// (the close prompt reads autosave's `dirty`, derived from `formSig`). But "it happens
// to be state-controlled today" is exactly the kind of fact that stops being true
// without anyone noticing, so both halves are pinned as BEHAVIOUR rather than left to a
// reading of the source.
//
// THE MUTANTS, and every one of them was RUN. (a) `buildFormData` reading the equipment
// <select> out of the DOM instead of state: with the panel closed the field is gone, the
// link is cleared, and the stored-gear assertion at the end fails. (b) An unmount that
// resets `activityEquipmentId`: the chip comes back stating the old gear instead of the
// prompt. (c) `formSig` dropping `activityEquipmentId` — the DIRTY half — which fails at
// the `data-unsaved` assertion in MOVE ONE and NOWHERE ELSE. Re-run against the marker
// for #3351: the mutant still dies at that one line, and it dies waiting for "true"
// rather than in setup.
//
// (c) IS WHY THE DIRTY ASSERTION SITS WHERE IT DOES. It was first written after the
// editor closed, and mutant (c) PASSED it: `requestClose` flushes unconditionally, so a
// value that reaches the row on the close path says nothing about whether the form ever
// counted it as a change. Observed with the form still open, it says exactly that.
//
// AND THE EDIT HAS TO BE A REAL ONE. The first draft chose the gear the recency default
// had ALREADY selected, so `formSig` never moved and no save was ever due — the test was
// green, and green for a reason that had nothing to do with what it claimed. Clearing to
// "None" cannot be a no-op against a non-null default, which is why the first move is
// the clear and not the pick.
//
// "Rowing" on purpose: a cardio activity with no bike/shoe affinity
// (cardioGearCategories → []), so the picker offers every cardio implement profile 1
// owns and the dedicated "E2E Registry Bike" is always among them. A "Running" probe
// would narrow to Shoes.
//
// Fixture ownership (docs/internals/e2e-hygiene.md): the probe activity carries a unique
// per-run suffix and is deleted at the end, so --repeat-each and sibling specs cannot
// collide. It is a live draft on the shared profile from its first auto-save, so its
// disposal cannot sit only on the happy path — hence the guard in `finally`.
const GEAR_CHIP_PREFIX = "Gear chip probe";

test("gear chosen behind a closed panel still saves, and still counts as a change (#3334)", async ({
  page,
}) => {
  test.slow(); // local next dev compiles /training on first hit
  const stamp = `${Date.now()}`; // clock-ok: unique-name suffix for this run's probe activity, never a stored timestamp
  const title = `${GEAR_CHIP_PREFIX} ${stamp}`;
  // The form's own dirty marker (#3351): "true" while it holds a change the server has
  // not got yet, "false" once autosave has caught up. It is autosave's `dirty` — the
  // same value the "Discard unsaved changes?" prompt reads — published on the <form>.
  //
  // THIS USED TO WATCH THE `Saved` CHECK, and the difference is the whole point of
  // #3351. That check fades after SAVED_FADE_MS, so "a check is on screen" is only
  // attributable to the edit under test if the PREVIOUS one has been waited out first —
  // making this pin depend on a constant chosen for how a confirmation feels, with
  // nothing to connect the two if somebody tunes it. The marker is readable at any
  // moment, so nothing here waits on an animation.
  const form = page.getByTestId("activity-form");

  try {
    await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed
    await hydratedClick(page, page.getByTestId("training-log-add-activity"));

    await page.getByRole("textbox", { name: "Activity name" }).fill(title);
    await page.getByPlaceholder(/What did you do/).fill("Rowing");
    await comboboxRows(page)
      .filter({ hasText: "Rowing" })
      .first() // first-ok: transient combobox list this spec just opened by typing the name
      .click();
    // A duration makes the session savable, so it auto-saves and gains a real row.
    await settledFill(page, page.getByTestId("cardio-duration"), "30");
    // Delete appearing is the stable "the server stored this row" signal — the same
    // measured wait AUTOSAVE_ROW_MS is declared for above, by the same route.
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeVisible({ timeout: AUTOSAVE_ROW_MS });

    // A FRESH log opens on the recency default and SAYS that it did: the value was
    // computed for the person rather than stated by them (#846). This is the
    // create-side half of the #342 assertion the first test in this file makes on an
    // edit, where a stored link is marked the other way.
    const chip = page.getByTestId("activity-fact-equipment");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-fact-state", "stated");
    await expect(chip).toHaveAttribute("data-suggested", "1");

    // The create-save has landed and nothing is outstanding, so any dirtiness after
    // this line belongs to the gear edit. Not "wait for the previous check to fade" —
    // the form is stating that it has nothing left to save.
    await expect(form).toHaveAttribute("data-unsaved", "false");

    // MOVE ONE: clear the link from inside the editor, then close the panel with ESC —
    // the harder of the two identical gestures (#3222). Before the open panel declared
    // itself an escape layer this key dismissed the whole editor and threw the entry
    // away.
    await chip.click();
    const select = page.getByTestId("activity-equipment-select");
    await expect(select).toBeVisible();
    await expect(page.getByTestId("activity-fact-editor")).toHaveAttribute(
      "data-panel",
      "equipment"
    );
    await settledSelect(page, select, "");
    // THE DIRTY HALF, and it is asserted HERE — the first thing after the edit, before
    // any gesture that could flush. Mutant (c) fails on this line and nowhere else.
    //
    // WHY NOT AFTER THE PANEL CLOSES, which reads better: `dirty` is transient by
    // nature. The 700ms autosave debounce starts at this edit, so a save lands shortly
    // after and the marker returns to "false" of its own accord — that return is
    // asserted below, and it is the half that must be read with the panel already shut.
    // Reading "true" late would be reading it after the state it names has passed.
    //
    // THE BUDGET, MEASURED HERE rather than assumed, because the next lane to assert
    // dirtiness (#3335, #3336, #3349, #3350) will want the number: the marker dwells at
    // "true" for 777ms (the 700ms debounce plus a ~77ms save round-trip), and this
    // assertion's first poll lands 30ms after the edit. ~26x margin, and a starved box
    // fails RED here rather than passing for the wrong reason. If that margin ever gets
    // thin, arm a `waitForFunction` BEFORE the edit — it polls inside the page, so it
    // cannot be outrun by a stalled test runner — and accept the worse failure message.
    await expect(form).toHaveAttribute("data-unsaved", "true");
    // Pressed on the PANEL rather than on the <select>: a native select has its own
    // Escape behaviour, and this is a question about the editor.
    await page.getByTestId("activity-fact-editor").press("Escape");

    // Presence first — the chips are back, and the fact with nothing to state is a
    // "+ equipment" PROMPT rather than a dashed missing essential, because a session
    // with no gear is complete. Only then is the <select>'s absence read, at a settled
    // point rather than left to retry its own way to green.
    await expect(chip).toHaveText(/equipment/);
    await expect(page.getByTestId("activity-form")).toBeVisible();
    await expect(select).toHaveCount(0);
    // Focus came back to the chip that opened the editor (#3311), not to <body>.
    await expect(chip).toBeFocused();

    // AND THE FORM SAVED IT BY ITSELF. Nothing has been touched since the edit except
    // an Escape that closed the panel — no Done, no Close, nothing that flushes — so
    // the marker returning to "false" with the editor STILL OPEN is the debounced
    // autosave carrying a value whose panel is gone.
    //
    // Read with the form open on purpose. #3347 first wrote its dirty assertion after
    // the editor had closed, and mutant (c) sailed through it: `requestClose` flushes
    // unconditionally, so a value that reaches the row on the close path says nothing
    // about whether the form ever counted it as a change.
    await expect(form).toHaveAttribute("data-unsaved", "false");

    // MOVE TWO: pick a gear from the prompt and close with DONE — the other half of the
    // same gesture, so neither door is the only one that works.
    await chip.click();
    await expect(select).toBeVisible();
    const target = select.locator("option", { hasText: "E2E Registry Bike" });
    await expect(target).toHaveCount(1);
    const targetValue = await target.getAttribute("value");
    expect(targetValue).toBeTruthy();
    await settledSelect(page, select, targetValue!);
    // The picking door counts as a change too, not just the clearing one — same
    // reasoning and same placement as MOVE ONE's assertion.
    await expect(form).toHaveAttribute("data-unsaved", "true");
    await page.getByTestId("activity-fact-editor-done").click();

    await expect(chip).toContainText("E2E Registry Bike");
    // Chosen, not suggested: the marking flips the moment the person answers.
    await expect(chip).toHaveAttribute("data-suggested", "0");
    await expect(select).toHaveCount(0);
    // Saved by itself again, editor still open — Done closes the PANEL, not the form,
    // so nothing here flushed either.
    await expect(form).toHaveAttribute("data-unsaved", "false");

    // Closing flushes any pending auto-save before the editor goes (requestClose awaits
    // flushBeforeClose, THEN calls onClose), so the editor being GONE is the settle
    // point for the write — a real event to await rather than a duration to budget for.
    //
    // hydratedClick and NOT settledClick, and the difference is the point of this
    // control: Close posts only when a save is still outstanding. Measured here — the
    // debounce had usually already landed, so settledClick timed out waiting for a POST
    // that correctly never came, on a click that had in fact closed the editor.
    //
    // The control is "Close" and not "Done": a create-mode session on today with
    // savable content and no end time offers "Finish workout" in the primary slot
    // (#1124), and Close is the plain dismissal beside it.
    await hydratedClick(
      page,
      page
        .getByTestId("activity-form-footer")
        .getByRole("button", { name: "Close", exact: true })
    );
    await expect(page.getByTestId("activity-form")).toHaveCount(0);

    // The payoff: gear chosen in a panel that was closed before the save reaches the
    // stored row. Read back off the canonical activity page, through the server.
    await page.goto("/training?tab=log");
    const row = page
      .getByRole("main")
      .getByTestId("history-row")
      .filter({ hasText: title })
      .first(); // first-ok: this run's uniquely-titled probe activity
    await expect(row).toBeVisible();
    await followLink(
      page,
      row.getByRole("link", { name: title, exact: true }),
      /\/training\/activity\/\d+$/
    );
    const card = page.getByTestId("training-activity-page");
    await expect(card.getByTestId("activity-gear")).toContainText(
      "E2E Registry Bike"
    );

    // Cleanup: the probe session, from its own editor.
    await hydratedClick(page, card.getByTestId("activity-page-edit"));
    await deleteActivityFromForm(page);
    await page.goto("/training?tab=log");
    await expect(
      page
        .getByRole("main")
        .getByTestId("history-row")
        .filter({ hasText: title })
    ).toHaveCount(0);
  } finally {
    assertNoStrandedDrafts(workerDbPath(), SHARED_PROFILE_DRAFT_SCOPE);
  }
});

// ---- #3349: the PER-PART equipment row states its conclusion ---------------
//
// The session-level chip above is one fact on one form. This one repeats per exercise,
// which is what made the old row expensive: six-plus controls and a "Manage equipment"
// link on every part of a five-lift session. What needs a browser rather than a code
// read is the ONE-PER-FORM claim — it is a property of two parts rendered together, and
// of the editor state living above both of them, not of either component alone.
//
// Fixture ownership (docs/internals/e2e-hygiene.md): the probe carries a unique per-run
// suffix and is deleted at the end. It is a live draft on the shared profile from its
// first auto-save, so its disposal cannot sit only on the happy path.
const PART_GEAR_PREFIX = "Part gear probe";

test("a strength part states its implement, and the registry door is one per form (#3349)", async ({
  page,
}) => {
  test.slow(); // local next dev compiles /training on first hit
  const stamp = `${Date.now()}`; // clock-ok: unique-name suffix for this run's probe activity, never a stored timestamp
  const title = `${PART_GEAR_PREFIX} ${stamp}`;
  // The form's own dirty marker (#3351) — readable at any moment, so nothing here waits
  // on the `Saved ✓` check to fade. See the #3334 test above for the measured budget.
  const form = page.getByTestId("activity-form");
  const chips = page.getByTestId("strength-equipment-chip");
  const doors = page.getByTestId("strength-equipment-link");

  try {
    await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed
    await hydratedClick(page, page.getByTestId("training-log-add-activity"));
    await page.getByRole("textbox", { name: "Activity name" }).fill(title);

    // A BARE VARIANT BASE. "Curl" cannot be saved until an implement is picked
    // (needsEquipment), so the row says so with the primitive's dashed MISSING chip —
    // and says it NOW, not once a save has already been refused.
    //
    // TYPED AND NOT PICKED, on purpose. `selectPartName` never leaves a picked base
    // bare — it resolves to the last-used variant, or to the group's first equipment
    // — so a pick cannot reach this state at all. Typing does, and so does a stored
    // row that arrived any other way, which is the case the save gate exists for.
    const firstName = page.getByPlaceholder(/What did you do/);
    await firstName.fill("Curl");
    // The dropdown is open over the row below; Escape dismisses it without committing
    // a pick, which is exactly what this state needs.
    await firstName.press("Escape");
    await expect(firstName).toHaveValue("Curl");
    await expect(chips).toHaveCount(1);
    await expect(chips).toHaveText("Pick equipment");
    await expect(chips).toHaveAttribute("data-fact-state", "missing");
    // NOTHING ELSE IS ON SCREEN. This is the row's whole complaint: these three were
    // drawn on every exercise, unasked.
    await expect(doors).toHaveCount(0);
    await expect(page.getByTestId("strength-equipment-select")).toHaveCount(0);
    await expect(page.getByTestId("strength-equipment-add")).toHaveCount(0);

    // One tap behind: the picker AND its door.
    await chips.click();
    await expect(page.getByTestId("strength-equipment-editor")).toHaveAttribute(
      "data-panel",
      "equipment"
    );
    await expect(doors).toHaveCount(1);
    await page.getByRole("button", { name: "Barbell", exact: true }).click();
    await expect(firstName).toHaveValue("Barbell Curl");
    // The dirty half, asserted FIRST — `dirty` is transient, and reading it after the
    // panel closes would be reading it after the state it names has passed.
    await expect(form).toHaveAttribute("data-unsaved", "true");
    await page.getByTestId("strength-equipment-done").click();

    // The conclusion, stated; the door gone with the panel; focus back on the chip that
    // opened it (#3311) rather than on <body>.
    await expect(chips).toHaveText("Barbell");
    await expect(chips).toHaveAttribute("data-fact-state", "stated");
    await expect(chips).toBeFocused();
    await expect(doors).toHaveCount(0);

    // Complete the part so the form auto-saves and a second one can be added.
    await settledFill(page, page.getByTestId("set1-weight"), "20");
    await settledFill(page, page.getByTestId("set1-reps"), "10");
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeVisible({ timeout: AUTOSAVE_ROW_MS });
    await expect(form).toHaveAttribute("data-unsaved", "false");

    await page.getByRole("button", { name: "+ Add another activity" }).click();
    const secondName = page.getByPlaceholder(/Add another activity/);
    await secondName.fill("Barbell Bench Press");
    // The composed variant is a catalog name but not a picker OPTION (the options list
    // bases; the concrete variants are reached through the equipment chips), so this is
    // the free-text "Use …" row — which `pickPartName` still resolves as a known lift.
    await comboboxRows(page)
      .filter({ hasText: "Barbell Bench Press" })
      .first() // first-ok: transient combobox list this spec just opened by typing the name
      .click();
    await expect(secondName).toHaveValue("Barbell Bench Press");

    // TWO PARTS, TWO CONCLUSIONS, AND STILL NO DOOR. The second part's implement comes
    // from the lift's own name rather than from a pick, and it is stated the same way.
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toHaveText("Barbell"); // nth-ok: the part this spec just added
    await expect(chips.nth(0)).toHaveText("Barbell"); // nth-ok: the Curl part, still stating its own
    await expect(doors).toHaveCount(0);

    // THE ONE-PER-FORM CLAIM. Opening the second part's picker closes the first's, so
    // the door the old row repeated once per exercise exists exactly once whichever
    // part is being edited.
    await chips.nth(0).click(); // nth-ok: the Curl part this spec entered first
    await expect(doors).toHaveCount(1);
    await expect(chips).toHaveCount(1);
    await chips.nth(0).click(); // nth-ok: with the Curl chip replaced by its panel, the one remaining chip is the Bench Press part
    await expect(doors).toHaveCount(1);
    await expect(page.getByTestId("strength-equipment-editor")).toHaveCount(1);

    await deleteActivityFromForm(page);
  } finally {
    assertNoStrandedDrafts(workerDbPath(), SHARED_PROFILE_DRAFT_SCOPE);
  }
});
