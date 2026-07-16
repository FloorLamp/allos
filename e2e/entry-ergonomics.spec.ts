import { test, expect, type Page } from "@playwright/test";
import { openCommandPalette } from "./nav";

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
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first()
    .click();
}

// Issue #29: data-entry ergonomics — the three affordances end-to-end against the
// seeded DB.
//
//  1. Command-palette inline quick-log: `weight 84.3` parses (pure
//     parseQuickLog), previews, and Enter commits it through paletteQuickLog →
//     insertBodyMetric (the same write the Body form uses).
//  2. Repeat-last: a card's "Log again" opens a CREATE form pre-filled from the
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
  await input.press("Enter");
  await expect(page.getByText("Logged weight 84.3 kg.")).toBeVisible();

  // …and it lands in the Body tab's History table (kg, so the value shows
  // as-is). Assert against the weight cell's stable testid — rows are date-desc,
  // so today's just-logged entry is the first one — rather than free text, which
  // also matches the (visually hidden) chart axis/point labels.
  await page.goto("/trends?tab=body");
  await expect(page.getByTestId("body-weight-cell").first()).toContainText(
    "84.3"
  );
});

test("'Log again' pre-fills a create form that saves a new activity (#29)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // The e2e seed plants a manual "Journal merge keeper" activity; repeat it.
  const titleCards = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Journal merge keeper" });
  await expect(titleCards.first()).toBeVisible();
  const before = await titleCards.count();

  // Open the first matching card's overflow (⋯) menu → "Log again".
  await titleCards
    .first()
    .getByRole("button", { name: "Activity actions" })
    .click();
  await page.getByTestId("log-again").click();

  // The editor opens pre-filled — its heading carries the source title.
  await expect(
    page.getByRole("heading", { name: "Journal merge keeper" })
  ).toBeVisible();

  // The prefilled, complete session auto-saves as a NEW row (dated today), so a
  // second card with the same title appears on the feed.
  await expect(titleCards).toHaveCount(before + 1);

  // Clean up the row this test just created: the editor is still open on it, so
  // delete it from there. The e2e DB is shared across specs (the harness seeds
  // once), and a lingering today-dated activity would (a) collide with the
  // journal-merge fixture's "Journal merge keeper" title and (b) add a new "Today"
  // day-group that shifts the journal's visible-day window, throwing off the
  // absolute card counts in journal-merge / undo-delete. Restoring the seed state
  // here keeps those specs order-independent.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(titleCards).toHaveCount(before);
});

