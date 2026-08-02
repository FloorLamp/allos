import { test, expect } from "./fixtures";
import { hydratedClick } from "./helpers";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// Issue #1497 is a phone-height composition change. These checks run in the
// 390×844 mobile project by filename: record lists lead, rare entry stays behind
// + Add on every viewport, and row CRUD uses the shared overflow menu.

const VIEWPORT_HEIGHT = 844;

test("Visits leads with Upcoming then Past, and keeps entry behind + Add (#1497)", async ({
  page,
}) => {
  await page.goto("/records/history/visits");

  const upcoming = page.getByTestId("visits-upcoming");
  const past = page.getByTestId("visits-past");
  const addPanel = page.getByTestId("add-visit-panel");
  await expect(upcoming).toBeVisible();
  await expect(past).toBeVisible();
  await expect(addPanel).toHaveAttribute("data-open", "false");
  await expect(page.getByTestId("visits-add")).toBeHidden();
  await expect(page.getByTestId("add-visit-panel-toggle")).toHaveClass(
    /\bbtn\b/
  );

  // The primary add CTA leads, followed by the two visit lists.
  expect(
    await page.evaluate(() => {
      const upcomingNode = document.querySelector(
        '[data-testid="visits-upcoming"]'
      )!;
      const pastNode = document.querySelector('[data-testid="visits-past"]')!;
      const addNode = document.querySelector(
        '[data-testid="add-visit-panel"]'
      )!;
      return [
        !!(
          addNode.compareDocumentPosition(upcomingNode) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
        !!(
          upcomingNode.compareDocumentPosition(pastNode) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
      ];
    })
  ).toEqual([true, true]);

  // Scheduled appointment state changes stay inline.
  const scheduled = upcoming.getByTestId("appointment-row").nth(0);
  await expect(scheduled.getByLabel("Mark completed")).toBeVisible();
  await expect(scheduled.getByLabel("Cancel appointment")).toBeVisible();
  await expect(scheduled.getByLabel("Appointment actions")).toBeVisible();

  // Past-record CRUD is in the shared overflow menu, not two inline icons.
  const pastActions = past.getByLabel("Record actions").nth(0);
  await expect(pastActions).toBeVisible();
  await hydratedClick(page, pastActions);
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.keyboard.press("Escape");

  await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
  await expect(addPanel).toHaveAttribute("data-open", "true");
  await expect(page.getByRole("dialog", { name: "Add visit" })).toBeVisible();
  await expect(page.getByTestId("visits-add")).toBeVisible();
});

test("a Visits focus deep link opens entry without secondary description chrome (#1497)", async ({
  page,
}) => {
  await page.goto("/records/history/visits?focus=add");

  await expect(page.getByTestId("add-visit-panel")).toHaveAttribute(
    "data-open",
    "true"
  );
  const dialog = page.getByRole("dialog", { name: "Add visit" });
  await expect(dialog).toBeVisible();
  await hydratedClick(page, dialog.getByRole("button", { name: "Close" }));
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("add-visit-panel-toggle")).toBeFocused();
  const intro = page.getByTestId("records-pane-intro");
  await expect(
    intro.getByText("Manage upcoming appointments and your visit history.")
  ).toBeVisible();
  await expect(intro.getByText("More", { exact: true })).toHaveCount(0);
});

test("the first data row fits in the first viewport on key record panes (#1497)", async ({
  page,
}) => {
  const checks = [
    {
      href: "/records/history/visits",
      row: () => page.getByTestId("appointment-row").nth(0),
    },
    {
      href: "/records/problems/conditions",
      row: () => page.getByTestId("records-conditions").getByRole("row").nth(1),
    },
    {
      href: "/records/history/immunizations",
      row: () =>
        page
          .getByTestId("records-immunizations")
          .getByRole("table")
          .nth(0)
          .getByRole("row")
          .nth(1),
    },
  ];

  for (const check of checks) {
    await page.goto(check.href);
    const row = check.row();
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeLessThan(VIEWPORT_HEIGHT);
  }
});

test("record tables keep md-only columns hidden at the sm breakpoint", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: VIEWPORT_HEIGHT });
  await page.goto("/records/problems/conditions");

  const row = page
    .getByTestId("records-conditions")
    .locator("tbody tr")
    .filter({ hasText: "E2E Hay fever" });
  const onsetCell = row.locator("td").nth(3);
  await expect(onsetCell).toBeHidden();

  await page.setViewportSize({ width: 800, height: VIEWPORT_HEIGHT });
  await expect(onsetCell).toBeVisible();
});

test("document-backed records avoid duplicate source links on mobile", async ({
  page,
}) => {
  await page.goto("/records/problems/conditions");
  const condition = page.locator("tr").filter({ hasText: "E2E Hay fever" });
  await expect(condition.getByTestId("source-document-link")).toHaveCount(0);
  await expect(condition.getByTestId("record-provenance-link")).toHaveAttribute(
    "href",
    "/import/908"
  );
  await expect(condition.locator('a[href="/import/908"]')).toHaveCount(1);

  await page.goto("/records/history/visits");
  const visit = page.locator("tr").filter({ hasText: "E2E Browser Visit" });
  // Visits deliberately omit provenance from the compact table. The visit title
  // links to the encounter detail, where its source document remains available.
  await expect(visit.getByTestId("source-document-link")).toHaveCount(0);
  await expect(visit.getByTestId("record-provenance-link")).toHaveCount(0);
  await expect(visit.locator('a[href="/import/908"]')).toHaveCount(0);
  await expect(
    visit.getByRole("link", { name: "E2E Browser Visit" })
  ).toBeVisible();

  await page.goto("/records/history/immunizations");
  await hydratedClick(page, page.getByText("All recorded doses"));
  const dose = page.locator("tr").filter({ hasText: "E2E Tdap" });
  // Immunizations use source='document:<id>' rather than a document_id column;
  // the shared resolver gives them the same link contract as every other row.
  await expect(dose.getByTestId("source-document-link")).toHaveCount(0);
  await expect(dose.getByTestId("record-provenance-link")).toHaveAttribute(
    "href",
    "/import/908"
  );
  await expect(dose.locator('a[href="/import/908"]')).toHaveCount(1);
});

test("an imported appointment uses an explicit source-document link", async ({
  page,
}) => {
  const title = "E2E Document Appointment";
  const db = new Database(workerDbPath());
  const appointmentId = Number(
    db
      .prepare(
        `INSERT INTO appointments
           (profile_id, scheduled_at, title, status, document_id, source)
         VALUES (1, '2026-08-10 09:00', ?, 'scheduled', 908, 'document:908')`
      )
      .run(title).lastInsertRowid
  );
  db.close();

  try {
    await page.goto("/records/history/visits");
    const row = page.getByTestId("appointment-row").filter({ hasText: title });
    await expect(row.getByText(title, { exact: true })).not.toHaveRole("link");
    await expect(row.getByTestId("source-document-link")).toHaveAttribute(
      "href",
      "/import/908"
    );
    await expect(row.getByTestId("source-document-link")).toHaveText(
      "Source document"
    );
    await expect(row.locator('a[href="/import/908"]')).toHaveCount(1);
  } finally {
    const cleanup = new Database(workerDbPath());
    cleanup
      .prepare("DELETE FROM appointments WHERE id = ? AND profile_id = 1")
      .run(appointmentId);
    cleanup.close();
  }
});
