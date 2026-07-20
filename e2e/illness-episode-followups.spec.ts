import { test, expect, type Page } from "@playwright/test";
import { followLink } from "./nav";
import { settledClick } from "./helpers";
import {
  ensureUnlogged,
  addFromPicker,
  raiseSeverity,
  openTempEntry,
} from "./symptom-helpers";

async function openCurrentEpisode(page: Page) {
  await page.goto("/medical/episodes");
  const ongoing = page
    .getByTestId("episode-index-row")
    .filter({ hasText: /ongoing/i })
    .first();
  const href = await ongoing.getAttribute("href");
  expect(href).toMatch(/^\/medical\/episodes\/\d+$/);
  await page.goto(href!);
}

async function openEpisodeEditor(page: Page) {
  const controls = page
    .getByTestId("episode-illness-timeline")
    .getByTestId("episode-controls");
  await controls.getByRole("button", { name: "More episode actions" }).click();
  await expect(
    page.getByRole("button", { name: /Promote to condition|Remove condition/ })
  ).toBeVisible();
  await page.getByTestId("episode-edit-open").click();
  await expect(page.getByTestId("episode-editor")).toBeVisible();
}

async function openEpisodeActions(page: Page) {
  const controls = page
    .getByTestId("episode-illness-timeline")
    .getByTestId("episode-controls");
  await controls.getByRole("button", { name: "More episode actions" }).click();
  return controls;
}

// Illness-episode follow-ups (#856). The seed makes profile 1 currently sick with an
// OPEN "Illness" episode (a stored row) plus a PAST closed one. These specs drive the
// new surfaces: in-place logging on the episode page (item 11, the SHARED SymptomLogBar),
// the episodes index (item 9), and boundary/annotation editing (item 1). The full-arc
// END behavior is covered by the action-tier test (ending the seed's live episode here
// would race sibling specs that depend on profile 1 staying sick); the button presence
// is asserted below.