test("Journal actions share the search toolbar and stay outside the editor scroller", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // The shared app shell uses the available desktop width instead of stopping at
  // the old 6xl/7xl caps. The 3xl ultra-wide cap remains separate.
  const contentContainer = page.getByTestId("app-content-container");
  expect((await contentContainer.boundingBox())!.width).toBeGreaterThan(1280);
  await page.setViewportSize({ width: 1280, height: 720 });

  // The compact cadence strip shares the routine row and represents exactly the
  // trailing 14 profile-local days using the Fitness heatmap's density scale.
  const cadence = page.getByTestId("journal-active-days");
  await expect(cadence).toBeVisible();
  await expect(cadence.getByTestId("active-days-label-expanded")).toBeVisible();
  await expect(cadence.getByTestId("active-days-label-expanded")).toContainText(
    /\d+\/21 days active/
  );
  await expect(
    cadence.locator('[aria-label$="— no workouts"], a[aria-label*="session"]')
  ).toHaveCount(21);
  await expect(cadence.getByTestId("active-day").first()).toHaveAttribute(
    "href",
    /\/training\?tab=log#day-\d{4}-\d{2}-\d{2}/
  );
  const routineRow = page.getByTestId("journal-routine-row");
  const routineLabelBox = await routineRow
    .getByText("Weekly routine")
    .boundingBox();
  const cadenceBox = await cadence.boundingBox();
  expect(routineLabelBox).not.toBeNull();
  expect(cadenceBox).not.toBeNull();
  expect(Math.abs(routineLabelBox!.y - cadenceBox!.y)).toBeLessThan(12);

  // The longer window is reserved for the largest practical layout. At an
  // intermediate desktop width, the strip contracts to its newest 14 days.
  await page.setViewportSize({ width: 1100, height: 844 });
  await expect(cadence.getByTestId("active-days-label-compact")).toBeVisible();
  await expect(cadence.getByTestId("active-days-label-expanded")).toBeHidden();
  await expect(page.getByTestId("activity-editor-scroll")).toBeHidden();
  const intermediateRoutineBox = await routineRow
    .getByText("Weekly routine")
    .boundingBox();
  const intermediateCadenceBox = await cadence.boundingBox();
  expect(intermediateRoutineBox).not.toBeNull();
  expect(intermediateCadenceBox).not.toBeNull();
  expect(intermediateCadenceBox!.y).toBeGreaterThan(
    intermediateRoutineBox!.y + intermediateRoutineBox!.height
  );
  expect(
    await cadence
      .locator('[aria-label$="— no workouts"], a[aria-label*="session"]')
      .evaluateAll(
        (days) =>
          days.filter((day) => getComputedStyle(day).display !== "none").length
      )
  ).toBe(14);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByTestId("activity-editor-scroll")).toBeVisible();

  const actions = page.getByTestId("journal-actions");
  const button = page.getByTestId("repeat-last");
  await expect(actions).toContainText("Repeat last");
  await expect(actions).toContainText("Start workout");
  await expect(actions).toContainText("New activity");
  await expect(button).toBeVisible();

  // These are page-level actions, aligned with search rather than living in the
  // independently scrolling activity panel.
  await expect(
    button.locator('xpath=ancestor::*[@data-testid="journal-controls"][1]')
  ).toHaveCount(1);
  await expect(
    button.locator('xpath=ancestor::*[@data-testid="activity-editor-scroll"]')
  ).toHaveCount(0);
  const search = page.getByPlaceholder("Search activities or exercises…");
  const searchBox = await search.boundingBox();
  const btnBox = await button.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(btnBox).not.toBeNull();
  expect(searchBox!.width).toBeGreaterThan(320);
  expect(Math.abs(btnBox!.y - searchBox!.y)).toBeLessThanOrEqual(2);
  await expect(button).toBeEnabled();

  // Search owns an inline clear action, while activity types behave as one
  // segmented control with a single reset for all active filters.
  await search.fill("Bench");
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  const types = page.getByRole("group", { name: "Activity type" });
  await expect(types.getByRole("button", { name: "All" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await types.getByRole("button", { name: "Strength" }).click();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(types.getByRole("button", { name: "All" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  // Mobile navigation already owns activity creation, so the page-level action
  // group disappears rather than duplicating all three controls.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cadence.getByTestId("active-days-label-compact")).toBeVisible();
  expect(
    await cadence
      .locator('[aria-label$="— no workouts"], a[aria-label*="session"]')
      .evaluateAll(
        (days) =>
          days.filter((day) => getComputedStyle(day).display !== "none").length
      )
  ).toBe(14);
  await expect(actions).toBeHidden();
  await expect(
    actions.getByRole("button", { name: "New activity" })
  ).toBeHidden();

  // The mobile nav remains through 767px, so page actions must not reappear at
  // the earlier 640px breakpoint and create duplicate controls.
  await page.setViewportSize({ width: 700, height: 844 });
  await expect(actions).toBeHidden();
  await page.setViewportSize({ width: 800, height: 844 });
  await expect(actions).toBeVisible();
  const narrowFiltersBox = await types.boundingBox();
  const narrowActionsBox = await actions.boundingBox();
  expect(narrowFiltersBox).not.toBeNull();
  expect(narrowActionsBox).not.toBeNull();
  expect(narrowActionsBox!.y).toBeGreaterThan(
    narrowFiltersBox!.y + narrowFiltersBox!.height
  );
});

test("edit mode surfaces the exercise's previous sessions (#188)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // The seed plants recurring "Push day" strength sessions across several weeks,
  // each repeating the same lifts (Barbell Bench Press, …). Opening the NEWEST
  // one for edit — by clicking its title — must show the "Recent" reference
  // panel of prior sessions (issue #188: edit mode used to omit it entirely).
  const main = page.getByRole("main");
  const pushCard = main
    .locator('[id^="activity-"]')
    .filter({ hasText: "Push day" })
    .first();
  await expect(pushCard).toBeVisible();

  // Click the card's title to open the editor in EDIT mode (openEdit).
  await pushCard.getByRole("button", { name: "Push day" }).click();

  // The editor opens on the stored session — its header carries the title.
  await expect(page.getByRole("heading", { name: "Push day" })).toBeVisible();

  // A strength part renders its Recent panel of prior sessions. Deliberately
  // NOT scoped to <main>: the editor mounts either in the journal's dock
  // (inside <main>) or in the body-level overlay portal — the dock registers
  // in a post-hydration effect, so a click landing before that legitimately
  // falls back to the overlay (a timing the spec must not depend on). The
  // testid cannot double-render — there is exactly one editor instance — so
  // the #206 main-scoping rule doesn't apply here.
  const panel = page.getByTestId("recent-sessions").first();
  await expect(panel).toBeVisible();
  // …and it lists at least one prior session row (self-excluded: the session
  // being edited never appears in its own Recent list).
  await expect(panel.getByRole("listitem").first()).toBeVisible();

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
  await page.goto("/training");

  // This seeded manual cardio row has no clock range and stores 28 minutes on
  // both its parent and visible Running component. Editing the visible field
  // must not resubmit the parent's hidden 28-minute seed.
  const card = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Intervals" })
    .first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Intervals" }).click();

  const duration = page.getByTestId("cardio-duration");
  await expect(duration).toHaveValue("28");
  await duration.fill("35");
  await expect(page.getByLabel("Saved").first()).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(card.getByTestId("activity-summary")).toContainText("35 min");

  // Restore the shared seed row so other specs remain order-independent.
  await card.getByRole("button", { name: "Intervals" }).click();
  await page.getByTestId("cardio-duration").fill("28");
  await expect(page.getByLabel("Saved").first()).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(card.getByTestId("activity-summary")).toContainText("28 min");
});

test("logging a manual cardio activity auto-fills an editable estimated-calorie value (#151)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // Open a fresh create form. The "New activity" button lives in the Journal
  // header inside <main>; the editor it opens mounts either in the docked pane
  // (inside <main>) or the body-level overlay portal, so the form's own fields are
  // addressed by their unique testids/roles rather than main-scoped (there is
  // exactly one editor instance — same reasoning as the #206 recent-sessions spec).
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();

  // PICK a known cardio activity from the combobox — typing the name alone doesn't
  // resolve the part TYPE, so the cardio fields (and the shared estimate field) only
  // appear after an explicit selection commits the type.
  await page.getByPlaceholder(/What did you do/).fill("Running");
  await page
    .getByRole("listbox")
    .getByRole("button", { name: "Running", exact: true })
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
  const comparableControls = [
    page.getByTestId("cardio-duration"),
    input,
    page.getByTestId("activity-equipment-select"),
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

  // It's editable — the user can override the auto value.
  await input.fill("123");
  await expect(input).toHaveValue("123");

  // Clean up: delete the just-created activity from the still-open editor. The
  // Delete button only appears once the auto-save has created the row, so waiting on
  // it also confirms the activity persisted. Restores the seed for later specs.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
});

test("the activity form keeps workout entry primary and context visible across breakpoints", async ({
  page,
}) => {
  await page.goto("/training");

  const pushCard = page
    .getByRole("main")
    .locator('[id^="activity-"]')
    .filter({ hasText: "Push day" })
    .first();
  await pushCard.getByRole("button", { name: "Push day" }).click();

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
  const header = page.getByTestId("activity-form-header");
  await expect(header).toBeVisible();
  expect(await header.evaluate((node) => getComputedStyle(node).position)).toBe(
    "sticky"
  );
  await expect(header).toHaveCSS("padding-top", "20px");
  await expect(header).toHaveCSS("padding-bottom", "20px");

  // Workout rows use separators instead of nested cards, session metadata is
  // grouped, and optional metadata starts behind one disclosure.
  await expect(
    page.getByRole("heading", { name: "Workout", exact: true })
  ).toHaveClass("sr-only");
  const part = page.getByTestId("activity-part").first();
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
  const dockBox = await page.getByTestId("activity-editor-dock").boundingBox();
  const firstJournalCardBox = await page
    .getByRole("main")
    .locator('[id^="activity-"]')
    .first()
    .boundingBox();
  expect(headerBox).not.toBeNull();
  expect(dockBox).not.toBeNull();
  expect(firstJournalCardBox).not.toBeNull();
  expect(Math.abs(dockBox!.y - firstJournalCardBox!.y)).toBeLessThanOrEqual(1);
  expect(headerBox!.x).toBe(partBox!.x);
  expect(headerBox!.x + headerBox!.width).toBe(partBox!.x + partBox!.width);
  expect(headerBox!.y).toBeLessThanOrEqual(dockBox!.y + 2);

  // The toolbar scrolls away inside this pane; neither the pane nor the form's
  // sticky header retains a top offset afterward.
  const editorScroll = page.getByTestId("activity-editor-scroll");
  await expect(editorScroll).toHaveCSS("top", "0px");
  await editorScroll.evaluate((node) => {
    node.scrollTop = 100;
  });
  await expect
    .poll(async () => {
      const [scroller, stickyHeader] = await Promise.all([
        editorScroll.boundingBox(),
        header.boundingBox(),
      ]);
      if (!scroller || !stickyHeader) return Number.POSITIVE_INFINITY;
      return stickyHeader.y - scroller.y;
    })
    .toBeLessThanOrEqual(1);
  await expect(header).toHaveCSS("padding-top", "20px");
  await editorScroll.evaluate((node) => {
    node.scrollTop = 0;
  });
  const standardInputs = [
    page.getByRole("combobox", { name: "Activity" }).first(),
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
  await expect(page.locator('label[for="activity-date"]')).toHaveText("Date");
  await expect(page.locator('label[for="activity-start-time"]')).toHaveText(
    "Start"
  );
  await expect(page.locator('label[for="activity-end-time"]')).toHaveText(
    "End"
  );
  await expect(page.getByTestId("per-side-control").first()).toBeVisible();
  const sessionDetails = page.getByTestId("session-details");
  await expect(sessionDetails).toBeVisible();
  await expect(sessionDetails).toHaveCSS("border-top-width", "0px");
  await expect(
    sessionDetails.getByRole("heading", { name: "Session details" })
  ).toHaveClass("sr-only");
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

  // Crossing into the mobile presentation closes the desktop dock. Reopen the
  // same activity in the overlay and pin the exercise/set schema while logging.
  await page.setViewportSize({ width: 390, height: 844 });
  await pushCard.getByRole("button", { name: "Push day" }).click();
  const headings = page.getByTestId("set-column-headings").first();
  await expect(headings).toBeVisible();
  expect(
    await headings.evaluate((node) => getComputedStyle(node).position)
  ).toBe("sticky");
  await expect(page.getByTestId("set1-weight").first()).toHaveAttribute(
    "inputmode",
    "decimal"
  );
  await expect(page.getByTestId("activity-form-footer")).toHaveCSS(
    "position",
    "sticky"
  );
});

test("a fresh strength part auto-seeds set 1 from the coached suggestion (#335)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // Open a fresh create form (fields addressed by testid/role — see the
  // est-calories spec's note on why the editor isn't main-scoped).
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();

  // Pick a lift the seed trains repeatedly (Barbell Bench Press, weeks of
  // 60 kg → +1 kg/wk history) so a coached next-set suggestion exists.
  await pickActivity(page, "Barbell Bench Press");

  // The coached "Next set" card renders for a fresh part with history.
  await expect(page.getByText("Next set")).toBeVisible();

  // Set 1's weight shows the suggested load as a ghost PLACEHOLDER (a number,
  // not the bare "kg" unit) — the auto-seed, no "Use" tap needed (#335).
  const weight = page.getByTestId("set1-weight");
  await expect(weight).toHaveAttribute("placeholder", /^\d/);

  // Focusing the field fills it (weight + reps) from the suggestion, completing
  // the set so it auto-saves — the Delete button appearing confirms the persist.
  await weight.focus();
  await expect(weight).toHaveValue(/^\d/);
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // Clean up the auto-saved draft so the shared seed DB is left untouched.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
});

test("a cardio part derives avg speed AND pace from distance + duration (#336)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
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

  // Clean up the auto-saved draft (a duration makes it savable).
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
});

test("a lone sport logged with Start/End auto-fills its Duration and shows real minutes (#791)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // Open a fresh create form (fields addressed by testid/role — see the
  // est-calories spec's note on why the editor isn't main-scoped).
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
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
    page.getByRole("cell", { name: "55 min", exact: true }).first()
  ).toBeVisible();

  // Clean up the row this test created so the shared seed DB is left untouched:
  // reopen it from the feed (its generated title carries "Tennis") and delete it.
  await page.goto("/training?tab=log");
  const newCard = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Tennis" })
    .filter({ hasText: "55 min" })
    .first();
  await expect(newCard).toBeVisible();
  await newCard
    .getByRole("button", { name: /Tennis/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(newCard).toHaveCount(0);
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

test("weight steppers bump a set's load by the lift-appropriate increment (#337)", async ({
  page,
}) => {
  await page.goto("/training");

  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();

  // Barbell Bench Press is an upper-body lift → a 2.5 (kg) step for the seeded
  // metric login.
  await pickActivity(page, "Barbell Bench Press");

  const toFailure = page.getByTestId("to-failure-checkbox");
  await page.getByText("To failure", { exact: true }).click();
  await expect(toFailure).toBeChecked();
  await expect(page.getByTestId("to-failure-control")).toHaveClass(
    /bg-brand-600/
  );
  await page.getByText("To failure", { exact: true }).click();
  await expect(toFailure).not.toBeChecked();

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
  ).toEqual({ top: "0px", right: "1px", bottom: "0px", left: "0px" });
  const weightStepperBox = await weightStepper.boundingBox();
  const repsStepperBox = await repsStepper.boundingBox();
  expect(weightStepperBox).not.toBeNull();
  expect(repsStepperBox).not.toBeNull();
  expect(
    Math.abs(weightStepperBox!.width - repsStepperBox!.width)
  ).toBeLessThanOrEqual(1);
  const weightHeadingBox = await page
    .getByTestId("weight-column-heading")
    .boundingBox();
  const repsHeadingBox = await page
    .getByTestId("reps-column-heading")
    .boundingBox();
  expect(weightHeadingBox).not.toBeNull();
  expect(repsHeadingBox).not.toBeNull();
  expect(
    Math.abs(
      weightHeadingBox!.x +
        weightHeadingBox!.width / 2 -
        (weightStepperBox!.x + weightStepperBox!.width / 2)
    )
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      repsHeadingBox!.x +
        repsHeadingBox!.width / 2 -
        (repsStepperBox!.x + repsStepperBox!.width / 2)
    )
  ).toBeLessThanOrEqual(1);

  // The + stepper bumps the (empty) weight by one increment → 2.5. Only weight is
  // set, so the set stays half-filled and nothing auto-saves — no cleanup needed.
  await page.getByLabel("Increase weight").first().click();
  await expect(page.getByTestId("set1-weight")).toHaveValue("2.5");

  await page.keyboard.press("Escape");
});

test("a set row has a warmup toggle that flips its pressed state (#338)", async ({
  page,
}) => {
  await page.goto("/training");

  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();

  await pickActivity(page, "Barbell Bench Press");

  // Each set carries a light "W" warmup toggle (default off). Toggling flips its
  // aria-pressed state — the flag excludes the set from volume/target/records.
  const warmup = page.getByTestId("set1-warmup");
  await expect(warmup).toHaveAttribute("aria-pressed", "false");
  await warmup.click();
  await expect(warmup).toHaveAttribute("aria-pressed", "true");

  // Only the flag was toggled on an empty set, so nothing auto-saves — no cleanup.
  await page.keyboard.press("Escape");
});

test("a failed activity save surfaces an error, never a false 'Saved ✓' (#332)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

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
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"]) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  // Open a fresh create form and fill it enough to be savable (same flow as the
  // est-calories spec — see its note on why fields are addressed by testid/role).
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();
  await page.getByPlaceholder(/What did you do/).fill("Running");
  await page
    .getByRole("listbox")
    .getByRole("button", { name: "Running", exact: true })
    .click();
  // A duration makes the activity savable, so the debounced auto-save fires — and
  // hits the aborted request.
  await page.getByTestId("cardio-duration").fill("30");

  // The failure must surface as the error indicator (SaveStatus, aria-label
  // "Couldn’t save"), and the success check must never appear.
  // Desktop renders the active indicator in the sticky header; the mobile
  // footer copy remains in the DOM but is CSS-hidden at this breakpoint.
  await expect(
    page.locator('[aria-label="Couldn’t save"]:visible')
  ).toBeVisible();
  await expect(page.getByLabel("Saved")).toHaveCount(0);

  // Nothing persisted (the save was forced to fail), so there is no draft row to
  // clean up — the shared seed DB is left untouched.
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
    (await card.locator("h2 span").first().textContent())?.trim();
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
  await expect(card.locator("h2 span").first()).toHaveText(original!);
});
