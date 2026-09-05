import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import { followLink, loginAs } from "./nav";
import { E2E_LOGIN_FEVER_AXIS, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import {
  appContent,
  dismissToast,
  expectNoClippedContent,
  expectSvgTextInsidePlot,
  hydratedClick,
  settledBoxes,
  settledClick,
} from "./helpers";
import {
  expectDesktopOrdinarySubmit,
  expectPhoneOrdinarySubmit,
} from "./ordinary-submit-actions";
import {
  ensureUnlogged,
  addFromPicker,
  raiseSeverity,
  openTempEntry,
} from "./symptom-helpers";
import {
  TAP_FLOOR_FLOAT_EPSILON_PX,
  CONTROL_BOX_PX,
} from "@/lib/tap-floor-tokens";
import { sharedDayRestorePoint } from "./shared-profile-guard";
import { frozenNow } from "./worker-env";

const PHONE = { width: 390, height: 844 };

// ONE TEST HERE LOGS A TEMPERATURE ON THE SHARED PROFILE (#5266). It lands in
// `medical_records` on profile 1, dated today, and every reading surface there takes
// the LATEST row under a canonical name — so a reading left behind becomes the shared
// profile's current temperature for every later test on this worker. The day is put
// back rather than cleared: the seed carries its own today-dated Body Temperature,
// and deleting the day would take that from everyone downstream (#5265's ruling).
// Restored from an `afterEach` so a failure part-way through cannot skip it.
let restoreSharedDay: (() => void) | null = null;

test.afterEach(() => {
  restoreSharedDay?.();
  restoreSharedDay = null;
});

async function expectClosedEpisodeAction(
  locator: Locator,
  name: string
): Promise<void> {
  await expect(locator).toHaveAttribute("data-button-control", "");
  await expect(locator).toHaveAccessibleName(name);
  const [box] = await settledBoxes([locator]);
  // The control box (#3938). The 44 these used to render is EFFECTIVE now, and
  // the reach that supplies it exists only on a coarse pointer.
  expect(
    box.width + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} rendered width`
  ).toBeGreaterThanOrEqual(CONTROL_BOX_PX);
  expect(
    box.height + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} rendered height`
  ).toBeGreaterThanOrEqual(CONTROL_BOX_PX);
  expect(
    box.x + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} left viewport edge`
  ).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${name} right viewport edge`).toBeLessThanOrEqual(
    PHONE.width + TAP_FLOOR_FLOAT_EPSILON_PX
  );
}

async function openCurrentEpisode(page: Page) {
  await page.goto("/medical/episodes");
  const ongoing = page
    .getByTestId("episode-index-row")
    .filter({ hasText: /ongoing/i })
    .first(); // first-ok: the fixture's own ongoing episode (filtered) — order-agnostic
  const href = await ongoing.getAttribute("href");
  expect(href).toMatch(/^\/medical\/episodes\/\d+$/);
  await page.goto(href!);
}

async function openEpisodeEditor(page: Page) {
  const controls = page
    .getByTestId("episode-illness-timeline")
    .getByTestId("episode-controls");
  await hydratedClick(
    page,
    controls.getByRole("button", { name: "More episode actions" })
  );
  // By ROLE: the panel declares `role="menu"`, so its items answer to
  // `menuitem` — and an item that stops being one is a real regression rather
  // than a styling detail (#5181). The episode is either promoted or not, so
  // exactly one of the two condition items is on offer.
  await expect(
    page.getByRole("menuitem", {
      name: /^(Promote to condition|Remove condition)$/,
    })
  ).toHaveCount(1);
  await page.getByTestId("episode-edit-open").click();
  await expect(page.getByTestId("episode-editor")).toBeVisible();
}