test.describe("Illness-episode follow-ups (#856)", () => {
  test("log a symptom AND a temperature from the episode page (item 11)", async ({
    page,
  }) => {
    test.slow();
    await openCurrentEpisode(page);

    // The shared logging bar + the fever chart render on the page.
    await expect(page.getByTestId("episode-log-panel")).toBeVisible();
    await expect(page.getByTestId("symptom-log-bar")).toBeVisible();
    await expect(page.getByTestId("episode-fever-chart")).toBeVisible();
    await expect(page.getByTestId("episode-illness-timeline")).toBeVisible();
    await expect(
      page
        .getByTestId("episode-illness-timeline")
        .getByText("Today", { exact: true })
        .first()
    ).toBeVisible();
    await expect(
      page
        .getByTestId("illness-event-symptom")
        .filter({ hasText: "Peaked in the evening" })
    ).toBeVisible();
    await expect(
      page
        .getByTestId("episode-illness-timeline")
        .getByTestId("episode-controls")
    ).toBeVisible();
    const printAction = page.getByRole("button", { name: "Print episode" });
    const shareAction = page.getByRole("button", { name: "Share episode" });
    await expect(printAction).toHaveAttribute("title", "Print");
    await expect(shareAction).toHaveAttribute("title", "Share");
    await expect(printAction).toHaveText("");
    await expect(shareAction).toHaveText("");
    await expect(page.getByTestId("episode-care-context")).toBeVisible();
    await expect(page.getByTestId("episode-update-workspace")).toBeVisible();
    await expect(
      page
        .getByTestId("episode-summary-header")
        .getByTestId("episode-identity-banner")
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Illness timeline", level: 2 })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Symptoms & Temperature",
        level: 3,
      })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Meds",
        level: 3,
      })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Meds", level: 3 })
    ).toBeVisible();
    const medsLink = page.getByRole("link", { name: "View all meds" });
    await expect(medsLink).toHaveAttribute("href", "/medications");
    await expect(
      page
        .getByTestId("episode-update-workspace")
        .getByRole("link", { name: "Medications", exact: true })
    ).toHaveCount(0);
    const addMedication = page.getByTestId("illness-add-medication");
    await expect(addMedication).toHaveClass(/\bbtn-ghost\b/);
    await expect(addMedication).toHaveAttribute("aria-expanded", "false");
    const medsLinkBox = await medsLink.boundingBox();
    const addMedicationBox = await addMedication.boundingBox();
    expect(medsLinkBox).not.toBeNull();
    expect(addMedicationBox).not.toBeNull();
    expect(addMedicationBox!.y).toBeGreaterThanOrEqual(
      medsLinkBox!.y + medsLinkBox!.height
    );
    await addMedication.click();
    await expect(addMedication).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByTestId("illness-medication-quick-add")
    ).toBeVisible();
    await expect(
      page
        .getByTestId("illness-medication-quick-add")
        .getByTestId("quick-add-medication")
    ).toBeVisible();
    await page.getByTestId("illness-add-medication").click();
    await expect(addMedication).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("illness-medication-quick-add")).toHaveCount(
      0
    );
    await expect(
      page.getByRole("heading", { name: "Progress photos", level: 3 })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Peak symptoms", level: 2 })
    ).toBeVisible();
    const peakSymptoms = page.getByTestId("episode-symptoms");
    await expect(
      peakSymptoms.getByText(/Show \d+ more/, { exact: true })
    ).toBeVisible();
    await expect(
      peakSymptoms.getByTestId("episode-print-symptoms")
    ).toHaveClass(/print:flex/);
    await expect(
      page.getByTestId("episode-severity-dots").first()
    ).toBeVisible();
    await expect(page.getByText("Daily symptoms", { exact: true })).toHaveCount(
      0
    );
    await expect(page.getByTestId("quick-log-prn-more")).toBeVisible();
    await expect(page.getByTestId("episode-fever-chart")).toContainText(
      "Normal range"
    );
    await expect(
      page.getByTestId("episode-fever").locator('[aria-hidden="true"]')
    ).toHaveClass(/text-rose-500/);
    await expect(
      page.getByTestId("episode-meds").locator('[aria-hidden="true"]')
    ).toHaveClass(/text-violet-500/);
    const updateBox = await page
      .getByTestId("episode-update-workspace")
      .boundingBox();
    const historyBox = await page
      .getByRole("heading", { name: "History", level: 3 })
      .boundingBox();
    const progressPhotosBox = await page
      .getByRole("heading", { name: "Progress photos", level: 3 })
      .boundingBox();
    expect(updateBox?.y).toBeLessThan(historyBox?.y ?? 0);
    expect(historyBox?.y).toBeLessThan(progressPhotosBox?.y ?? 0);
    const symptomWorkingRow = page
      .getByTestId("symptom-logged-list")
      .locator("li")
      .first();
    const doseWorkingRow = page.getByTestId("quick-log-prn-item").first();
    await expect(symptomWorkingRow).toHaveCSS("border-top-style", "solid");
    await expect(doseWorkingRow).toHaveCSS("border-top-width", "0px");
    await expect(doseWorkingRow).toHaveCSS("border-bottom-style", "solid");
    await expect(doseWorkingRow).toHaveCSS("border-radius", "0px");
    await expect(doseWorkingRow.getByRole("link").first()).toHaveCSS(
      "font-size",
      "14px"
    );
    await expect(doseWorkingRow.getByRole("link").first()).toHaveClass(
      /text-brand-600/
    );
    await expect(doseWorkingRow).toContainText(/\d+(?:\.\d+)?\s*(?:mg|mL)/i);
    await expect(
      doseWorkingRow.getByTestId("prn-log-now")
    ).toHaveAccessibleName("Taken now");
    await expect(
      doseWorkingRow.getByTestId("prn-log-more")
    ).toHaveAccessibleName("Earlier dose");
    // Illness medication rows use the same compact action treatment as the
    // Medications Today panel: equal icon-only buttons with tooltip/accessibility
    // labels, rather than a second set of full-width text actions.
    const illnessDoseActions = [
      doseWorkingRow.getByTestId("prn-log-now"),
      doseWorkingRow.getByTestId("prn-log-more"),
    ];
    const illnessDoseActionWidths = await Promise.all(
      illnessDoseActions.map(
        async (button) => (await button.boundingBox())!.width
      )
    );
    expect(
      Math.max(...illnessDoseActionWidths) -
        Math.min(...illnessDoseActionWidths)
    ).toBeLessThanOrEqual(1);
    expect(Math.max(...illnessDoseActionWidths)).toBeLessThanOrEqual(36);
    for (const button of illnessDoseActions) {
      await expect(button).toHaveAttribute("title", /\S+/);
      await expect(button.locator("span")).toHaveClass(/sr-only/);
    }
    const medNameBox = await doseWorkingRow
      .getByRole("link")
      .first()
      .boundingBox();
    const medStatusBox = await doseWorkingRow
      .getByTestId("prn-day-label")
      .boundingBox();
    expect(
      Math.abs((medNameBox?.x ?? 0) - (medStatusBox?.x ?? 0))
    ).toBeLessThan(2);
    await doseWorkingRow.getByTestId("prn-log-more").click();
    const earlierDose = doseWorkingRow.getByTestId("prn-log-options");
    await expect(earlierDose).toContainText("When was it taken?");
    await expect(earlierDose.getByLabel("Specific time today")).toBeVisible();
    const earlierDoseBox = await earlierDose
      .getByText("When was it taken?")
      .boundingBox();
    expect(
      Math.abs((medNameBox?.x ?? 0) - (earlierDoseBox?.x ?? 0))
    ).toBeLessThan(2);
    await doseWorkingRow.getByTestId("prn-log-more").click();
    await expect(page.getByTestId("symptom-add-picker-toggle")).toHaveClass(
      /\bbtn-ghost\b/
    );
    const tempToggle = page.getByTestId("temp-quick-toggle");
    await expect(tempToggle).toHaveClass(/\bbtn-ghost\b/);
    await expect(tempToggle.locator("svg")).toHaveCount(1);
    await expect(tempToggle).not.toContainText("🌡");
    await expect(page.getByTestId("symptom-day-primary")).not.toHaveClass(
      /bg-brand/
    );
    const medicationRows = page.getByTestId("illness-event-medication");
    await expect(medicationRows.first()).toContainText(/mg|mL|Add amount/i);
    await expect(
      medicationRows.first().getByRole("link").first()
    ).toHaveAttribute("href", /^\/medications\/\d+$/);
    await expect(medicationRows.first().getByRole("link").first()).toHaveClass(
      /text-brand-600/
    );
    await expect(
      medicationRows.filter({ hasText: /\d+(?:\.\d+)?\s*(?:mg|mL)/i }).first()
    ).toBeVisible();
    await expect(
      page
        .getByTestId("illness-event-appointment")
        .filter({ hasText: "Lab results review" })
    ).toBeVisible();
    const dayGroups = page.getByTestId("illness-timeline-day");
    await expect(dayGroups.first()).toBeVisible();
    await expect(dayGroups.first()).toHaveCSS("padding-top", "6px");
    expect(await dayGroups.count()).toBeLessThan(
      await page.locator('[data-testid^="illness-event-"]').count()
    );
    const desktopTable = page.getByTestId("illness-timeline-table-wrap");
    await expect(desktopTable).toHaveCSS("overflow-x", "visible");
    expect(
      await desktopTable.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1
      )
    ).toBe(true);
    await expect(medicationRows.filter({ hasText: "Add amount" })).toHaveCount(
      0
    );
    await expect(
      medicationRows.getByTestId("illness-medication-dose")
    ).toHaveCount(await medicationRows.count());

    // Filters keep the complete ledger as the default but make a long episode scannable.
    const historyFilters = page.getByTestId("illness-history-filters");
    await expect(
      historyFilters.getByRole("button", { name: "All" })
    ).not.toHaveClass(/bg-brand/);
    await historyFilters.getByRole("button", { name: "Temperature" }).click();
    await expect(
      page.getByTestId("illness-event-temperature").first()
    ).toBeVisible();
    await expect(page.getByTestId("illness-event-medication")).toHaveCount(0);
    await expect(page.getByTestId("illness-event-appointment")).toHaveCount(0);
    await historyFilters.getByRole("button", { name: "All" }).click();
    await expect(
      page.getByTestId("illness-event-medication").first()
    ).toBeVisible();
    // Historical symptom severity and notes can be corrected from the same ledger.
    const historicalSymptom = page
      .getByTestId("illness-event-symptom")
      .filter({ hasText: "Peaked in the evening" })
      .first();
    await historicalSymptom.getByTestId("overflow-menu-trigger").click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    let symptomEditor = page.getByTestId("illness-event-editor");
    await expect(symptomEditor.getByLabel("Severity")).toBeVisible();
    await symptomEditor
      .getByLabel("Note")
      .fill("Peaked in the evening — corrected");
    await symptomEditor.getByRole("button", { name: "Save" }).click();
    await expect(historicalSymptom).toContainText(
      "Peaked in the evening — corrected"
    );
    await historicalSymptom.getByTestId("overflow-menu-trigger").click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    symptomEditor = page.getByTestId("illness-event-editor");
    await symptomEditor.getByLabel("Note").fill("Peaked in the evening");
    await symptomEditor.getByRole("button", { name: "Save" }).click();
    await expect(historicalSymptom).toContainText("Peaked in the evening");

    // Historical readings and doses have a real correction path from the ledger.
    const tempRow = page.getByTestId("illness-event-temperature").first();
    await tempRow.getByTestId("overflow-menu-trigger").click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const eventEditor = page.getByTestId("illness-event-editor");
    await expect(eventEditor).toBeVisible();
    const dateTime = eventEditor.getByTestId("illness-event-date-time");
    await expect(
      dateTime.getByRole("button", { name: "Open calendar" })
    ).toBeVisible();
    const dateBox = await dateTime
      .locator('input:not([type="hidden"])')
      .first()
      .boundingBox();
    const timeBox = await dateTime.locator('input[name="time"]').boundingBox();
    const saveBox = await eventEditor
      .getByRole("button", { name: "Save" })
      .boundingBox();
    const cancelBox = await eventEditor
      .getByRole("button", { name: "Cancel" })
      .boundingBox();
    expect(Math.abs((dateBox?.y ?? 0) - (timeBox?.y ?? 0))).toBeLessThan(2);
    expect(Math.abs((saveBox?.y ?? 0) - (cancelBox?.y ?? 0))).toBeLessThan(2);
    const editorActions = eventEditor.getByTestId(
      "illness-event-editor-actions"
    );
    await expect(editorActions).toHaveCSS("justify-content", "flex-end");
    await expect(
      editorActions.getByRole("button", { name: "Save" })
    ).toHaveClass(/\bbtn\b/);
    await expect(
      editorActions.getByRole("button", { name: "Cancel" })
    ).toHaveClass(/\bbtn-ghost\b/);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    // The end action is offered on an open episode (item 2 UI; the
    // reconciliation trigger since #880). It closes the timeline after History and
    // Progress photos instead of sharing the header with print/share utilities.
    const lifecycle = page.getByTestId("episode-lifecycle-control");
    await expect(lifecycle).toContainText("Feeling better?");
    await expect(lifecycle).toContainText(
      "End this episode when you’re ready. You can reopen it for 7 days if symptoms return."
    );
    await expect(
      lifecycle.getByRole("button", { name: "End episode" })
    ).toBeVisible();
    await expect(
      page.getByTestId("episode-controls").getByTestId("episode-end")
    ).toHaveCount(0);
    const lifecycleBox = await lifecycle.boundingBox();
    const lifecycleHistoryBox = await page
      .getByTestId("episode-illness-timeline")
      .getByRole("heading", { name: "History" })
      .boundingBox();
    const lifecyclePhotosBox = await page
      .getByTestId("episode-illness-timeline")
      .getByRole("heading", { name: "Progress photos" })
      .boundingBox();
    expect(lifecycleBox?.y).toBeGreaterThan(lifecycleHistoryBox?.y ?? 0);
    expect(lifecycleBox?.y).toBeGreaterThan(lifecyclePhotosBox?.y ?? 0);

    // Promoting creates a durable Conditions record, so it uses the shared confirm.
    const controls = await openEpisodeActions(page);
    const promote = controls.getByRole("button", {
      name: "Promote to condition",
    });
    if (await promote.isVisible()) {
      await promote.click();
      const promoteDialog = page.getByRole("dialog", {
        name: "Add to medical conditions?",
      });
      await expect(promoteDialog).toContainText(
        "dates and status will stay in sync"
      );
      await promoteDialog.getByRole("button", { name: "Cancel" }).click();
    } else {
      await page.keyboard.press("Escape");
    }

    // The disclaimer belongs to the page footer, after the unified timeline tools.
    const footerBox = await page
      .getByTestId("episode-summary-footer")
      .boundingBox();
    const toolsBox = await page
      .getByTestId("episode-update-workspace")
      .boundingBox();
    expect(footerBox?.y).toBeGreaterThan(toolsBox?.y ?? 0);

    // Log a symptom at a severity from the episode page — the SHARED SymptomLogBar now
    // uses the #857 active-first layout, so add via the picker then raise (the same
    // helpers the dashboard spec drives — one flow, no per-mount drift).
    const bar = page.getByTestId("symptom-log-bar").first();
    await ensureUnlogged(bar, "sore_throat");
    await addFromPicker(bar, "sore_throat");
    await raiseSeverity(bar, "sore_throat", 3);

    // Log a temperature from the episode page (the entry is collapsed by default #857).
    await openTempEntry(bar);
    await expect(bar.getByTestId("temp-quick-unit")).toHaveValue("F");
    await bar.getByTestId("temp-quick-input").fill("37.8");
    await expect(bar.getByTestId("temp-quick-unit")).toHaveValue("C");
    await expect(bar.getByTestId("temp-unit-detected")).toContainText(
      "Detected °C"
    );
    await bar.getByTestId("temp-quick-save").click();
    await expect(page.getByText(/Temperature logged/i)).toBeVisible();
  });

  test("groups the episode tools without horizontal overflow on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCurrentEpisode(page);

    await expect(
      page
        .getByTestId("episode-illness-timeline")
        .getByTestId("episode-controls")
    ).toBeVisible();
    await expect(page.getByTestId("episode-care-context")).toBeVisible();
    await expect(page.getByTestId("episode-update-workspace")).toBeVisible();
    const medicationRows = page.getByTestId("illness-event-medication");
    await expect(medicationRows.last()).toContainText(/mg|mL|Add amount/i);
    await expect(
      medicationRows.filter({ hasText: /\d+(?:\.\d+)?\s*(?:mg|mL)/i }).last()
    ).toBeVisible();
    const dayGroups = page.getByTestId("illness-timeline-day");
    const visibleDayCount = () =>
      dayGroups.evaluateAll(
        (groups) =>
          groups.filter((group) => group.getClientRects().length > 0).length
      );
    expect(await dayGroups.count()).toBeGreaterThan(2);
    expect(await visibleDayCount()).toBe(2);
    const earlierHistory = page.getByTestId("illness-history-earlier-toggle");
    await expect(earlierHistory).toHaveAttribute("aria-expanded", "false");
    await earlierHistory.click();
    await expect(earlierHistory).toHaveAttribute("aria-expanded", "true");
    expect(await visibleDayCount()).toBe(await dayGroups.count());
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1
      )
    ).toBe(true);
    await page.getByTestId("illness-add-medication").click();
    await expect(
      page.getByTestId("illness-medication-quick-add")
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1
      )
    ).toBe(true);
    const tableScroller = page.getByTestId("illness-timeline-table-wrap");
    await expect(tableScroller).toHaveCSS("overflow-x", "auto");
    await expect(tableScroller).toHaveCSS("scrollbar-width", "none");
    await expect(medicationRows.last()).toHaveCSS("display", "grid");
  });

  test("a recently resolved illness can be reopened when symptoms return", async ({
    page,
  }) => {
    test.slow();
    await openCurrentEpisode(page);
    const timeline = page.getByTestId("episode-illness-timeline");
    const historyRows = timeline.locator(
      '[data-testid="illness-event-symptom"], [data-testid="illness-event-temperature"], [data-testid="illness-event-medication"]'
    );
    const historyCountBeforeEnd = await historyRows.count();
    expect(historyCountBeforeEnd).toBeGreaterThan(0);
    await expect(
      timeline.getByRole("heading", { name: "History" })
    ).toBeVisible();

    await page.getByRole("button", { name: "End episode" }).click();
    const endDialog = page.getByRole("dialog", {
      name: "End this episode?",
    });
    const reconcileConfirm = page.getByTestId("episode-med-reconcile-confirm");
    await expect(endDialog).toBeVisible();
    if (await reconcileConfirm.isVisible()) {
      await expect(endDialog).toContainText(
        "Today’s symptoms, temperatures, and doses will stay in the episode. Select any meds you also finished."
      );
      const selected = page
        .getByTestId("episode-med-reconcile-list")
        .locator('input[type="checkbox"]:checked');
      for (let count = await selected.count(); count > 0; count--) {
        await selected.first().uncheck();
      }
      await reconcileConfirm.click();
    } else {
      await expect(endDialog).toContainText(
        "This keeps today’s symptoms, temperatures, and doses in the episode, then ends it after today. You can reopen it for 7 days if symptoms return."
      );
      await endDialog.getByRole("button", { name: "End episode" }).click();
    }
    await expect(
      timeline.getByRole("heading", { name: "History" })
    ).toBeVisible();
    await expect(historyRows).toHaveCount(historyCountBeforeEnd);
    const reopen = page.getByTestId("episode-reopen-action");
    await expect(reopen).toBeVisible();
    await expect(reopen.locator(".tabler-icon-restore")).toBeVisible();
    await expect(page.getByTestId("resolved-episode-backfill-note")).toHaveText(
      "Add a past update to this episode. This won’t reopen it."
    );
    await expect(page.getByLabel("Entry date")).toBeVisible();

    await reopen.click();
    const reopenDialog = page.getByRole("dialog", {
      name: "Reopen this episode?",
    });
    await expect(reopenDialog).toContainText(
      "The illness will be active again, and new symptoms, temperatures, and doses will stay on this timeline."
    );
    await reopenDialog.getByRole("button", { name: "Reopen episode" }).click();
    await expect(page.getByTestId("episode-end")).toBeVisible();
    await expect(page.getByTestId("episode-reopen-action")).toHaveCount(0);
    await expect(
      page.getByTestId("resolved-episode-backfill-note")
    ).toHaveCount(0);
  });

  test("the episodes index lists episodes and links to the detail (item 9)", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/medical/episodes");
    await expect(
      page.getByRole("heading", { name: "Illness episodes" })
    ).toBeVisible();
    const rows = page.getByTestId("episode-index-row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(2); // open + past (seed)

    // Following a row opens its detail page.
    await followLink(page, rows.first(), /\/medical\/episodes\/\d+/);
    await expect(
      page.getByRole("heading", { name: /Illness episode/ })
    ).toBeVisible();
  });

  test("an episode opened today does not offer an out-of-range yesterday log", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/");
    const episodeLink = page
      .getByRole("link", { name: /^More details about / })
      .first();
    await followLink(page, episodeLink, /\/medical\/episodes\/\d+/);
    const episodeUrl = page.url();

    await openEpisodeEditor(page);
    const start = page.getByTestId("episode-start-input");
    // DateField renders a friendly date but submits its canonical ISO value
    // through the hidden named input. Preserve that value for seed cleanup.
    const originalStart = await page
      .getByTestId("episode-editor")
      .locator('input[type="hidden"][name="startedAt"]')
      .inputValue();
    const today = new Date().toISOString().slice(0, 10);
    try {
      await start.fill(today);
      const calendar = page.getByTestId("date-field-calendar");
      await expect(calendar).toBeVisible();
      await calendar.locator("button.bg-brand-600").click();
      await expect(calendar).toHaveCount(0);
      await settledClick(
        page,
        page.getByTestId("episode-editor").getByRole("button", { name: "Save" })
      );
      await expect(page.getByTestId("episode-editor")).toHaveCount(0);
      await expect(page.getByTestId("symptom-day-toggle")).toHaveCount(0);
      await page.goto("/");
      await expect(page.getByTestId("symptom-day-toggle")).toHaveCount(0);
    } finally {
      // Restore the shared seed even if the assertion fails, so sibling specs retain
      // their expected multi-day story.
      await page.goto(episodeUrl);
      if (!(await page.getByTestId("episode-editor").isVisible()))
        await openEpisodeEditor(page);
      const restoreStart = page.getByTestId("episode-start-input");
      await restoreStart.fill(originalStart);
      const restoreCalendar = page.getByTestId("date-field-calendar");
      await expect(restoreCalendar).toBeVisible();
      await restoreCalendar.locator("button.bg-brand-600").click();
      await expect(restoreCalendar).toHaveCount(0);
      await settledClick(
        page,
        page.getByTestId("episode-editor").getByRole("button", { name: "Save" })
      );
      await expect(page.getByTestId("episode-editor")).toHaveCount(0);
    }
  });

  test("edit a past episode's outcome + note as a plain row edit (item 1)", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/medical/episodes");
    // The PAST (resolved) episode — the seed labels its outcome "Self-resolved". This
    // test EDITS that outcome, so under repeat-each a later run finds the edited value
    // instead; match either so it's repeat-safe.
    const resolvedRow = page
      .getByTestId("episode-index-row")
      .filter({ hasText: /Self-resolved|Recovered without a visit/ })
      .first();
    await followLink(page, resolvedRow, /\/medical\/episodes\/\d+/);

    await openEpisodeEditor(page);
    await page.getByTestId("episode-start-input").click();
    const calendar = page.getByTestId("date-field-calendar");
    await expect(calendar).toBeVisible();
    const calendarLayer = await calendar.evaluate((element) =>
      Number(getComputedStyle(element).zIndex)
    );
    const modalLayer = await page
      .getByRole("dialog", { name: "Edit episode" })
      .locator("..")
      .evaluate((element) => Number(getComputedStyle(element).zIndex));
    expect(calendarLayer).toBeGreaterThan(modalLayer);
    await page.getByTestId("episode-outcome-input").click();
    await expect(calendar).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Edit episode" })
    ).toBeVisible();
    await page
      .getByTestId("episode-outcome-input")
      .fill("Recovered without a visit");
    await page
      .getByTestId("episode-note-input")
      .fill("Rested; plenty of fluids");
    await page.getByRole("button", { name: "Save" }).click();

    // The outcome + note persist on the summary. Scope the note to its rendered
    // paragraph — the edit form's <textarea> also holds the text, so an unscoped
    // getByText matches two elements.
    await expect(
      page.getByText("Recovered without a visit").first()
    ).toBeVisible();
    await expect(
      page
        .getByRole("paragraph")
        .filter({ hasText: "Rested; plenty of fluids" })
        .first()
    ).toBeVisible();
  });
});
