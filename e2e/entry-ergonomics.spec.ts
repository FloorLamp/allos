import { test, expect } from "./fixtures";
import { CONTROL_BOX_PX } from "@/lib/tap-floor-tokens";
import { type Page } from "@playwright/test";
import { openCommandPalette } from "./nav";
import {
  closePartOptions,
  comboboxRows,
  deleteActivityFromForm,
  followLink,
  hydratedClick,
  openCombobox,
  openPartOptions,
  expectPhoneTapTargets,
  settledBoxes,
  settledFill,
} from "./helpers";
import {
  diffRecentActivities,
  snapshotRecentActivities,
} from "./shared-profile-guard";
import { frozenNow } from "./worker-env";

// Pick an activity in the editor's exercise combobox. The option button's text
// varies with the input state: a partial filter lists options as the name plus a
// muscle badge ("Barbell Bench Press" + "Chest"), while an EXACT typed match
// collapses the dropdown to a single 'Use "Barbell Bench Press"' button (curly
// quotes around the name). Neither shape carries the bare name as an exact text
// node or accessible name, so match by SUBSTRING — hasText covers both shapes,
// and badge-less cardio options too. (Ground truth from the aria snapshot of the
// live component; see PR #547 review thread.)
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await comboboxRows(page)
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

// Issue #29: data-entry ergonomics — the three affordances end-to-end against the
// seeded DB.
//
//  1. Command-palette inline quick-log: `weight 84.3` parses (pure
//     parseQuickLog), previews, and Enter commits it through paletteQuickLog →
//     insertBodyMetric (the same write the Body form uses).
//  2. Repeat-last: a card's "Duplicate activity" opens a CREATE form pre-filled from the
//     stored activity; the seeded, complete session auto-saves as a NEW row.
//  3. Bulk table delete + undo: selecting rows in Data → Manage deletes them
//     through captureDelete (per row) and one "Undo" restores the whole batch.

test("command palette 'weight 84.3' logs a body metric (#29)", async ({
  page,
}) => {
  await page.goto("/");

  // Open the palette via the retrying helper — a raw Ctrl-K fired inside the
  // hydration window is swallowed (issue #500/#501; e2e/nav.ts).
  const input = await openCommandPalette(page);

  // Typing the quick-log syntax surfaces a preview row; the seed login is kg.
  await input.fill("weight 84.3");
  const preview = page.getByTestId("palette-quicklog");
  await expect(preview).toContainText("84.3 kg");

  // Enter commits it — the success toast is the end-to-end write confirmation.
  // The action's response carries the revalidated dashboard render, which can
  // outlast the default 5s on a loaded runner; a named ceiling, not a sleep — the
  // History-table assertion below re-proves the write either way.
  await input.press("Enter");
  await expect(page.getByText("Logged weight 84.3 kg.")).toBeVisible({
    timeout: 20_000,
  });

  // …and it lands in the body census History table (kg, so the value shows
  // as-is). Assert against the weight cell's stable testid — rows are date-desc,
  // so today's just-logged entry is the first one — rather than free text, which
  // also matches the (visually hidden) chart axis/point labels.
  await page.goto("/trends");
  const weightCell = page.getByTestId("body-weight-cell").first(); // first-ok: the most-recent body-weight cell (newest-first) — order-agnostic
  await expect(weightCell).toContainText("84.3");
});

test("'Duplicate activity' pre-fills a create form that saves a new activity (#29)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  // The e2e seed plants a manual "Training Log merge keeper" activity; repeat it.
  const titleRows = page
    .getByTestId("history-row")
    .filter({ hasText: "Training Log merge keeper" });
  await expect(titleRows.first()).toBeVisible(); // first-ok: the "Training Log merge keeper" row (filtered) — one match
  const before = await titleRows.count();

  // Open the canonical record, then use its overflow (⋯) menu → "Duplicate activity".
  await followLink(
    page,
    titleRows
      .first() // first-ok: the "Training Log merge keeper" row (filtered) — one match
      .getByRole("link", {
        name: "Training Log merge keeper",
        exact: true,
      }),
    /\/training\/activity\/\d+$/
  );
  await page
    .getByTestId("training-activity-page")
    .getByRole("button", { name: "Activity actions" })
    .click();
  await expect(page.getByTestId("delete-activity")).toBeVisible();
  await page.getByTestId("duplicate-activity").click();

  // The editor opens pre-filled — its heading carries the source title.
  await expect(page.getByLabel("Activity name")).toHaveValue(
    "Training Log merge keeper"
  );
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // The prefilled, complete session auto-saves as a NEW row (dated today). Return
  // to the log to verify that a second row with the same title was created.
  await page.goto("/training?tab=log");
  await expect(titleRows).toHaveCount(before + 1);

  // Clean up the row this test just created through its canonical record. The e2e
  // DB is shared across specs (the harness seeds once), and a lingering today-dated
  // activity would (a) collide with the
  // training-log-merge fixture's "Training Log merge keeper" title and (b) add a new "Today"
  // day-group that shifts the training log's visible-day window, throwing off the
  // absolute card counts in training-log-merge / undo-delete. Restoring the seed state
  // here keeps those specs order-independent.
  await followLink(
    page,
    titleRows
      .first() // first-ok: the just-created duplicate is today's newest matching row
      .getByRole("link", {
        name: "Training Log merge keeper",
        exact: true,
      }),
    /\/training\/activity\/\d+$/
  );
  await hydratedClick(
    page,
    page.getByRole("button", { name: "Activity actions" })
  );
  // Through the shared discard (#3454): the count below is read after a hard
  // navigation, which re-renders the feed from the SERVER — so a DELETE still in
  // flight leaves the row in the HTML and `toHaveCount` then retries against a
  // document that will never change. The row-menu delete raises the same
  // "Activity deleted." toast the editor footer's does.
  await deleteActivityFromForm(page, {
    trigger: page.getByTestId("delete-activity"),
  });
  await page.goto("/training?tab=log");
  await expect(titleRows).toHaveCount(before);
});

