import { test, expect, type Page, type Locator } from "@playwright/test";
import { followLink } from "./helpers";
import {
  medicationList,
  pastMedications,
  medicationRow,
  medicationRowLink,
  medicationDoseSummary,
  medicationName,
  medicationOverview,
  medicationGuidance,
  medicationsToday,
  scheduledTodayItem,
  prnTodayItem,
  openMedDetailViaLink,
} from "./med-card-helpers";

// Open a medication row's portaled "⋯" actions menu and navigate via one of its
// item links. Two hydration races stack here (the #1139 portaled-"Stop medication"
// flake, deterministic once CI dropped to retries=0 under full-suite load): (1) a
// click on the trigger during the post-navigation hydration window is swallowed so
// the portal never opens, and (2) a pre-hydration click on the item link dismisses
// the menu WITHOUT navigating, so a plain followLink then retries a click on a
// menuitem that no longer exists. The menu is CLIENT-SIDE (no Server-Action POST to
// settle on), so the honest fix is ONE retry loop that (re)opens the menu if it
// closed, clicks the item, and waits for the URL to commit — every step retried
// together, so a closed menu is simply reopened on the next attempt.
async function openRowMenuItemAndFollow(
  page: Page,
  row: Locator,
  itemName: string,
  destination: RegExp
): Promise<void> {
  const item = page.getByRole("menuitem", { name: itemName });
  await expect(async () => {
    if (!(await item.isVisible().catch(() => false))) {
      await row.getByRole("button", { name: "Medication actions" }).click();
      await expect(item).toBeVisible({ timeout: 2_000 });
    }
    await item.click();
    await page.waitForURL(destination, { timeout: 3_000 });
  }).toPass({ timeout: 20_000 }); // topass-ok: reopen-if-closed + click + await-URL for a client-side portaled menu-nav past post-nav hydration — no awaitable POST to settle on
}

// #817 Medications page redesign: the Today panel (scheduled dose check-off + PRN
// administration row) and the /medications/[id] clinical-record detail page.
// Fixtures come from e2e/seed-events.ts: "Adherence Refill Med (e2e)" (current
// daily, scheduled) and "PRN Quicklog Med (e2e)" (PRN with administrations).
// (The "From your records" bridge tests left with their fixture in #1232: no
// current write path can produce the medical_records 'prescription' rows the
// bridge reads — migration 092 consolidated them into intake_items — so the
// seeded suggestions re-created a state the app can never reach. The bridge
// actions stay covered at the action tier, lib/__action_tests__/
// medication-bridge.actions.test.ts.)

test("Today panel leads with a due scheduled dose and a PRN administration row", async ({
  page,
}) => {
  await page.goto("/medications");

  const today = medicationsToday(page);
  await expect(today).toBeVisible();

  // A scheduled, currently-due med shows its tri-state dose check-off inline.
  const scheduled = scheduledTodayItem(today, "Adherence Refill Med (e2e)");
  await expect(scheduled).toBeVisible();
  await expect(scheduled.getByTestId("dose-status").first()).toBeVisible(); // first-ok: scoped to the uniquely-named Adherence Refill Med (e2e) Today card; its own first dose-status pill

  // A PRN med shows a one-tap administration row (not a scheduled pill).
  await expect(prnTodayItem(today, "PRN Quicklog Med (e2e)")).toBeVisible();

  // The amount aligns beside the medication name, matching an as-needed row. The
  // scheduled time and overdue status sit in the metadata column; the action cluster
  // on the right contains only take/skip controls.
  await expect(scheduled.getByRole("link")).toContainText("1 tablet");
  await expect(scheduled.getByRole("link")).toContainText("Morning");
  await expect(scheduled).toHaveAttribute("data-past-due", "1");
  await expect(scheduled.getByText("Past due", { exact: true })).toBeVisible();
  await expect(scheduled.getByTestId("dose-take")).toContainText("Mark taken");
  await expect(scheduled.getByTestId("dose-take")).not.toContainText(
    "1 tablet"
  );

  // Once skipped, the skip state owns the emphasis. "Mark taken" remains available
  // as a correction, but is no longer styled as the row's primary CTA.
  const skip = scheduled.getByTestId("dose-skip");
  await skip.click();
  await expect(skip).toHaveAttribute("aria-pressed", "true");
  await expect(scheduled.getByTestId("dose-take")).not.toHaveClass(/bg-brand-/);
  await expect(skip).toHaveClass(/rounded-lg/);
  await expect(skip).not.toHaveClass(/rounded-full/);
  await expect(skip).toHaveClass(/bg-amber-100/);
  await expect(skip).toHaveClass(/cursor-default/);
  await expect(skip).not.toHaveClass(/hover:bg-amber/);
  await expect(scheduled.getByTestId("dose-take")).toHaveClass(/bg-slate-50/);
  await skip.click();
  await expect(skip).toHaveAttribute("aria-pressed", "false");

  const take = scheduled.getByTestId("dose-take");
  await take.click();
  await expect(take).toHaveAttribute("aria-pressed", "true");
  await expect(take).toHaveClass(/cursor-default/);
  await expect(take).not.toHaveClass(/hover:bg-white/);
  await expect(skip).toHaveClass(/bg-slate-50/);
  await take.click();
  await expect(take).toHaveAttribute("aria-pressed", "false");
});