// Returns the OPEN MENU, not the row it hangs off. From `md` up AnchoredPanel
// portals the panel to <body>, so no item inside it is a descendant of the
// controls div — a locator scoped to the row matched nothing at all, and the one
// caller that guarded on `isVisible()` took its else branch every run. The menu
// is addressed by the role it declares, which is also how its items are
// addressed (#5181).
async function openEpisodeActions(page: Page): Promise<Locator> {
  const controls = page
    .getByTestId("episode-illness-timeline")
    .getByTestId("episode-controls");
  await hydratedClick(
    page,
    controls.getByRole("button", { name: "More episode actions" })
  );
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
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
    const todayGroup = page
      .getByTestId("episode-illness-timeline")
      .getByText("Today", { exact: true })
      .first(); // first-ok: the Today group in the episode timeline — order-agnostic
    await expect(todayGroup).toBeVisible();
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
    await expect(printAction).toHaveAccessibleName("Print episode");
    await expect(shareAction).toHaveAccessibleName("Share episode");
    await expect(printAction).toHaveText("");
    await expect(shareAction).toHaveText("");
    await expect(
      appContent(page).getByTestId("episode-care-context")
    ).toBeVisible();
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
        .getByTestId("intake-item-form")
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
    const severityDots = page.getByTestId("episode-severity-dots").first(); // first-ok: asserts a severity-dots row renders — order-agnostic presence
    await expect(severityDots).toBeVisible();
    await expect(page.getByText("Daily symptoms", { exact: true })).toHaveCount(
      0
    );
    // MEDS ARE CHIPS AND THE TAIL FOLDS BEHIND "N more" (#4752 item 4). The
    // "More medications (N)" disclosure is retired with the per-row boilerplate it
    // used to hide; the fold is a chip in the same flow row as the rest.
    await expect(page.getByTestId("cockpit-med-more")).toBeVisible();
    await expect(page.getByTestId("quick-log-prn-more")).toHaveCount(0);
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
      .first(); // first-ok: a logged-symptom row — asserts its border layout, order-agnostic
    await expect(symptomWorkingRow).toHaveCSS("border-top-style", "solid");
    // DETAIL IS ONE TAP AWAY, AND ONLY WHEN ACTING ON THE MED (#4752 item 4).
    // Collapsed, a med is its NAME beside one shared status line — no per-row day
    // label, no per-row redose line, which is the six lines of boilerplate this
    // rebuild removed. Both only exist inside the panel a chip opens.
    await expect(page.getByTestId("cockpit-med-status")).toBeVisible();
    await expect(page.getByTestId("prn-day-label")).toHaveCount(0);
    await expect(page.getByTestId("prn-redose-line")).toHaveCount(0);
    await expect(page.getByTestId("cockpit-med-panel")).toHaveCount(0);
    const medChip = page.locator('[data-testid^="cockpit-med-chip-"]').first(); // first-ok: the row's leading med chip; every chip opens the same panel shape
    await medChip.click();
    const doseWorkingRow = page.getByTestId("cockpit-med-panel");
    await expect(doseWorkingRow).toBeVisible();
    await expect(medChip).toHaveAttribute("aria-expanded", "true");
    const doseLink = doseWorkingRow.getByRole("link").first(); // first-ok: the med link naming the open panel — order-agnostic
    await expect(doseLink).toHaveCSS("font-size", "14px");
    // The ONE inline action-link treatment, now named rather than spelled out:
    // #3607 item 3 swept the hand-rolled `font-medium text-brand-600
    // hover:underline dark:text-brand-400` to the `text-link` utility that
    // produces exactly those declarations, so the literal tone class is no
    // longer in any className. The claim is unchanged.
    await expect(doseLink).toHaveClass(/text-link/);
    await expect(doseWorkingRow).toContainText(/\d+(?:\.\d+)?\s*(?:mg|mL)/i);
    await expect(doseWorkingRow.getByTestId("prn-day-label")).toBeVisible();
    // THE FULL STATEMENT (#4752 item 4): the labeled-verb chip's label is the dose
    // this tap writes and the verb is one word that never says "now", with the
    // clock door in its seat immediately right of it (#4752 item 8).
    const panelTake = doseWorkingRow.getByTestId("prn-log-now");
    await expect(panelTake).toHaveAccessibleName(/^(?:Take|Give) .+/);
    await expect(panelTake).toHaveAttribute(
      "data-chip-verb",
      /^(?:Take|Give)$/
    );
    const panelDoor = doseWorkingRow.getByTestId("prn-log-when-toggle");
    await expect(panelDoor).toHaveAccessibleName("Happened earlier?");
    await expect(panelDoor).toHaveText("Happened earlier?"); // the visible glyph only — the words are sr-only
    await expect(panelDoor.locator("span")).toHaveClass(/sr-only/);
    // ONE SETTLED GROUP, not two round-trips: the claim below is RELATIVE, so the
    // two boxes have to describe the same layout (#868's hygiene rule).
    const [takeBox, doorBox] = await settledBoxes([panelTake, panelDoor]);
    // Seated immediately RIGHT of the action it modifies, and never before it.
    expect(doorBox.x).toBeGreaterThan(takeBox.x + takeBox.width - 1);
    const medNameBox = await doseLink.boundingBox();
    const medStatusBox = await doseWorkingRow
      .getByTestId("prn-day-label")
      .boundingBox();
    expect(
      Math.abs((medNameBox?.x ?? 0) - (medStatusBox?.x ?? 0))
    ).toBeLessThan(2);
    await panelDoor.click();
    const earlierDose = doseWorkingRow.getByTestId("prn-log-options");
    await expect(earlierDose).toContainText("When was it taken?");
    await expect(earlierDose.getByLabel("Specific time")).toBeVisible();
    const earlierDoseBox = await earlierDose
      .getByText("When was it taken?")
      .boundingBox();
    expect(
      Math.abs((medNameBox?.x ?? 0) - (earlierDoseBox?.x ?? 0))
    ).toBeLessThan(2);
    await panelDoor.click();
    await medChip.click();
    await expect(page.getByTestId("cockpit-med-panel")).toHaveCount(0);
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
    // Target a DOSED (mg/mL) med row by content, not a positional first-match: under the pinned
    // clock (#1110) the seed's relative-time ibuprofen doses shift local-day, so the
    // FIRST med row is nondeterministic — a PRN with a non-mg/mL dose (Klor-Con
    // "10 mEq") can sort ahead and fail a bare first-match mg/mL assertion. The seed's
    // ibuprofen "200 mg" doses are always in the episode, so a mg/mL row is stable.
    const dosedMedicationRow = medicationRows
      .filter({ hasText: /\d+(?:\.\d+)?\s*(?:mg|mL)/i })
      .first(); // first-ok: filtered to a dosed (mg/mL) med row; all such rows render identically
    await expect(dosedMedicationRow).toBeVisible();
    await expect(dosedMedicationRow).toContainText(/mg|mL/i);
    const dosedLink = dosedMedicationRow.getByRole("link").first(); // first-ok: the med link inside the content-filtered dosed row — order-agnostic
    await expect(dosedLink).toHaveAttribute("href", /^\/medications\/\d+$/);
    await expect(dosedLink).toHaveClass(/text-link/); // #3607 item 3: the tone is `text-link` now
    await expect(
      page
        .getByTestId("illness-event-appointment")
        .filter({ hasText: "Lab results review" })
    ).toBeVisible();
    const dayGroups = page.getByTestId("illness-timeline-day");
    await expect(dayGroups.first()).toBeVisible(); // first-ok: a timeline day group — asserts its padding, order-agnostic
    await expect(dayGroups.first()).toHaveCSS("padding-top", "6px"); // first-ok: the same timeline day group — order-agnostic
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

    // Filters keep the complete ledger as the default but make a long episode
    // scannable. #2612 narrowed "complete" by ONE clause: a profile whose routine
    // SUPPLEMENT doses would outnumber everything else opens on an Illness chip
    // that hides them. This profile is not one — its `may` intake is the illness's
    // own medicine — so All still leads, which is now pinned rather than assumed.
    const historyFilters = page.getByTestId("illness-history-filters");
    await expect(
      historyFilters.getByRole("button", { name: "All" })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      historyFilters.getByRole("button", { name: "All" })
    ).not.toHaveClass(/bg-brand/);
    await historyFilters.getByRole("button", { name: "Temperature" }).click();
    const tempEvent = page.getByTestId("illness-event-temperature").first(); // first-ok: asserts a temperature event renders under the Temperature filter — order-agnostic
    await expect(tempEvent).toBeVisible();
    // A filtered-out row is HIDDEN, not removed (#2612): it leaves the layout so the
    // page shortens, stays in the document, and comes back under print so a printed
    // illness record never silently drops the doses given. The reader-facing claim
    // is therefore counted over VISIBLE rows — strictly more than the bare count
    // this replaces, which only said the rows were absent from the DOM.
    await expect(
      page.getByTestId("illness-event-medication").filter({ visible: true })
    ).toHaveCount(0);
    await expect(
      page.getByTestId("illness-event-appointment").filter({ visible: true })
    ).toHaveCount(0);
    await page.emulateMedia({ media: "print" });
    expect(
      await page
        .getByTestId("illness-event-medication")
        .evaluateAll((rows) =>
          rows.every((row) => getComputedStyle(row).display !== "none")
        )
    ).toBe(true);
    await page.emulateMedia({ media: null });
    await historyFilters.getByRole("button", { name: "All" }).click();
    const medEvent = page.getByTestId("illness-event-medication").first(); // first-ok: asserts a medication event renders under the All filter — order-agnostic
    await expect(medEvent).toBeVisible();
    // Historical symptom severity and notes can be corrected from the same ledger.
    const historicalSymptom = page
      .getByTestId("illness-event-symptom")
      .filter({ hasText: "Peaked in the evening" })
      .first(); // first-ok: filtered to the note THIS spec logged — one match
    const openSymptomEditor = async () => {
      await hydratedClick(
        page,
        historicalSymptom.getByTestId("overflow-menu-trigger")
      );
      await hydratedClick(
        page,
        page
          .getByRole("menu")
          .getByRole("menuitem", { name: "Edit", exact: true })
      );
      const editor = historicalSymptom.locator(
        "xpath=following-sibling::tr[@data-testid='illness-event-editor'][1]"
      );
      await expect(editor.getByLabel("Severity")).toBeVisible();
      return editor;
    };

    let symptomEditor = await openSymptomEditor();
    let symptomActions = symptomEditor.getByTestId(
      "illness-event-editor-actions"
    );
    let symptomSave = symptomActions.getByRole("button", { name: "Save" });
    let symptomCancel = symptomActions.getByRole("button", {
      name: "Cancel",
    });
    const desktopViewport = page.viewportSize();
    expect(
      desktopViewport,
      "the illness episode project has a fixed desktop viewport"
    ).not.toBeNull();
    await expectDesktopOrdinarySubmit({
      form: symptomEditor,
      owner: symptomActions,
      submit: symptomSave,
      adjacent: symptomCancel,
      name: "episode timeline Save",
    });
    await hydratedClick(page, symptomCancel);
    await page.setViewportSize({ width: 390, height: 844 });
    const earlierHistory = page.getByTestId("illness-history-earlier-toggle");
    if ((await earlierHistory.getAttribute("aria-expanded")) !== "true")
      await hydratedClick(page, earlierHistory);
    await expect(historicalSymptom).toBeVisible();
    symptomEditor = await openSymptomEditor();
    await symptomEditor
      .getByLabel("Note")
      .fill("Peaked in the evening — corrected");
    symptomActions = symptomEditor.getByTestId("illness-event-editor-actions");
    symptomSave = symptomActions.getByRole("button", { name: "Save" });
    symptomCancel = symptomActions.getByRole("button", { name: "Cancel" });
    await expectPhoneOrdinarySubmit({
      form: symptomEditor,
      owner: symptomActions,
      submit: symptomSave,
      adjacent: symptomCancel,
      name: "episode timeline Save",
    });
    await settledClick(page, symptomSave);
    await expect(historicalSymptom).toContainText(
      "Peaked in the evening — corrected"
    );
    // EpisodeTimeline toasts each save into the bottom-right stack, and this ledger
    // is long enough that the ⋯ trigger re-opened next sits in the same quadrant —
    // so the toast intercepts the re-open for its whole 6s window (#2861).
    await dismissToast(page, "Symptom updated.");
    await page.setViewportSize(desktopViewport!);
    symptomEditor = await openSymptomEditor();
    await symptomEditor.getByLabel("Note").fill("Peaked in the evening");
    await settledClick(
      page,
      symptomEditor.getByRole("button", { name: "Save" })
    );
    await expect(historicalSymptom).toContainText("Peaked in the evening");
    await dismissToast(page, "Symptom updated.");

    // Historical readings and doses have a real correction path from the ledger.
    const tempRow = page.getByTestId("illness-event-temperature").first(); // first-ok: a temperature event row (has a correction path) — order-agnostic
    await hydratedClick(page, tempRow.getByTestId("overflow-menu-trigger"));
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const eventEditor = page.getByTestId("illness-event-editor");
    await expect(eventEditor).toBeVisible();
    const dateTime = eventEditor.getByTestId("illness-event-date-time");
    // ONE DOOR FOR THE PAIR (#4218). A temperature reading REQUIRES its minute, on
    // a day the reader may still move inside the episode's window, so the editor
    // states both halves through ONE composed field over one panel holding the
    // calendar and the time wheel — where it used to draw a date box beside a
    // time box and this test measured that they shared a row.
    //
    // That row claim is now true by construction, so asserting it again would be
    // asserting nothing. What replaces it is the claim the composition actually
    // makes: there is exactly one field here, and no loose text box beside it.
    const whenDoor = dateTime.getByTestId("illness-event-when-when");
    await expect(whenDoor).toBeVisible();
    await expect(dateTime.locator('input:not([type="hidden"])')).toHaveCount(0);
    const saveBox = await eventEditor
      .getByRole("button", { name: "Save" })
      .boundingBox();
    const cancelBox = await eventEditor
      .getByRole("button", { name: "Cancel" })
      .boundingBox();
    expect(Math.abs((saveBox?.y ?? 0) - (cancelBox?.y ?? 0))).toBeLessThan(2);
    const editorActions = eventEditor.getByTestId(
      "illness-event-editor-actions"
    );
    await expect(editorActions).toHaveCSS("justify-content", "flex-end");
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
    const menu = await openEpisodeActions(page);
    await expect(
      menu.getByRole("menuitem", {
        name: /^(Promote to condition|Remove condition)$/,
      })
    ).toHaveCount(1);
    const promote = menu.getByRole("menuitem", {
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
    const footerBox = await appContent(page)
      .getByTestId("episode-summary-footer")
      .boundingBox();
    const toolsBox = await page
      .getByTestId("episode-update-workspace")
      .boundingBox();
    expect(footerBox?.y).toBeGreaterThan(toolsBox?.y ?? 0);

    // Log a symptom at a severity from the episode page — the SHARED SymptomLogBar now
    // uses the #857 active-first layout, so add via the picker then raise (the same
    // helpers the dashboard spec drives — one flow, no per-mount drift).
    const bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (top of the card) — order-agnostic
    await ensureUnlogged(bar, "sore_throat");
    await addFromPicker(bar, "sore_throat");
    await raiseSeverity(bar, "sore_throat", 3);

    // Log a temperature from the episode page (the entry is collapsed by default #857).
    restoreSharedDay = sharedDayRestorePoint(
      "medical_records",
      frozenNow().toISOString().slice(0, 10)
    );
    await openTempEntry(bar);
    await expect(bar.getByTestId("temp-quick-unit")).toHaveValue("F");
    await bar.getByTestId("temp-quick-input").fill("37.8");
    await expect(bar.getByTestId("temp-quick-unit")).toHaveValue("C");
    await expect(bar.getByTestId("temp-quick-detected")).toContainText(
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
    await expect(
      appContent(page).getByTestId("episode-care-context")
    ).toBeVisible();
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
    // Element-level containment (#1543): the app shell clips horizontal overflow,
    // so comparing the document's width to the viewport's would pass even with the
    // timeline's right-hand columns entirely off-screen.
    await expectNoClippedContent(page);
    await page.getByTestId("illness-add-medication").click();
    await expect(
      page.getByTestId("illness-medication-quick-add")
    ).toBeVisible();
    await expectNoClippedContent(page);
    const tableScroller = page.getByTestId("illness-timeline-table-wrap");
    await expect(tableScroller).toHaveCSS("overflow-x", "auto");
    await expect(tableScroller).toHaveCSS("scrollbar-width", "none");
    // The SHARED card mode, not a hand-rolled one (#2533 item 2). This row used to
    // pin `display: grid` — the bespoke `grid-cols-[4rem_minmax(0,1fr)_auto]` this
    // file kept for its own phone layout, the last surface still doing that. The
    // timeline renders through `<ResponsiveTable>` now, so a stacked row is the
    // primitive's wrapping flex line over the SAME cells every other table uses.
    await expect(medicationRows.last()).toHaveCSS("display", "flex");
  });

  test("a recently resolved illness can be reopened when symptoms return", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize(PHONE);
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

    const endEpisode = page.getByTestId("episode-end");
    await expectClosedEpisodeAction(endEpisode, "End episode");
    await endEpisode.click();
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
        await selected.first().uncheck(); // first-ok: loop unchecks EVERY selected item; first-of-remaining is order-agnostic
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
    await expectClosedEpisodeAction(reopen, "Reopen episode");
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
    await expect(rows.first()).toBeVisible(); // first-ok: asserts an episode-index row renders — order-agnostic presence
    expect(await rows.count()).toBeGreaterThanOrEqual(2); // open + past (seed)

    // Following a row opens its detail page.
    await followLink(page, rows.first(), /\/medical\/episodes\/\d+/); // first-ok: follows an episode-index row to its detail — order-agnostic
    await expect(
      page.getByRole("heading", { name: /Illness episode/ })
    ).toBeVisible();
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
      .first(); // first-ok: filtered to the resolved episode row (repeat-safe match) — order-agnostic
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
    const recoveredText = page.getByText("Recovered without a visit").first(); // first-ok: the resolution text also lives in the edit textarea (see comment); assert the paragraph — order-agnostic
    await expect(recoveredText).toBeVisible();
    const restedNote = page
      .getByRole("paragraph")
      .filter({ hasText: "Rested; plenty of fluids" })
      .first(); // first-ok: filtered to the resolution note THIS spec logged — one match
    await expect(restedNote).toBeVisible();
  });

  // The date axis stays inside its own viewBox (#4858). The last date tick is drawn
  // at x = W - PLOT_RIGHT = 312 of a 320-unit viewBox, so a label CENTRED on it
  // hangs (width / 2 - 8) user units past the viewBox and the `<svg>` clips it —
  // silently, because the `<svg>` box itself fits the viewport fine.
  //
  // WHY THIS DRIVES ITS OWN FIXTURE AND NOT PROFILE 1, which is the whole reason to
  // anchor rather than to widen PLOT_RIGHT. Profile 1 renders "Sep 3" — 24.8px, or
  // 22.2 user units at this viewport — so a centred label clears the edge by at most
  // 3.1 user units, AND its last reading's clock time moves with the run, which
  // slides the tick left of 312. Measured on the pre-fix tree at 390px, profile 1's
  // last label ran [348.1, 373.0] against an `<svg>` right edge of 374.0: it FIT, by
  // 1.0px. That is why the shared clipping guard reds on some runs and not others.
  // This fixture removes both variables: a noon last reading pins the tick to 312,
  // and the login's ISO date format makes the label "2026-09-03" (48.6px, 43.4 user
  // units), which overflows by 15.3px on every run. Both numbers come from the same
  // measurement — the probe run recorded in this change's commit message.
  test("anchors the fever chart's end date ticks inside its viewBox", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FEVER_AXIS,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await openCurrentEpisode(page);
      const chart = page.getByTestId("episode-fever-chart");
      await expect(chart).toBeVisible();

      // Wait for the tick this test is about before measuring anything — the label
      // is the content, and an empty plot fits any width.
      const ticks = chart.locator("text[text-anchor]");
      await expect(ticks.last()).toHaveText(/^\d{4}-\d{2}-\d{2}$/);

      // The DEFECT first, through the guard that owns this question for every chart
      // (#1573): every `<svg text>` paints inside its own plot. Reverting the
      // anchoring reds here, naming the label and the box it escaped, rather than
      // reding on the spelling below and leaving the reader to infer the harm.
      await expectSvgTextInsidePlot(page);

      // Then the mechanism, named rather than inferred from geometry: the ends
      // anchor to the plot, everything between stays centred on its own tick.
      // Read as one array so the axis is pinned end to end — the tick COUNT
      // included, since the fixture's four readings are what put a tick on the
      // plot edge in the first place.
      expect(
        await ticks.evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("text-anchor"))
        )
      ).toEqual(["start", "middle", "middle", "end"]);
    } finally {
      await page.context().close();
    }
  });
});