test("Training Log houses its primary in the header and keeps secondary actions with search", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  // The shared app shell uses the available desktop width instead of stopping at
  // the old 6xl/7xl caps. The 3xl ultra-wide cap remains separate.
  const contentContainer = page.getByTestId("app-content-container");
  expect((await contentContainer.boundingBox())!.width).toBeGreaterThan(1280);
  await page.setViewportSize({ width: 1280, height: 720 });

  // THE CADENCE STRIP AND THE WEEK SUMMARY LEFT THIS TAB (#4079, named
  // retirements): Overview's This week card owns the week's session count and the
  // active-days band, under the page's one week definition. Asserted as ABSENCE
  // here and as presence there — a strip that renders in two places is the
  // duplication the recomposition removed.
  await expect(page.getByTestId("training-log-active-days")).toHaveCount(0);
  await expect(page.getByTestId("training-log-week-summary")).toHaveCount(0);
  // …and the converse, in the same test, because an absence assertion passes both
  // on the tree that moved the strip and on the tree that lost it.
  await page.goto("/training?tab=overview");
  await expect(
    page.getByTestId("training-week").getByTestId("training-log-active-days")
  ).toBeVisible();
  await page.goto("/training?tab=log");

  const actions = page.getByTestId("training-log-actions");
  const addActivity = page.getByTestId("training-log-add-activity");
  const button = page.getByTestId("repeat-last");
  await expect(actions).toContainText("Repeat last");
  await expect(actions).toContainText("Start workout");
  await expect(addActivity).toBeVisible();
  await expect(addActivity).toHaveAccessibleName("Add activity");
  await expect(button).toBeVisible();

  // The create is the page-header primary, and the in-page add stands down beside
  // it rather than saying the same thing twice (#4014's one-primary-kind rule).
  await expect(
    addActivity.locator(
      'xpath=ancestor::*[@data-testid="training-page-action"][1]'
    )
  ).toHaveCount(1);
  await expect(
    page.getByTestId("training-log-add-activity-inline")
  ).toBeHidden();

  // Search is a GET form now (#4079): a filtered Log is a place, so the refinements
  // are in the URL and the control is a submit rather than a debounced client
  // filter. It still shares the controls block with the type segments.
  const search = page.getByPlaceholder("Search activities or exercises…");
  await expect(
    search.locator('xpath=ancestor::*[@data-testid="training-log-controls"][1]')
  ).toHaveCount(1);
  await search.fill("Bench");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL(/[?&]q=Bench/);
  await expect(search).toHaveValue("Bench");

  // The type segments are LINKS, so the selected one is the page rather than a
  // pressed button, and one control clears every refinement at once.
  const types = page.getByRole("group", { name: "Activity type" });
  await types.getByRole("link", { name: "Strength" }).click();
  await page.waitForURL(/[?&]type=strength/);
  await expect(types.getByRole("link", { name: "Strength" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  // Scoped through `training-page`, which the STAGED copy has no ancestor of (#4890).
  // Each Suspense boundary's content lands in a `<div hidden>` on `<body>` before an
  // inline script relocates it, so through that window this testid exists twice and an
  // unscoped locator throws a strict-mode violation rather than retrying down to one.
  // The two clicks above navigate through the log's GET form, which is what puts this
  // assertion inside the streaming window; #5017's shard refresh made the wait long
  // enough under load to outlive Playwright's retry. Same one-line scoping #4833
  // applied to `training-log-search-depth.spec.ts` and `unclassified-activity.spec.ts`;
  // #4890 still owns the other twenty-one call sites.
  await page
    .getByTestId("training-page")
    .getByTestId("training-log-clear-filters")
    .click();
  await page.waitForURL(/\/training\?tab=log$/);
  await expect(types.getByRole("link", { name: "All" })).toHaveAttribute(
    "aria-current",
    "page"
  );

  // ADD SURVIVES AT 390px (#4079). The page-header primary is desktop-only and the
  // dock owns the standing quick-log, but the Log itself now carries an in-page way
  // to add — the defect was a reader standing in their own log with no door into it.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(addActivity).toBeHidden();
  const inlineAdd = page.getByTestId("training-log-add-activity-inline");
  await expect(inlineAdd).toBeVisible();
  await expectPhoneTapTargets(page, "training log inline add", [inlineAdd]);

  // The mobile nav remains through 767px, so the header primary must not reappear
  // at the earlier 640px breakpoint and create duplicate controls.
  await page.setViewportSize({ width: 700, height: 844 });
  await expect(addActivity).toBeHidden();
  await expect(inlineAdd).toBeVisible();
  await page.setViewportSize({ width: 800, height: 844 });
  await expect(addActivity).toBeVisible();
  await expect(inlineAdd).toBeHidden();
});

test("Training header confines Add activity to the Log tab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const addActivity = page.getByTestId("training-log-add-activity");
  const tabs = [
    { id: "overview", label: "Overview", present: false },
    { id: "log", label: "Log", present: true },
    { id: "analyze", label: "Analyze", present: false },
    { id: "plan", label: "Plan", present: false },
  ] as const;

  for (const tab of tabs) {
    await page.goto(`/training?tab=${tab.id}`);
    await expect(
      page.getByTestId("training-tabs").getByRole("tab", { name: tab.label })
    ).toHaveAttribute("aria-selected", "true");
    const pageAction = page.getByTestId("training-page-action");
    await expect(pageAction).toBeVisible();
    await expect(pageAction.locator("button:visible")).toHaveCount(
      tab.present ? 1 : 0
    );
    if (tab.present) {
      await expect(addActivity).toBeVisible();
      await expect(addActivity).toHaveAccessibleName("Add activity");
      await expect(
        addActivity.locator(
          'xpath=ancestor::*[@data-testid="training-page-action"][1]'
        )
      ).toHaveCount(1);
      await addActivity.click();
      await expect(page.getByPlaceholder(/What did you do/)).toBeVisible();
    } else {
      await expect(addActivity).toHaveCount(0);
    }
  }
});

test("edit mode surfaces the exercise's previous sessions (#188)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  // The seed plants recurring "Push day" strength sessions across several weeks,
  // each repeating the same lifts (Barbell Bench Press, …). Opening the NEWEST
  // one for edit — by clicking its title — must show the "Recent" reference
  // panel of prior sessions (issue #188: edit mode used to omit it entirely).
  const main = page.getByRole("main");
  const pushRow = main
    .getByTestId("history-row")
    .filter({ hasText: "Push day" })
    .first(); // first-ok: the seeded Push day session row (filtered by its title) — order-agnostic
  await expect(pushRow).toBeVisible();

  // Follow the row to its canonical page, then open the editor in EDIT mode.
  await followLink(
    page,
    pushRow.getByRole("link", { name: "Push day", exact: true }),
    /\/training\/activity\/\d+$/
  );
  await page
    .getByTestId("training-activity-page")
    .getByTestId("activity-page-edit")
    .click();

  // The editor opens on the stored session — its header carries the title.
  await expect(page.getByLabel("Activity name")).toHaveValue("Push day");

  // A strength part renders its Recent panel of prior sessions. Deliberately
  // NOT scoped to <main>: the editor mounts either in the training log's dock
  // (inside <main>) or in the body-level overlay portal — the dock registers
  // in a post-hydration effect, so a click landing before that legitimately
  // falls back to the overlay (a timing the spec must not depend on). The
  // testid cannot double-render — there is exactly one editor instance — so
  // the #206 main-scoping rule doesn't apply here.
  const panel = page.getByTestId("recent-sessions").first(); // first-ok: the recent-sessions panel (see comment on scoping) — order-agnostic
  await expect(panel).toBeVisible();
  // …and it lists at least one prior session row (self-excluded: the session
  // being edited never appears in its own Recent list).
  await expect(panel.getByRole("listitem").first()).toBeVisible(); // first-ok: asserts a session renders in the scoped Recent panel — order-agnostic presence

  // Seeded strength rows store a 60-minute duration without start/end times.
  // It remains an editable top-level session field and feeds the same estimate
  // the card shows.
  const duration = page.getByTestId("activity-duration");
  await expect(duration).toHaveValue("60");
  await expect(duration).toBeEditable();
  const dateBox = await page.locator("#activity-date").boundingBox();
  const durationBox = await duration.boundingBox();
  const startBox = await page.locator("#activity-start-time").boundingBox();
  expect(dateBox).not.toBeNull();
  expect(durationBox).not.toBeNull();
  expect(startBox).not.toBeNull();
  expect(Math.abs(durationBox!.y - dateBox!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(durationBox!.y - startBox!.y)).toBeLessThanOrEqual(2);
  const endBox = await page.locator("#activity-end-time").boundingBox();
  expect(endBox).not.toBeNull();
  const sessionControlWidths = [
    dateBox!.width,
    durationBox!.width,
    startBox!.width,
    endBox!.width,
  ];
  expect(
    Math.max(...sessionControlWidths) - Math.min(...sessionControlWidths)
  ).toBeLessThanOrEqual(2);
  await expect(page.getByTestId("date-time-fields")).not.toContainText(
    "min total"
  );
  const moreDetails = page.getByRole("button", { name: /^More details/ });
  if ((await moreDetails.getAttribute("aria-expanded")) === "false")
    await moreDetails.click();
  await expect(page.getByTestId("est-calories-input")).toHaveValue(
    /^[1-9]\d*$/
  );

  // Read-only assertion: no field was touched, so nothing auto-saves and the
  // shared seed DB is left untouched — no cleanup needed. Close the editor.
  await page.keyboard.press("Escape");
});

test("editing cardio duration updates the parent session total", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  // This seeded manual cardio row has no clock range and stores 28 minutes on
  // both its parent and visible Running component. Editing the visible field
  // must not resubmit the parent's hidden 28-minute seed.
  const row = page
    .getByTestId("history-row")
    .filter({ hasText: "Intervals" })
    .first(); // first-ok: the "Intervals" activity row (filtered by its title) — order-agnostic
  await expect(row).toBeVisible();
  // Open the canonical record and edit it there. Closing the workspace returns
  // to the same record, so the restore can use its Edit button again.
  await followLink(
    page,
    row.getByRole("link", { name: "Intervals", exact: true }),
    /\/training\/activity\/\d+$/
  );
  const paneEdit = page
    .getByTestId("training-activity-page")
    .getByTestId("activity-page-edit");
  await paneEdit.click();

  const duration = page.getByTestId("cardio-duration");
  await expect(duration).toHaveValue("28");
  await duration.fill("35");
  await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears — order-agnostic
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("activity-summary")).toContainText("35 min");

  // Restore the shared seed row so other specs remain order-independent.
  await paneEdit.click();
  await page.getByTestId("cardio-duration").fill("28");
  await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears — order-agnostic
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("activity-summary")).toContainText("28 min");
});