test("the page clearly separates current and past medications", async ({
  page,
}) => {
  await page.goto("/medications");

  const list = medicationList(page);
  await expect(list).toBeVisible();
  await expect(
    list.getByRole("heading", { name: "Current medications" })
  ).toBeVisible();

  const row = medicationRow(list, "Adherence Refill Med (e2e)");
  await expect(row).toBeVisible();
  await expect(medicationDoseSummary(row)).toContainText("1 tablet · Morning");
  // Rows are divided within the shared list surface, not inset as cards.
  await expect(row).not.toHaveClass(/\bcard\b/);
  await expect(medicationRowLink(row)).toHaveClass(/hover:bg-slate-50/);

  const past = pastMedications(page);
  await expect(past).toBeVisible();
  await expect(past).not.toHaveAttribute("open", "");
  await expect(past).toContainText("completed or stopped");
  await expect(past.locator("summary")).toHaveClass(/hover:bg-slate-50/);
  await past.locator("summary").click();
  const pastRow = medicationRow(past, "Amoxicillin");
  await expect(pastRow).toBeVisible();
  await expect(pastRow).toContainText("Completed course");
  const pastName = medicationName(pastRow);
  await expect(pastName).toHaveClass(/text-slate-600/);

  // The outer disclosure is also a Tailwind group. Its hover must not activate
  // every nested medication link; only the directly-hovered named link underlines.
  await past.locator("summary").hover();
  await expect(pastName).toHaveCSS("text-decoration-line", "none");
  await medicationRowLink(pastRow).hover();
  await expect(pastName).toHaveCSS("text-decoration-line", "underline");

  await expect(
    list.getByRole("link", { name: "Print medication list" })
  ).toBeVisible();
  await expect(
    list.getByRole("button", { name: "Share medication list" })
  ).toBeVisible();

  // Row maintenance actions are available without first opening the detail page.
  await row.getByRole("button", { name: "Medication actions" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
    "href",
    /\/medications\/\d+\?action=edit$/
  );
  await expect(
    menu.getByRole("menuitem", { name: "Stop medication" })
  ).toHaveAttribute("href", /\/medications\/\d+\?action=stop$/);
});

test("medication row actions open the requested detail workflow", async ({
  page,
}) => {
  await page.goto("/medications");
  const row = medicationRow(page, "Adherence Refill Med (e2e)");

  await openRowMenuItemAndFollow(
    page,
    row,
    "Edit",
    /\/medications\/\d+\?action=edit$/
  );
  await expect(page.getByRole("combobox", { name: "Name" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/medications");
  const refreshedRow = medicationRow(page, "Adherence Refill Med (e2e)");
  await openRowMenuItemAndFollow(
    page,
    refreshedRow,
    "Stop medication",
    /\/medications\/\d+\?action=stop$/
  );
  await expect(page.getByTestId("stop-medication-form")).toBeVisible();
});

test("Add medication opens one inline quick-add and full-details workspace", async ({
  page,
}) => {
  await page.goto("/medications");

  const panel = page.getByTestId("medication-add-panel");
  await expect(panel).toHaveCount(0);
  await page.getByTestId("medication-add-toggle").click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("quick-add-medication")).toBeVisible();

  await panel.getByTestId("medication-add-full").click();
  await expect(panel.getByTestId("quick-add-medication")).toHaveCount(0);
  const nameInput = panel.getByRole("combobox", { name: "Name" });
  await expect(nameInput).toBeVisible();
  // Before a catalog medication is selected there is no description preview in
  // the second column, so the identity controls should use the available width
  // instead of leaving half the form blank.
  const [detailsGridBox, nameInputBox] = await Promise.all([
    panel.getByTestId("medication-details-grid").boundingBox(),
    nameInput.boundingBox(),
  ]);
  expect(detailsGridBox).not.toBeNull();
  expect(nameInputBox).not.toBeNull();
  expect(nameInputBox!.width / detailsGridBox!.width).toBeGreaterThan(0.9);
  const scheduledStart = panel.getByLabel("Started on");
  const scheduledStartDisplay = await scheduledStart.inputValue();
  expect(scheduledStartDisplay).not.toBe("");

  const asNeededControl = panel.getByRole("checkbox", { name: /As needed/ });
  const asNeededLabel = asNeededControl.locator("xpath=ancestor::label");
  expect(
    await asNeededControl.evaluate(
      (element) => getComputedStyle(element).cursor
    )
  ).toBe("pointer");
  expect(
    await asNeededLabel.evaluate((element) => getComputedStyle(element).cursor)
  ).toBe("pointer");

  await asNeededControl.check();
  const usingSince = panel.getByLabel(/Using since/);
  await expect(usingSince).toHaveValue("");
  await expect(usingSince).not.toHaveAttribute("required");
  await expect(
    panel.getByText("Leave blank if you don’t know when you started using it.")
  ).toBeVisible();

  await asNeededControl.uncheck();
  await expect(panel.getByLabel("Started on")).toHaveValue(
    scheduledStartDisplay
  );
  await expect(panel.getByLabel("Started on")).toHaveAttribute("required");

  await asNeededControl.evaluate((element) => {
    (element as HTMLInputElement).disabled = true;
  });
  expect(
    await asNeededControl.evaluate(
      (element) => getComputedStyle(element).cursor
    )
  ).toBe("not-allowed");
  expect(
    await asNeededLabel.evaluate((element) => getComputedStyle(element).cursor)
  ).toBe("not-allowed");

  await page.getByTestId("medication-add-toggle").click();
  await expect(panel).toHaveCount(0);
});

test("the medication workspace stays usable without horizontal overflow on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/medications");

  await expect(page.getByTestId("medication-add-toggle")).toBeVisible();
  await expect(medicationList(page)).toBeVisible();
  const scheduled = scheduledTodayItem(page, "Adherence Refill Med (e2e)");
  const [scheduledLinkBox, scheduledActionBox] = await Promise.all([
    scheduled.getByRole("link").boundingBox(),
    scheduled.getByTestId("dose-take").boundingBox(),
  ]);
  expect(scheduledLinkBox).not.toBeNull();
  expect(scheduledActionBox).not.toBeNull();
  expect(
    Math.abs(scheduledLinkBox!.y - scheduledActionBox!.y)
  ).toBeLessThanOrEqual(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);

  await page.getByTestId("medication-add-toggle").click();
  await expect(page.getByTestId("quick-add-medication")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test("a medication row links to its clinical-record detail page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.goto("/medications");

  // Navigate past the pre-hydration swallow (#730/#500) via the shared driver's blessed
  // followLink strategy (#868); it returns the (unasserted) detail Locator.
  const detail = await openMedDetailViaLink(page, "Adherence Refill Med (e2e)");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Adherence Refill Med (e2e)");
  // The detail page is the clinical-record home: its History disclosure (courses +
  // side effects) is open by default.
  await expect(detail).toContainText(/Courses/);

  // Scheduled and PRN details share the same first-row structure: Overview and
  // Details are equal-width peers. Scheduled-only adherence follows full-width.
  const overview = medicationOverview(detail);
  const guidance = medicationGuidance(detail);
  const adherence = detail.getByTestId("medication-adherence-month");
  const [overviewBox, guidanceBox, adherenceBox] = await Promise.all([
    overview.boundingBox(),
    guidance.boundingBox(),
    adherence.boundingBox(),
  ]);
  expect(overviewBox).not.toBeNull();
  expect(guidanceBox).not.toBeNull();
  expect(adherenceBox).not.toBeNull();
  expect(Math.abs(overviewBox!.y - guidanceBox!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(overviewBox!.width - guidanceBox!.width)).toBeLessThanOrEqual(
    2
  );
  expect(
    Math.abs(overviewBox!.height - guidanceBox!.height)
  ).toBeLessThanOrEqual(2);
  expect(adherenceBox!.y).toBeGreaterThan(overviewBox!.y + overviewBox!.height);

  // At the same 1024px breakpoint, the compact calendar uses the card's width by
  // stacking its legend in a right-hand column instead of leaving dead space.
  const calendarGrid = adherence.getByTestId("adherence-calendar-grid");
  const calendarDays = adherence.getByTestId("adherence-calendar-days");
  const calendarLegend = adherence.getByTestId("adherence-calendar-legend");
  const [calendarGridBox, calendarDaysBox, calendarLegendBox] =
    await Promise.all([
      calendarGrid.boundingBox(),
      calendarDays.boundingBox(),
      calendarLegend.boundingBox(),
    ]);
  expect(calendarGridBox).not.toBeNull();
  expect(calendarDaysBox).not.toBeNull();
  expect(calendarLegendBox).not.toBeNull();
  expect(calendarGridBox!.width).toBeLessThanOrEqual(260);
  expect(calendarLegendBox!.x).toBeGreaterThan(
    calendarGridBox!.x + calendarGridBox!.width
  );
  expect(calendarLegendBox!.width).toBeLessThanOrEqual(132);
  expect(
    Math.abs(calendarDaysBox!.y - calendarLegendBox!.y)
  ).toBeLessThanOrEqual(2);

  const doseHistory = detail.getByTestId("dose-history");
  // The newest seeded dose is from yesterday. Its database insertion timestamp is
  // today, but history must use the dose's logical date before adding relative age.
  const newestDoseRow = doseHistory.getByTestId("dose-history-row").first(); // first-ok: newest row on the uniquely-named "Adherence Refill Med (e2e)" detail page; deterministically yesterday's seeded dose — the only sibling that logs a dose (medications-followups) targets a different med (PRN Quicklog Med), so no concurrent write can push a newer row here
  await expect(newestDoseRow).not.toContainText("(just now)");
  await doseHistory.getByRole("button", { name: "Log past dose" }).click();
  const historyForm = doseHistory.getByTestId("historical-dose-form");
  await expect(historyForm).toContainText(
    "updates adherence history for that date"
  );
  await historyForm.getByRole("button", { name: "Cancel" }).click();

  // A structured prescriber is a real navigation target, not inert metadata.
  const providerLink = overview.getByRole("link", {
    name: "E2E Browser Clinic",
  });
  await expect(providerLink).toHaveAttribute("href", /\/providers\/\d+$/);
  await followLink(page, providerLink, /\/providers\/\d+$/);
  await expect(page.getByTestId("provider-detail")).toContainText(
    "E2E Browser Clinic"
  );
});
