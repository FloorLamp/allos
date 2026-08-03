import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { openCommandPalette } from "./nav";
import { hydratedClick } from "./helpers";
import { workerDbPath } from "./worker-env";

// The bottom edge stacks; it does not overlap (issue #1520, part B).
//
// Four fixed surfaces converge on the phone's bottom edge — the workout dock
// (full-width base layer), the toast stack and offline pill (notices), and the
// offline error panel (alerts). Each used to hand-write `bottom: max(1rem,
// safe-area)` in isolation, so a toast raised DURING a live workout landed on top
// of the dock: the confirmation covered the "still working out?" bar. They now
// share components/overlay's bottom-edge tokens, and the dock publishes its height
// into `--bottom-edge-offset` while mounted, so the notice layers clear it.
//
// Asserted as GEOMETRY (bounding boxes), not pixels or classes: the toast's bottom
// edge must sit at or above the dock's top edge.
//
// Fixture discipline (#868): create-and-clean on the admin profile — this spec
// starts its OWN live session (the same pattern workout-presence.spec.ts uses for
// its interactive case) and discards it, and the one body-metric row its toast
// comes from is deleted by value in the finally.

const DB_PATH = workerDbPath();
// A weight no seed or other spec logs, so the cleanup below can key on it.
const TOAST_WEIGHT = "77.3";

function cleanupMetric() {
  const h = new Database(DB_PATH);
  try {
    h.prepare("DELETE FROM body_metrics WHERE weight_kg = ?").run(
      Number(TOAST_WEIGHT)
    );
  } finally {
    h.close();
  }
}

// Pick an activity in the editor's exercise combobox (the shape-tolerant matcher
// the training specs document — an exact typed match collapses the list to a
// single 'Use "…"' button).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

test("a toast raised during a live workout stacks above the dock, never over it (#1520)", async ({
  page,
}) => {
  test.slow();
  try {
    // Start a live session from the mobile bar's own shortcut, then log enough of
    // a set that the draft auto-saves — that INSERT is the presence the dock reads.
    await page.goto("/training");
    await hydratedClick(page, page.getByTestId("start-workout-mobile"));
    await expect(page.getByTestId("live-workout-panel")).toBeVisible();
    await pickActivity(page, "Barbell Bench Press");
    await page
      .getByTestId("next-set-card")
      .getByRole("button", { name: "Use" })
      .click();
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeVisible();

    // Minimize and leave the training route (which hosts the inline editor instead
    // of the bar) — the app-wide dock is then up on every other page. Equipment is
    // deliberately the landing spot rather than the dashboard: the quick-log below
    // resolves only once its revalidation has re-rendered the CURRENT route, and the
    // dashboard is the app's heaviest render.
    await page.getByTestId("minimize-workout").click();
    await page.goto("/equipment");
    const dock = page.getByTestId("workout-dock");
    await expect(dock).toBeVisible();

    // Raise a real toast: the palette's inline quick-log writes a body metric and
    // confirms it — the ordinary "I just did something" notice.
    const input = await openCommandPalette(page);
    await input.fill(`weight ${TOAST_WEIGHT}`);
    await expect(page.getByTestId("palette-quicklog")).toContainText(
      TOAST_WEIGHT
    );
    await input.press("Enter");
    // Generous window: the toast follows a Server Action + revalidation round trip,
    // which on a loaded runner is comfortably past the default 5s assertion budget.
    const toast = page.getByTestId("toast");
    await expect(toast).toBeVisible({ timeout: 25_000 });

    // The stacking rule, as geometry: the toast ends where the dock begins (or
    // above it), instead of covering the bar.
    const toastBox = await toast.boundingBox();
    const dockBox = await dock.boundingBox();
    expect(toastBox).not.toBeNull();
    expect(dockBox).not.toBeNull();
    expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(dockBox!.y + 1);

    // Discard the session: the dock goes, and with it the claim on the bottom
    // edge — every notice falls back to the plain safe-area gutter it always had.
    await page.getByTestId("workout-dock-open").click();
    // Scope the discard to the editor's own footer — the page BEHIND the editor
    // (Equipment) carries its own per-row Delete controls.
    await page
      .getByTestId("activity-form-footer")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(dock).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue(
            "--bottom-edge-offset"
          )
        )
      )
      .toBe("");
  } finally {
    cleanupMetric();
  }
});