test("logging a manual cardio activity auto-fills an editable estimated-calorie value (#151)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  // Open a fresh create form. The "Add activity" button lives in the Training Log
  // header inside <main>; the editor it opens mounts either in the docked pane
  // (inside <main>) or the body-level overlay portal, so the form's own fields are
  // addressed by their unique testids/roles rather than main-scoped (there is
  // exactly one editor instance — same reasoning as the #206 recent-sessions spec).
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();

  // PICK a known cardio activity from the combobox — typing the name alone doesn't
  // resolve the part TYPE, so the cardio fields (and the shared estimate field) only
  // appear after an explicit selection commits the type.
  await page.getByPlaceholder(/What did you do/).fill("Running");
  await page
    .getByRole("listbox")
    .getByRole("option", { name: "Running", exact: true })
    .click();

  // A duration makes the estimate compute (MET dataset × the seeded profile's
  // bodyweight × duration). It also makes the activity savable, so it auto-saves —
  // the draft is deleted at the end to leave the shared seed DB untouched.
  await page.getByTestId("cardio-duration").fill("30");
  expect(
    await page
      .getByTestId("cardio-distance")
      .evaluate((input) =>
        Array.from((input as HTMLInputElement).labels ?? []).some((label) =>
          label.textContent?.includes("Distance")
        )
      )
  ).toBe(true);
  expect(
    await page
      .getByTestId("cardio-duration")
      .evaluate((input) =>
        Array.from((input as HTMLInputElement).labels ?? []).some((label) =>
          label.textContent?.includes("Duration")
        )
      )
  ).toBe(true);

  // The estimated-calorie field appears, marked "(estimated)", auto-filled with a
  // positive number inside the shared optional-details disclosure.
  await page.getByRole("button", { name: /^More details/ }).click();
  const field = page.getByTestId("est-calories-field");
  await expect(field).toBeVisible();
  await expect(field).toContainText("estimated");
  const input = page.getByTestId("est-calories-input");
  await expect(input).toHaveValue(/^[1-9]\d*$/);
  // The session equipment <select> moved BEHIND a fact chip (#3334) — same control,
  // same .input class, one disclosure away — so its editor is opened to compare it.
  // Dropping it from this set instead would quietly narrow what the assertion covers:
  // the claim is that every control in this form reads as one surface, and a control
  // that is one tap away is still in this form. The chip carries the same testid in
  // both its shapes (a stated gear name, or the "+ equipment" prompt when the recency
  // default finds nothing), so this does not depend on what profile 1 last rode.
  await page.getByTestId("activity-fact-equipment").click();
  const equipmentSelect = page.getByTestId("activity-equipment-select");
  await expect(equipmentSelect).toBeVisible();
  const comparableControls = [
    page.getByTestId("cardio-duration"),
    input,
    equipmentSelect,
    page.getByRole("button", { name: "Easy", exact: true }),
  ];
  const comparableStyles = await Promise.all(
    comparableControls.map((control) =>
      control.evaluate((node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, height: style.height };
      })
    )
  );
  expect(new Set(comparableStyles.map((style) => style.background)).size).toBe(
    1
  );
  expect(new Set(comparableStyles.map((style) => style.height)).size).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const intensityTargets = ["Easy", "Moderate", "Hard"].map((name) =>
    page.getByRole("button", { name, exact: true })
  );
  await expectPhoneTapTargets(page, "activity intensity", intensityTargets, {
    disjoint: true,
  });
  await hydratedClick(page, intensityTargets[2]);
  await expect(intensityTargets[2]).toHaveAttribute("aria-pressed", "true");
  // Back to the chips, so the rest of this test drives the form's normal shape.
  await page.getByTestId("activity-fact-editor-done").click();
  await expect(page.getByTestId("activity-fact-equipment")).toBeVisible();

  // It's editable — the user can override the auto value.
  await input.fill("123");
  await expect(input).toHaveValue("123");

  // Clean up: delete the just-created activity from the still-open editor. The
  // Delete button only appears once the auto-save has created the row, so waiting on
  // it also confirms the activity persisted. Restores the seed for later specs.
  //
  // Through the shared discard (#3454) — nothing follows it here, so without a
  // settle the test ENDS while the DELETE is in flight and the shared-profile
  // teardown guard reads the draft on its way out.
  await deleteActivityFromForm(page);
});

