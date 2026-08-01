import { test, expect } from "./fixtures";
import { hydratedClick } from "./helpers";

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
    .first();
  const onsetCell = row.locator("td").nth(3);
  await expect(onsetCell).toBeHidden();

  await page.setViewportSize({ width: 800, height: VIEWPORT_HEIGHT });
  await expect(onsetCell).toBeVisible();
});
