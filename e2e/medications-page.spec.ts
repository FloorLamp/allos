import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { followLink } from "./helpers";

// #817 Medications page redesign: the Today panel (scheduled dose check-off + PRN
// administration row), the /medications/[id] clinical-record detail page, and the
// "From your records" suggest-only bridge (Track this / dismiss). Fixtures come from
// e2e/seed-events.ts: "Adherence Refill Med (e2e)" (current daily, scheduled),
// "PRN Quicklog Med (e2e)" (PRN with administrations), and two untracked prescription
// records ("E2E Bridge Track Med" / "E2E Bridge Dismiss Med").
//
// #868 fixture ownership: the last two tests MUTATE shared-seed bridge state that
// persists — "Track this" materializes a tracked med from the imported record, and
// "Dismiss" writes a med-bridge suppression to upcoming_dismissals. Both leak into a
// second --repeat-each run (the suggestion is gone → the "suggestion visible" assertion
// fails). resetBridgeState() restores the seeded UNTRACKED state before each test:
// delete any tracked med minted from the bridge record (children cascade) and clear the
// med-bridge dismissals. Short-lived connection + busy timeout so it never contends with
// the running server on the WAL DB. The bridge records sit on the admin's active profile 1.
const BRIDGE_PROFILE_ID = 1;
function resetBridgeState(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON"); // so deleting the tracked med cascades its children
    db.prepare(
      `DELETE FROM intake_items
        WHERE profile_id = ? AND kind = 'medication' AND source = 'extracted'
          AND name LIKE 'E2E Bridge Track%'`
    ).run(BRIDGE_PROFILE_ID);
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'med-bridge:%'"
    ).run(BRIDGE_PROFILE_ID);
  } finally {
    db.close();
  }
}

test.beforeEach(() => {
  resetBridgeState();
});