test("the activity form keeps workout entry primary and context visible across breakpoints", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  const pushRow = page
    .getByRole("main")
    .getByTestId("history-row")
    .filter({ hasText: "Push day" })
    .first(); // first-ok: the seeded Push day session row (filtered by its title) — order-agnostic

  // The row opens its canonical page; Edit always uses the shared activity
  // workspace rather than re-parenting the form into the Training Log.
  await followLink(
    page,
    pushRow.getByRole("link", { name: "Push day", exact: true }),
    /\/training\/activity\/\d+$/
  );
  await page
    .getByTestId("training-activity-page")
    .getByTestId("activity-page-edit")
    .click();
  const workspace = page.getByTestId("activity-workspace");
  const drawer = page.getByTestId("activity-overlay-panel");
  await expect(workspace).toBeVisible();
  await expect(drawer).toBeVisible();
  const header = page.getByTestId("activity-form-header");

  // The single visible title is editable in place; there is no duplicate Name
  // field beneath it. Its desktop header stays with a long docked form.
  const activityTitle = page.getByLabel("Activity name");
  await expect(activityTitle).toHaveValue("Push day");
  expect(
    await activityTitle.evaluate((input) => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return false;
      const style = getComputedStyle(input);
      context.font = style.font;
      return (
        input.clientWidth >=
        context.measureText("Afternoon Shoulders Workout").width + 8
      );
    })
  ).toBe(true);
  await activityTitle.focus();
  expect(
    await activityTitle.evaluate(
      (input) => getComputedStyle(input).boxShadow !== "none"
    )
  ).toBe(true);
  await expect(page.getByText("Name", { exact: true })).toHaveCount(0);
  await expect(header).toBeVisible();
  expect(await header.evaluate((node) => getComputedStyle(node).position)).toBe(
    "sticky"
  );
  // The workspace header keeps a stable top and bottom inset.
  await expect(header).toHaveCSS("padding-bottom", "20px");

  // Workout rows use separators instead of nested cards, session metadata is
  // grouped, and optional metadata starts behind one disclosure.
  await expect(
    page.getByRole("heading", { name: "Workout", exact: true })
  ).toHaveClass("sr-only");
  const part = page.getByTestId("activity-part").first(); // first-ok: asserts an activity-part renders — order-agnostic presence
  await expect(part).not.toHaveClass(/rounded/);
  await page.evaluate(() => window.scrollTo(0, 0));
  const formBox = await page.getByTestId("activity-form").boundingBox();
  const partBox = await part.boundingBox();
  expect(formBox).not.toBeNull();
  expect(partBox).not.toBeNull();
  expect(partBox!.x).toBeLessThan(formBox!.x);
  expect(partBox!.x + partBox!.width).toBeGreaterThan(
    formBox!.x + formBox!.width
  );
  const headerBox = await header.boundingBox();
  const drawerBox = await drawer.boundingBox();
  const viewport = page.viewportSize();
  expect(headerBox).not.toBeNull();
  expect(drawerBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(drawerBox!.x + drawerBox!.width).toBe(viewport!.width);
  expect(drawerBox!.width).toBeLessThan(viewport!.width);
  // The drawer itself grows with the long form. Its surface must continue behind
  // content below the first viewport instead of letting the form spill over a
  // viewport-height background.
  expect(drawerBox!.height).toBeGreaterThan(viewport!.height);
  expect(headerBox!.x).toBe(partBox!.x);
  expect(headerBox!.x + headerBox!.width).toBe(partBox!.x + partBox!.width);
  expect(headerBox!.y).toBeLessThanOrEqual(drawerBox!.y + 2);

  // The workspace owns the scroll; the sticky form header stays at its top.
  const editorScroll = workspace;
  await editorScroll.evaluate((node) => {
    node.scrollTop = 100;
  });
  const [scroller, stickyHeader] = await settledBoxes([editorScroll, header]);
  expect(stickyHeader.y - scroller.y).toBeLessThanOrEqual(1);
  await editorScroll.evaluate((node) => {
    node.scrollTop = 0;
  });
  const standardInputs = [
    page.getByRole("combobox", { name: "Activity" }).first(), // first-ok: the Activity combobox on the log form — order-agnostic
    page.locator("#activity-date"),
    page.locator("#activity-start-time"),
    page.locator("#activity-end-time"),
  ];
  const inputStyles = await Promise.all(
    standardInputs.map((input) =>
      input.evaluate((node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, height: style.height };
      })
    )
  );
  expect(new Set(inputStyles.map((style) => style.background)).size).toBe(1);
  expect(inputStyles.map((style) => style.height)).toEqual(
    inputStyles.map(() => inputStyles[0].height)
  );
  const activityInput = standardInputs[0];
  const committedActivity = await activityInput.inputValue();
  const identityIcon = header.getByTestId("activity-icon");
  const committedIcon = await identityIcon.getAttribute("data-icon");
  await activityInput.fill(`${committedActivity} changed`);
  await expect(identityIcon).toHaveAttribute("data-icon", committedIcon!);
  await pickActivity(page, committedActivity);
  await expect(page.locator('label[for="activity-date"]')).toHaveText("Date");
  await expect(page.locator('label[for="activity-start-time"]')).toHaveText(
    "Start"
  );
  await expect(page.locator('label[for="activity-end-time"]')).toHaveText(
    "End"
  );
  // The strength editor states this part's facts (#3349). This used to reach straight
  // for `per-side-control`; the options controls are one tap behind the row now, and
  // what belongs in this breakpoint sweep is that the ROW rendered — the behaviour of
  // the controls inside it is pinned by the two dedicated tests below and by the
  // `lib/__tests__/activity-part-facts.test.ts` table.
  await expect(page.getByTestId("part-fact-row").first()).toBeVisible(); // first-ok: asserts a part fact row renders — order-agnostic presence
  const sessionDetails = page.getByTestId("session-details");
  await expect(sessionDetails).toBeVisible();
  await expect(sessionDetails).toHaveCSS("border-top-width", "0px");
  expect(
    await page
      .getByTestId("date-time-fields")
      .evaluate(
        (node) => getComputedStyle(node).gridTemplateColumns.split(" ").length
      )
  ).toBe(2);
  const startLabelBox = await page
    .getByTestId("time-range-fields")
    .getByText("Start", { exact: true })
    .boundingBox();
  const startShortcutBox = await page
    .getByTestId("start-time-shortcut")
    .boundingBox();
  expect(startLabelBox).not.toBeNull();
  expect(startShortcutBox).not.toBeNull();
  expect(
    startShortcutBox!.x - (startLabelBox!.x + startLabelBox!.width)
  ).toBeLessThan(16);
  await expect(
    page.getByRole("button", { name: /^More details/ })
  ).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("More details", { exact: true })).toHaveCSS(
    "text-transform",
    "uppercase"
  );
  await expect(page.getByTestId("more-details-summary")).toContainText("kcal");
  await expect(page.getByTestId("more-details-chevron")).not.toHaveClass(
    /rotate-90/
  );
  await page.getByRole("button", { name: /^More details/ }).hover();
  expect(
    await page
      .getByTestId("more-details-chevron")
      .evaluate((node) => getComputedStyle(node).filter)
  ).not.toBe("none");

  // At the mobile breakpoint the same workspace becomes full-screen and keeps
  // the in-progress form mounted.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(workspace).toBeVisible();
  const mobileDrawerBox = await drawer.boundingBox();
  expect(mobileDrawerBox).not.toBeNull();
  expect(mobileDrawerBox!.x).toBe(0);
  expect(mobileDrawerBox!.width).toBe(390);
  // The seeded Push day's first lift is a uniform run, so since #3336 it opens as the
  // compact sentence. Expand it, so the first-match locator below still means THE
  // FIRST PART's schema row rather than whichever later part happens to be varied —
  // the assertions
  // would pass either way, and would have quietly stopped describing the card the rest
  // of this test measures.
  await hydratedClick(page, page.getByTestId("set-summary").first()); // first-ok: the first part's set summary — this test measures the first card
  const headings = page.getByTestId("set-column-headings").first(); // first-ok: the set-column headings of the card just opened — order-agnostic
  await expect(headings).toBeVisible();
  expect(
    await headings.evaluate((node) => getComputedStyle(node).position)
  ).toBe("sticky");
  const set1Weight = page.getByTestId("set1-weight").first(); // first-ok: the first set's weight input of the opened card — order-agnostic
  await expect(set1Weight).toHaveAttribute("inputmode", "decimal");
  await expect(page.getByTestId("activity-form-footer")).toHaveCSS(
    "position",
    "sticky"
  );
});

