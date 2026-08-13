import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { openCommandPalette } from "./nav";
import { hydratedClick } from "./helpers";
import { workerDbPath } from "./worker-env";

// The bottom edge stacks; it does not overlap (issue #1520 part B, #2651).
//
// FIVE fixed surfaces converge on the phone's bottom edge — the nav dock
// (navigation floor) and the workout dock (session bar), the toast stack and
// offline pill (notices), and the offline error panel (alerts). Each used to
// hand-write `bottom: max(1rem, safe-area)` in isolation, so a toast raised DURING
// a live workout landed on top of the dock: the confirmation covered the "still
// working out?" bar. They now share components/overlay's bottom-edge tokens, and
// each base layer publishes its own TOP EDGE into `--bottom-edge-offset` while
// mounted, so the notice layers clear whichever of them is up.
//
// #2651 put a permanent nav dock underneath all of it, which is the second
// instance of the same collision — hence the second test below. The first still
// owns the workout-dock case, and its tail now pins the RELEASE honestly: the edge
// does not become unclaimed when the session ends, it falls back to the nav dock.
//
// Asserted as GEOMETRY (bounding boxes), not pixels or classes: the toast's bottom
// edge must sit at or above the bar's top edge.
//
// Fixture discipline (#868): create-and-clean on the admin profile — this spec
// starts its OWN live session (the same pattern workout-presence.spec.ts uses for
// its interactive case) and discards it, and the one body-metric row its toast
// comes from is deleted by value in the finally.

const DB_PATH = workerDbPath();
// Weights no seed or other spec logs, so the cleanup below can key on them. One
// per test, so neither owns the other's rows (#868).
const TOAST_WEIGHT = "77.3";
const NAV_TOAST_WEIGHT = "77.4";

function cleanupMetric(weight: string) {
  const h = new Database(DB_PATH);
  try {
    h.prepare("DELETE FROM body_metrics WHERE weight_kg = ?").run(
      Number(weight)
    );
  } finally {
    h.close();
  }
}

// Raise a real toast the ordinary way: the palette's inline quick-log writes a
// body metric and confirms it — the everyday "I just did something" notice.
async function toastFromQuickLog(page: Page, weight: string): Promise<Locator> {
  const input = await openCommandPalette(page);
  await input.fill(`weight ${weight}`);
  await expect(page.getByTestId("palette-quicklog")).toContainText(weight);
  await input.press("Enter");
  // Generous window: the toast follows a Server Action + revalidation round trip,
  // which on a loaded runner is comfortably past the default 5s assertion budget.
  const toast = page.getByTestId("toast");
  await expect(toast).toBeVisible({ timeout: 25_000 });
  return toast;
}

// The stacking rule, as geometry: the notice ends where the bar begins (or above
// it), instead of covering it.
async function expectStackedAbove(toast: Locator, bar: Locator) {
  const toastBox = await toast.boundingBox();
  const barBox = await bar.boundingBox();
  expect(toastBox).not.toBeNull();
  expect(barBox).not.toBeNull();
  expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(barBox!.y + 1);
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

    const toast = await toastFromQuickLog(page, TOAST_WEIGHT);
    await expectStackedAbove(toast, dock);

    // …and the workout dock is itself stacked, not stacked ON: it sits above the
    // nav dock, which is the #2651 half of the same rule. Two permanent bars
    // cannot share the same 56px, and the one that arrived second is the one that
    // moves.
    await expectStackedAbove(dock, page.getByTestId("mobile-dock"));

    // Discard the session: the workout dock goes, and with it ITS claim on the
    // bottom edge. The edge does not become unclaimed, though — the nav dock is
    // still there and still claims it, so the published offset falls back rather
    // than clearing. (Above `md`, where no nav dock renders, it does clear; that
    // is the desktop path and not this project's.)
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
    const navBox = (await page.getByTestId("mobile-dock").boundingBox())!;
    await expect
      .poll(() =>
        page.evaluate(() =>
          parseFloat(
            document.documentElement.style.getPropertyValue(
              "--bottom-edge-offset"
            ) || "0"
          )
        )
      )
      // Released down to the nav dock's own claim — no longer the taller
      // workout-dock figure, and never zero while a bar is still on screen.
      .toBeCloseTo(navBox.height, 0);
  } finally {
    cleanupMetric(TOAST_WEIGHT);
  }
});

test("with no session at all, a toast still clears the nav dock (#2651)", async ({
  page,
}) => {
  // The second instance of #1520's collision class, and the common one: there is
  // no workout, just the permanent bottom bar every phone route now carries. A
  // toast confirming a log used to land ON the bar the log was tapped from.
  try {
    await page.goto("/equipment");
    const nav = page.getByTestId("mobile-dock");
    await expect(nav).toBeVisible();
    // No session — this is the plain state, not the #1520 one.
    await expect(page.getByTestId("workout-dock")).toHaveCount(0);

    const toast = await toastFromQuickLog(page, NAV_TOAST_WEIGHT);
    await expectStackedAbove(toast, nav);
  } finally {
    cleanupMetric(NAV_TOAST_WEIGHT);
  }
});