test("Today panel leads with a due scheduled dose and a PRN administration row", async ({
  page,
}) => {
  await page.goto("/medications");

  const today = page.getByTestId("medications-today");
  await expect(today).toBeVisible();

  // A scheduled, currently-due med shows its tri-state dose check-off inline.
  const scheduled = today
    .getByTestId("today-scheduled-med")
    .filter({ hasText: "Adherence Refill Med (e2e)" });
  await expect(scheduled).toBeVisible();
  await expect(scheduled.getByTestId("dose-status").first()).toBeVisible();

  // A PRN med shows a one-tap administration row (not a scheduled pill).
  await expect(
    today
      .getByTestId("quick-log-prn-item")
      .filter({ hasText: "PRN Quicklog Med (e2e)" })
  ).toBeVisible();

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

  const list = page.getByTestId("medication-list");
  await expect(list).toBeVisible();
  await expect(
    list.getByRole("heading", { name: "Current medications" })
  ).toBeVisible();

  const row = list
    .getByTestId("medication-row")
    .filter({ hasText: "Adherence Refill Med (e2e)" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("medication-dose-summary")).toContainText(
    "1 tablet · Morning"
  );
  // Rows are divided within the shared list surface, not inset as cards.
  await expect(row).not.toHaveClass(/\bcard\b/);
  await expect(row.getByTestId("medication-row-link")).toHaveClass(
    /hover:bg-slate-50/
  );

  const past = page.getByTestId("past-medications");
  await expect(past).toBeVisible();
  await expect(past).not.toHaveAttribute("open", "");
  await expect(past).toContainText("completed or stopped");
  await expect(past.locator("summary")).toHaveClass(/hover:bg-slate-50/);
  await past.locator("summary").click();
  const pastRow = past
    .getByTestId("medication-row")
    .filter({ hasText: "Amoxicillin" });
  await expect(pastRow).toBeVisible();
  await expect(pastRow).toContainText("Completed course");
  const pastName = pastRow.getByTestId("medication-name");
  await expect(pastName).toHaveClass(/text-slate-600/);

  // The outer disclosure is also a Tailwind group. Its hover must not activate
  // every nested medication link; only the directly-hovered named link underlines.
  await past.locator("summary").hover();
  await expect(pastName).toHaveCSS("text-decoration-line", "none");
  await pastRow.getByTestId("medication-row-link").hover();
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
  const row = page
    .getByTestId("medication-row")
    .filter({ hasText: "Adherence Refill Med (e2e)" });

  await row.getByRole("button", { name: "Medication actions" }).click();
  await followLink(
    page,
    page.getByRole("menuitem", { name: "Edit" }),
    /\/medications\/\d+\?action=edit$/
  );
  await expect(page.getByRole("combobox", { name: "Name" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/medications");
  const refreshedRow = page
    .getByTestId("medication-row")
    .filter({ hasText: "Adherence Refill Med (e2e)" });
  await refreshedRow
    .getByRole("button", { name: "Medication actions" })
    .click();
  await followLink(
    page,
    page.getByRole("menuitem", { name: "Stop medication" }),
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
  await expect(page.getByTestId("medication-list")).toBeVisible();
  const scheduled = page
    .getByTestId("today-scheduled-med")
    .filter({ hasText: "Adherence Refill Med (e2e)" });
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

  const link = page
    .getByTestId("medication-row")
    .filter({ hasText: "Adherence Refill Med (e2e)" })
    .getByTestId("medication-row-link");
  await expect(link).toBeVisible();
  const detail = page.getByTestId("medication-detail");
  // Navigate past the pre-hydration swallow (#730/#500) with the blessed followLink (#868).
  await followLink(page, link, /\/medications\/\d+/);
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Adherence Refill Med (e2e)");
  // The detail page is the clinical-record home: its History disclosure (courses +
  // side effects) is open by default.
  await expect(detail).toContainText(/Courses/);

  // Scheduled and PRN details share the same first-row structure: Overview and
  // Details are equal-width peers. Scheduled-only adherence follows full-width.
  const overview = detail.getByTestId("medication-overview");
  const guidance = detail.getByTestId("medication-guidance");
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
  await expect(
    doseHistory.getByTestId("dose-history-row").first()
  ).not.toContainText("(just now)");
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

test("records bridge tracks an imported prescription that has no tracked med", async ({
  page,
}) => {
  await page.goto("/medications");

  const bridge = page.getByTestId("records-bridge");
  await expect(bridge).toBeVisible();
  const item = bridge
    .getByTestId("records-bridge-item")
    .filter({ hasText: "E2E Bridge Track Med" });
  await expect(item).toBeVisible();

  // "Track this" is a client onClick — retry the tap to ride out the hydration
  // window (#730), asserting the suggestion clears once it lands.
  await expect(async () => {
    await item.getByTestId("records-bridge-track").click();
    await expect(
      page
        .getByTestId("records-bridge-item")
        .filter({ hasText: "E2E Bridge Track Med" })
    ).toHaveCount(0, { timeout: 3000 });
  }).toPass();

  // The tracked med now appears as a current medication row.
  await expect(
    page
      .getByTestId("medication-row")
      .filter({ hasText: "E2E Bridge Track Med" })
  ).toBeVisible();
});

test("records bridge dismisses a suggestion via the findings bus", async ({
  page,
}) => {
  await page.goto("/medications");

  const item = page
    .getByTestId("records-bridge-item")
    .filter({ hasText: "E2E Bridge Dismiss Med" });
  await expect(item).toBeVisible();

  // Dismiss is a client onClick — retry the tap to ride out the hydration window
  // (#730), asserting the suggestion clears once it lands.
  await expect(async () => {
    await item.getByTestId("records-bridge-dismiss").click();
    await expect(item).toHaveCount(0, { timeout: 3000 });
  }).toPass();

  // The dismissal stays gone across a reload (persisted on the findings bus).
  await page.reload();
  await expect(
    page
      .getByTestId("records-bridge-item")
      .filter({ hasText: "E2E Bridge Dismiss Med" })
  ).toHaveCount(0);
});