test("a fresh strength part OFFERS the coached suggestion; arriving in the field never writes it (#335/#1971)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  // Open a fresh create form (fields addressed by testid/role — see the
  // est-calories spec's note on why the editor isn't main-scoped).
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();

  // Pick a lift the seed trains repeatedly (Barbell Bench Press, weeks of
  // 60 kg → +1 kg/wk history) so a coached next-set suggestion exists.
  await pickActivity(page, "Barbell Bench Press");

  // The coached "Next set" card renders for a fresh part with history.
  await expect(page.getByText("Next set")).toBeVisible();

  // Set 1's weight shows the suggested load as a ghost PLACEHOLDER (a number,
  // not the bare "kg" unit) — the offer (#335).
  const weight = page.getByTestId("set1-weight");
  await expect(weight).toHaveAttribute("placeholder", /^\d/);

  // #1971, the regression this test exists for. Arrival is not consent: focusing
  // the field must leave it EMPTY, and the digits the lifter then types must be
  // the whole value. When set 1's onFocus applied the suggestion, tabbing in and
  // typing "60" produced "77.560" and clicking in produced "77.605" — silently,
  // at every typing speed. Drive it the way a person does: focus, then type.
  await weight.focus();
  await expect(weight).toHaveValue("");
  await page.keyboard.type("60", { delay: 40 });
  await expect(weight).toHaveValue("60");
  // The suggestion did not seed reps behind the lifter's back either.
  await expect(page.getByTestId("set1-reps")).toHaveValue("");

  // The offer is still one tap away: "Use" fills weight + reps, completing the
  // set so it auto-saves — the Delete button appearing confirms the persist.
  await page.getByTestId("set1-weight").fill("");
  await page
    .getByTestId("next-set-card")
    .getByRole("button", { name: "Use" })
    .click();
  await expect(weight).toHaveValue(/^\d/);
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // Clean up the auto-saved draft so the shared seed DB is left untouched.
  //
  // THE SITE #3454 WAS FILED FOR. This ended on the confirm's Delete and asserted
  // nothing after it, so the `noSharedProfileLeak` teardown guard read the worker
  // database while the DELETE was still in flight — 2 failures in 4 runs on an
  // unmodified `origin/main`, and a red in `e2e (4)` on PR #3464, whose diff is
  // entirely `lib/` number readers.
  await deleteActivityFromForm(page);
});

test("a cardio part derives avg speed AND pace from distance + duration (#336)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();

  // Running requires a distance field; pick it so both Distance and Duration show.
  await pickActivity(page, "Running");

  // 5 km in 25 min → 12 km/h, pace 5:00 /km (seeded login is metric).
  await page.getByTestId("cardio-duration").fill("25");
  await page.getByTestId("cardio-distance").fill("5");

  // Both the average speed AND the newly-added pace line render from the same
  // inputs (#336) — pace is what runners actually think in.
  await expect(page.getByText(/Avg speed:/)).toContainText("12");
  await expect(page.getByText(/Pace:/)).toContainText("5:00");

  // Clean up the auto-saved draft (a duration makes it savable). Through the shared
  // discard (#3454) — nothing follows it, so the teardown guard is what reads next.
  await deleteActivityFromForm(page);
});

test("a lone sport logged with Start/End auto-fills its Duration and shows real minutes (#791)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  // Open a fresh create form (fields addressed by testid/role — see the
  // est-calories spec's note on why the editor isn't main-scoped).
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();

  // Pick a curated SPORT. Sports are duration-only (no distance field), which is
  // exactly why a clock-only save that never reached the component aggregated as a
  // 0-minute session and showed nothing (#791).
  await pickActivity(page, "Tennis");

  // Give it a Start/End clock span but leave Duration untouched — a 55-minute span.
  await page.locator("#activity-start-time").fill("08:00");
  await page.locator("#activity-end-time").fill("08:55");

  // The clock minutes LAND on the component's Duration field as an editable VALUE
  // (not a grey placeholder that never saves) — the crux of the fix.
  const duration = page.getByTestId("cardio-duration");
  await expect(duration).toHaveValue("55");
  await expect(duration).toBeEditable();

  // A duration makes the activity savable, so it auto-saves — the Delete button
  // appears only once the row persisted (confirming the 55 landed on the DB
  // component, through the real saveActivity path).
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // It surfaces on the Sport analysis view with its real minutes — the seed's own
  // Tennis session is 90 min ("1h 30m"), so a "55 min" session cell is proof of
  // THIS log, not the fixture.
  await page.goto("/training?tab=analyze&kind=sport&item=Tennis");
  await expect(
    page.getByRole("cell", { name: "55 min", exact: true }).first() // first-ok: the 55-min cardio cell THIS spec logged — order-agnostic
  ).toBeVisible();

  // Clean up the row this test created so the shared seed DB is left untouched:
  // follow its generated-title link to the canonical page, edit, and delete.
  await page.goto("/training?tab=log");
  const newRow = page
    .getByTestId("history-row")
    .filter({ hasText: "Tennis" })
    .filter({ hasText: "55 min" })
    .first(); // first-ok: the Tennis/55-min row THIS spec just logged (filtered) — one match
  await expect(newRow).toBeVisible();
  await followLink(
    page,
    newRow.getByRole("link").first(), // first-ok: the canonical generated-title link precedes any component links in this uniquely filtered row
    /\/training\/activity\/\d+$/
  );
  await page
    .getByTestId("training-activity-page")
    .getByTestId("activity-page-edit")
    .click();
  // #3454's SECOND measured site. The `toHaveCount(0)` below retries, but it retries
  // against the HTML a hard navigation already fetched — so a DELETE that had not
  // landed when the `goto` was issued leaves the row in a document that never
  // updates, and the retry can only run the clock out. Red once in a batch on PR
  // #3456, green on an identical re-run, 6.5s alone.
  await deleteActivityFromForm(page);
  await page.goto("/training?tab=log");
  await expect(newRow).toHaveCount(0);
});

test("the command palette offers 'Repeat last activity' when history exists (#337)", async ({
  page,
}) => {
  await page.goto("/"); // the seed has plenty of logged activities

  // Retrying open — see the #29 spec above (hydration-window swallow).
  const input = await openCommandPalette(page);

  // Typing "repeat" surfaces the new palette command (gated on a last activity
  // existing — the seed guarantees one).
  await input.fill("repeat");
  await expect(page.getByText("Repeat last activity")).toBeVisible();

  // Read-only: close without executing so no draft is created.
  await page.keyboard.press("Escape");
});

test("strength set controls step, clamp, and toggle without losing their phone geometry (#337/#338/#1524)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();

  // Barbell Bench Press is an upper-body lift → a 2.5 (kg) step for the seeded
  // metric login.
  await pickActivity(page, "Barbell Bench Press");

  // The intent controls moved behind the part's fact chips (#3349) — same testids,
  // one tap away. The chip that opens them here is the trailing affordance, because a
  // fresh part has declared no target.
  await openPartOptions(page, 0);
  const toFailure = page.getByTestId("to-failure-checkbox");
  await page.getByText("To failure", { exact: true }).click();
  await expect(toFailure).toBeChecked();
  await expect(page.getByTestId("to-failure-control")).toHaveClass(
    /bg-brand-600/
  );
  // …and the row now STATES it. The chip is the conversion's whole point: the
  // conclusion is on screen without the control that produced it.
  await closePartOptions(page);
  await expect(page.getByTestId("part-fact-intent")).toHaveText("to failure");

  await openPartOptions(page, 0);
  await page.getByText("To failure", { exact: true }).click();
  await expect(toFailure).not.toBeChecked();
  await closePartOptions(page);

  // AND THE ROW STATES WHAT THE FORM INHERITED. Clearing AMRAP does not empty this
  // fact: the coached suggestion carries this lift's declared scheme from last session
  // and a fresh part adopts it (#335), so the target is 8 and nobody typed it. That
  // number lived in a `w-16` number input on every exercise and was easy never to
  // read; the chip says it. The fact leaving the row entirely is the case with no such
  // history, and it is pinned on an exact fixture in
  // components/__tests__/part-fact-row.test.tsx rather than against the seed's
  // training history.
  await expect(page.getByTestId("part-fact-intent")).toHaveText(
    /^target \d+ reps$/
  );

  const weightStepper = page.getByTestId("set1-weight-stepper");
  const weightInput = page.getByTestId("set1-weight");
  await expect(weightInput).toHaveClass(/number-no-spinner/);
  await expect(weightStepper).toHaveCSS("border-top-style", "solid");
  expect(
    await weightInput.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        top: style.borderTopWidth,
        right: style.borderRightWidth,
        bottom: style.borderBottomWidth,
        left: style.borderLeftWidth,
      };
    })
  ).toEqual({ top: "0px", right: "1px", bottom: "0px", left: "1px" });
  const weightBox = await weightInput.boundingBox();
  expect(weightBox).not.toBeNull();
  expect(weightBox!.width).toBeGreaterThanOrEqual(64);

  const repsStepper = page.getByTestId("set1-reps-stepper");
  const repsInput = repsStepper.locator("input");
  await expect(repsInput).toHaveClass(/number-no-spinner/);
  await expect(repsStepper).toHaveCSS("border-top-style", "solid");
  expect(
    await repsInput.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        top: style.borderTopWidth,
        right: style.borderRightWidth,
        bottom: style.borderBottomWidth,
        left: style.borderLeftWidth,
      };
    })
    // Dividers on BOTH sides since #1524 gave reps its missing − button: the reps
    // stepper is the same − input + segment the weight one has always been.
  ).toEqual({ top: "0px", right: "1px", bottom: "0px", left: "1px" });
  const weightHeading = page.getByTestId("weight-column-heading");
  const repsHeading = page.getByTestId("reps-column-heading");
  const [weightStepperBox, repsStepperBox, weightHeadingBox, repsHeadingBox] =
    await settledBoxes([
      weightStepper,
      repsStepper,
      weightHeading,
      repsHeading,
    ]);
  expect(
    Math.abs(weightStepperBox.width - repsStepperBox.width)
  ).toBeLessThanOrEqual(1);
  for (const [heading, stepper] of [
    [weightHeadingBox, weightStepperBox],
    [repsHeadingBox, repsStepperBox],
  ]) {
    expect(
      Math.abs(heading.x + heading.width / 2 - (stepper.x + stepper.width / 2))
    ).toBeLessThanOrEqual(1);
  }

  const stepTargets = [
    "Decrease weight",
    "Increase weight",
    "Decrease reps",
    "Add a rep",
  ].map((name) => page.getByTestId("set-row-1").getByLabel(name));
  expect(await stepTargets[0].boundingBox()).toMatchObject({
    width: 28,
    height: 36,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectPhoneTapTargets(page, "strength-set steppers", stepTargets, {
    disjoint: true,
  });

  // The + stepper bumps the (empty) weight by one increment → 2.5. Only weight is
  // set, so the set stays half-filled and nothing auto-saves — no cleanup needed.
  await hydratedClick(page, stepTargets[1]);
  await expect(page.getByTestId("set1-weight")).toHaveValue("2.5");

  // Weight and RPE were symmetric (− and +) from the start; reps shipped with only
  // a +, so a mis-tapped rep count could only be fixed by editing the field by hand.
  await hydratedClick(page, stepTargets[3]);
  await hydratedClick(page, stepTargets[3]);
  await expect(repsInput).toHaveValue("2");
  await hydratedClick(page, stepTargets[2]);
  await expect(repsInput).toHaveValue("1");
  // Clamped at 0: the field empties rather than going negative, and staying at the
  // floor is a no-op.
  await hydratedClick(page, stepTargets[2]);
  await expect(repsInput).toHaveValue("");
  await hydratedClick(page, stepTargets[2]);
  await expect(repsInput).toHaveValue("");

  // Each set carries a light "W" warmup toggle (default off). Toggling flips its
  // aria-pressed state — the flag excludes the set from volume/target/records.
  const warmup = page.getByTestId("set1-warmup");
  await expect(warmup).toHaveAttribute("aria-pressed", "false");
  await hydratedClick(page, warmup);
  await expect(warmup).toHaveAttribute("aria-pressed", "true");

  // Reps returned to empty, so the set stays half-filled and nothing auto-saves.
  await page.keyboard.press("Escape");
});

test("the bilateral (per-side) reps stepper steps down too (#1524)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();

  // A unilateral lift offers "Track sides separately", which swaps the row for the
  // L/R variant and renders a reps stepper PER SIDE — the second home of the
  // missing decrement.
  await pickActivity(page, "Hammer Curl");
  await openPartOptions(page, 0); // the sides control is behind the part's fact chips (#3349)
  await page.getByText("Track sides separately", { exact: true }).click();
  await expect(page.getByTestId("per-side-checkbox")).toBeChecked();
  await closePartOptions(page);
  const downs = page.getByLabel("Decrease reps");
  await expect(downs).toHaveCount(2);
  const ups = page.getByLabel("Add a rep");
  await expect(ups).toHaveCount(2);

  const left = page.getByTestId("reps-stepper").first(); // first-ok: the per-side row this test just revealed on its own new-activity card — the left input of the pair
  await ups.first().click(); // first-ok: same per-side pair — the left side's control
  await expect(left.locator("input")).toHaveValue("1");
  await downs.first().click(); // first-ok: same per-side pair — the left side's control
  await expect(left.locator("input")).toHaveValue("");

  await page.keyboard.press("Escape");
});

test("a failed activity save surfaces an error, never a false 'Saved ✓' (#332)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  // The BEFORE reading for the row-absence assertion at the end (#4741). That claim
  // used to be a closing COMMENT and CI contradicted it twice, so it is now a diff
  // over the same snapshot the shared-profile guard reads.
  const at = frozenNow();
  const activitiesBefore = snapshotRecentActivities(at);

  // Force every saveActivity call to fail at the network layer. saveActivity runs
  // as a Server Action — a POST to the page carrying a `next-action` header; the
  // service worker passes non-GET straight through (public/sw.js), so this is an
  // ordinary browser request page.route intercepts. We ABORT it (rather than
  // fulfill a 500 — a non-flight body makes Next fall back to a full-page reload,
  // which would unmount the form before the indicator paints); an aborted fetch
  // rejects, so `await saveActivity()` throws into persist()'s failure handling.
  // Aborting *every* such POST (not just the first) guarantees no later autosave
  // can flip the form back to "Saved ✓". The #332 regression was that a save which
  // didn't persist still advanced the form to "Saved ✓"; the fix must instead show
  // the honest "Couldn’t save" indicator (the exact { ok: false } not-owned/invalid
  // branches are pinned directly at the action tier — the single-profile e2e DB
  // can't naturally produce a stale foreign id).
  //
  // AN ABORT MODELS A SAVE THAT DID NOT PERSIST, WHICH IS #332's SUBJECT — not a
  // server that ANSWERS with a rejection. The two reach the form differently:
  // `{ ok: false }` takes the `!res.ok` branch, an abort throws
  // `TypeError: Failed to fetch` into the catch and is classified retriable
  // (`activity-autosave-retriable`, measured on this case). Both end at
  // `setStatus("error")`, so both raise this indicator — which is why the case is
  // honest, and why the count below is what says the abort actually happened.
  //
  // WHAT THE HANDLER SAW, RECORDED AS IT RAN (#4741). This case has now reded three
  // times on CI, twice on diffs that cannot reach a route handler, and never once on
  // this box across 27 runs — so the one thing nobody has is the interception state
  // inside the runner's browser. Playwright can be asked afterwards for the requests
  // a PAGE made; it cannot be asked what THIS handler matched, which is the question.
  // So every field below is written by the handler as it runs, and read at the moment
  // the poll gives up. Do not delete it because the poll is green: green is when it
  // costs nothing, and the one run it has to speak for is one nobody can watch.
  let abortedActionPosts = 0;
  let routeInstalled = false;
  const seen = {
    requests: 0,
    posts: 0,
    nextActionHeaders: 0,
    postPaths: [] as string[],
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    seen.requests += 1;
    // Counted over EVERY method rather than only POST: an action arriving as
    // something this discriminator rejects is a shape that would explain a miss, and
    // a POST-scoped count could not tell that apart from no action at all.
    const nextAction = Boolean(req.headers()["next-action"]);
    if (nextAction) seen.nextActionHeaders += 1;
    if (req.method() === "POST") {
      seen.posts += 1;
      seen.postPaths.push(new URL(req.url()).pathname);
      if (nextAction) {
        abortedActionPosts += 1;
        await route.abort("failed");
        return;
      }
    }
    await route.continue();
  });
  routeInstalled = true;

  // Open a fresh create form and fill it enough to be savable (same flow as the
  // est-calories spec — see its note on why fields are addressed by testid/role).
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();
  await page.getByPlaceholder(/What did you do/).fill("Running");
  await page
    .getByRole("listbox")
    .getByRole("option", { name: "Running", exact: true })
    .click();
  // A duration makes the activity savable, so the debounced auto-save fires — and
  // hits the aborted request.
  await page.getByTestId("cardio-duration").fill("30");

  // THE FORCED FAILURE IS ASSERTED BEFORE ANYTHING IS CONCLUDED FROM IT (#4741).
  // A forced failure that does not fire makes every assertion below it a claim
  // about an ordinary successful save, and the case reads green or red for reasons
  // that have nothing to do with #332. This is a PRESENCE assertion on a counter
  // the route handler owns, so it is the same object the abort runs through, and
  // its ceiling is free: waiting longer cannot invent a POST that was never made.
  // It comes FIRST so that when this case reds, the report already says whether the
  // interception applied — the question #4741 was opened to settle.
  //
  // The report is assembled INSIDE the polled function, so the failure prints the
  // state at the poll's LAST READ rather than a reading taken afterwards.
  //
  // READ "installed" HONESTLY: `routeInstalled` is near-vacuous by construction —
  // the `await page.route(...)` above precludes false — so it is there to be visibly
  // true, not to discriminate. The halves that carry weight are `page.isClosed()`,
  // which really can be false and takes the handler with it, and `requests`, which
  // says whether an installed handler is still being REACHED. An installed handler
  // that saw zero requests is the deaf case; one that saw dozens of them, none
  // carrying a next-action header, is a different bug entirely — and today both
  // print "Received: 0" and nothing else.
  let interception = "the poll never read the handler";
  const readAbortedActionPosts = () => {
    interception =
      `route handler installed=${routeInstalled && !page.isClosed()}; ` +
      `requests seen=${seen.requests}, of them POSTs=${seen.posts}, ` +
      `carrying a next-action header=${seen.nextActionHeaders}; ` +
      `POST paths: ${seen.postPaths.join(" ") || "(none)"}`;
    return abortedActionPosts;
  };
  try {
    await expect
      .poll(readAbortedActionPosts, {
        message:
          "no Server Action POST was intercepted — the forced failure never fired, " +
          "so nothing below this line is a test of #332 (see #4741)",
      })
      .toBeGreaterThan(0);
  } catch (failure) {
    // expect.poll's `message` is fixed when the assertion is CONSTRUCTED, so this is
    // the only place the state at the miss can reach the failure line.
    throw new Error(
      `${(failure as Error).message}\n  interception at the moment of the miss: ${interception}`
    );
  }

  // The failure must surface as the error indicator (SaveStatus, aria-label
  // "Couldn’t save"), and the success check must never appear.
  // Desktop renders the active indicator in the sticky header; the mobile
  // footer copy remains in the DOM but is CSS-hidden at this breakpoint.
  await expect(
    page.locator('[aria-label="Couldn’t save"]:visible')
  ).toBeVisible();
  // EXACT: getByLabel matches accessible names by case-insensitive substring,
  // so a bare "Saved" also matches any unrelated control whose label happens to
  // contain the word — this pinned the autosave indicator only by luck.
  await expect(page.getByLabel("Saved", { exact: true })).toHaveCount(0);

  // NOTHING PERSISTED — ASSERTED, NOT ASSUMED (#4741). One reading, taken at a
  // moment the two assertions above have made settled: the save has been attempted,
  // intercepted and answered on screen. No poll — a retrying absence check would
  // wait out exactly the window a late write lands in.
  //
  // It reuses the guard's own snapshot/diff rather than a second query, and does NOT
  // repeat its repair: `noSharedProfileLeak` (e2e/fixtures.ts) already deletes ADDED
  // rows in teardown. What this adds is ATTRIBUTION — the guard reads after the
  // context is gone, and its message cannot say which of this file's two identical
  // fixtures produced the row. "Running" + 30 min generates
  // "Afternoon 30 Min Running Session" here, and the est-calories case above builds
  // the same activity for real, so a bare guard failure names a title both cases mint.
  expect(
    diffRecentActivities(activitiesBefore, snapshotRecentActivities(at)).added,
    "the save was forced to fail, so no activity row may exist (#332/#4741)"
  ).toEqual([]);
});

test("bulk-delete rows in Data → Manage, then Undo restores them (#29)", async ({
  page,
}) => {
  await page.goto("/data?section=manage");

  // The Body metrics dataset (undoable kind = body-metric) is seeded with rows.
  const card = page.locator(".card", {
    has: page.getByRole("heading", { name: "Body metrics" }),
  });
  await expect(card).toBeVisible();
  // Remember the "(N)" count in the heading to prove a full restore later.
  const countText = async () =>
    (await card.locator("h2 span").first().textContent())?.trim(); // first-ok: the count span in the scoped card's heading — order-agnostic
  const original = await countText();
  expect(original).toBeTruthy();

  // Enter edit mode → select every row shown → delete the selection.
  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("Select all rows shown").check();
  await card.getByRole("button", { name: "Delete selected" }).click();
  // Confirm the inline "Delete N rows?" prompt.
  await card.getByRole("button", { name: "Delete", exact: true }).click();

  // One batch toast with an Undo action; click it.
  await expect(
    page.getByText(/Deleted \d+ rows? from Body metrics\./)
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();

  // The whole batch comes back (restored under new ids) — a "Restored N" toast,
  // and after a fresh render the dataset count matches where it started.
  await expect(page.getByText(/Restored \d+ rows?\./)).toBeVisible();
  await page.goto("/data?section=manage");
  await expect(card.locator("h2 span").first()).toHaveText(original!); // first-ok: the same count span in the scoped card's heading — order-agnostic
});

// #2384. The exercise picker's option list is carefully ordered — recency-decayed
// frequency over the profile's own sets (#195), today's routine slots floated to the
// front (#1115), lifts whose implement kind the profile doesn't own de-ranked (#345),
// companions of the draft's other lifts hoisted (#195) — and `allOptions` concatenates
// lifts before cardio before sports. Then the matcher sorted on string shape alone and
// kept the caller's order only as an exact-score tiebreak, so ONE keystroke discarded
// all four: a never-logged "Squash" beat every squat on `sqa`, purely because its `s`
// sits at index 0 and its name is shorter.
//
// The evidence, not a count: the base seed trains Back Squat on every Leg day (the PPL
// plan other training specs already address by name), and nothing in the app or the
// suite ever logs Squash. The assertion is a RELATIVE order plus a presence — no exact
// array and no seed-row count (#2353).
test("typing keeps the lifts you log ahead of a sport you never have (#2384)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed
  await page.getByRole("button", { name: "Add activity" }).click();

  const field = page.getByPlaceholder(/What did you do/);
  const listbox = await openCombobox(page, field);
  await settledFill(page, field, "sqa");

  // A squat leads. Option rows carry a muscle badge beside the name, so the row is
  // matched by substring rather than by an exact accessible name.
  const leadOption = listbox.getByTestId("combobox-option").first(); // first-ok: the LEADING option is the assertion
  await expect(leadOption).toHaveText(/Squat/);
  // De-rank, not hide (#345): the sport is still offered, so a first squash session
  // is exactly as reachable as it was.
  await expect(listbox.getByRole("option", { name: /^Squash/ })).toBeVisible();
});

// THE PLATE BUILDER IS AN ORDINARY DIALOG-HOST CONSUMER (#3405).
//
// It used to render its own portal, its own scrim, its own `z-60`, its own
// scroller and its own `max-w-md`, sharing only `useFocusTrap` — one of the eight
// hostless dialogs the census found, and the only one of the three that converged
// with NO e2e coverage at all. So this exists: without it, that convergence is
// verified by `tsc` and by reading, which is not the same as knowing the surface
// still opens.
//
// Every assertion is about the HOST's anatomy rather than about the builder's
// contents — the plate maths is already pinned in lib/__tests__/plates.test.ts,
// and what changed here is which surface draws the panel.
//
// Fixture hygiene (#868): the create form is opened and abandoned. Nothing is
// completed, so no set auto-saves and this test writes nothing.
test("the plate builder opens on the converged dialog host (#3405)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();
  // A barbell lift, so the weight field carries the plate affordance at all
  // (`showPlate` in StrengthSets is `isBarbell(equipment) || isBarbellLift(name)`).
  await pickActivity(page, "Barbell Bench Press");
  const weight = page.getByTestId("set1-weight");
  await expect(weight).toBeVisible();

  // The phone route has no desktop Add-activity entry. Open and pick through the
  // real desktop flow first, then resize the mounted editor to measure its phone
  // target without pretending that absent entry point exists.
  await page.setViewportSize({ width: 390, height: 844 });
  const plateButton = page.getByRole("button", {
    name: "Open plate builder",
  });
  const plateSlot = plateButton.locator("..");
  const setRow = page.getByTestId("set-values-1");
  const weightStepper = page.getByTestId("set1-weight-stepper");
  await expect(plateButton).toHaveAttribute("data-icon-button", "");
  await expectPhoneTapTargets(page, "strength-set plate builder", [
    plateButton,
  ]);
  await expect(plateSlot).toBeVisible();
  await expect(setRow).toBeVisible();
  await expect(weightStepper).toBeVisible();

  // One atomic DOM read proves the split ownership: the wrapper keeps the old
  // 28px grid slot while IconButton supplies the 44px target. A half pixel covers
  // browser sub-pixel rounding without admitting a real one-pixel layout shift.
  const geometry = await plateButton.evaluate((button) => {
    const slot = button.parentElement;
    const row = button.closest('[data-testid="set-values-1"]');
    const stepper = row?.querySelector('[data-testid="set1-weight-stepper"]');
    if (!slot || !row || !stepper)
      throw new Error("Plate target is detached from its owning set row");
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      target: box(button),
      slot: box(slot),
      row: box(row),
      stepper: box(stepper),
    };
  });
  const pixelEpsilon = 0.5;
  // The control box, and the 28px slot it overhangs. The 44 this used to demand is
  // EFFECTIVE now (#3938) — supplied by the reach a coarse pointer gets, which this
  // fine-pointer run does not have — so the rendered claim is the box, and the
  // overhang below is the half that was always the point.
  expect(geometry.target.width).toBeGreaterThanOrEqual(CONTROL_BOX_PX);
  expect(geometry.target.height).toBeGreaterThanOrEqual(CONTROL_BOX_PX);
  expect(Math.abs(geometry.slot.width - 28)).toBeLessThanOrEqual(pixelEpsilon);
  expect(geometry.target.left).toBeGreaterThanOrEqual(
    geometry.row.left - pixelEpsilon
  );
  expect(geometry.target.right).toBeLessThanOrEqual(
    geometry.row.right + pixelEpsilon
  );
  expect(geometry.target.top).toBeGreaterThanOrEqual(
    geometry.row.top - pixelEpsilon
  );
  expect(geometry.target.bottom).toBeLessThanOrEqual(
    geometry.row.bottom + pixelEpsilon
  );
  expect(geometry.target.left + pixelEpsilon).toBeGreaterThanOrEqual(
    geometry.stepper.right
  );

  await hydratedClick(page, plateButton);

  const builder = page.getByTestId("plate-builder");
  await expect(builder).toBeVisible();
  // THE HOST, named by the facts only the host produces: the declared
  // presentation, and the ONE scroll owner every converged body scrolls inside.
  // A hand-rolled portal has neither.
  await expect(builder).toHaveAttribute("data-presentation", "dialog");
  await expect(builder.locator("[data-sheet-content]")).toBeVisible();
  // The title is the host's, printed ONCE — the file no longer draws its own
  // `<h2>` beside it (#3361's rule, inherited rather than re-decided here).
  const title = builder.getByRole("heading", { name: "Plate builder" });
  await expect(title).toHaveCount(1);
  await expect(title).toBeVisible();
  // …over the builder's own content, so this is the real panel and not an empty
  // shell that happens to carry the testid.
  await expect(builder.getByRole("button", { name: "Use this" })).toBeVisible();

  // AND IT INHERITS ESCAPE (#3420). The old implementation answered Escape
  // through its own `useFocusTrap` call; that call is gone, and the behaviour
  // has to have survived the move rather than merely looking like it did.
  await page.keyboard.press("Escape");
  await expect(builder).toBeHidden();
});
