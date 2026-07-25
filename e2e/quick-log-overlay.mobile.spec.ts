import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_SHELL,
  SHELL_PROFILE,
  SHELL_WEIGHT_KG,
  SHELL_DOSE_ITEM,
} from "./fixture-logins";

// Every quick-log item opens an IN-PLACE overlay (issues #1468, #1467).
//
// The regression class: the #1416 sheet shipped two-tier — activity opened its
// editor in place, but food / dose / weight were `router.push`es. So a sheet
// promising "log from anywhere" answered a mid-morning weigh-in by teleporting
// you to the Trends page. Returning you to where you were IS the feature, and
// that is what this spec pins: after a save you are still on the dashboard, the
// toast fired, the sheet is gone — and the write is REAL (asserted from
// server-rendered state after a reload, never from the toast alone, which proves
// only that a promise resolved).
//
// Fixture hygiene (#868): this spec OWNS the Mobile Shell fixture — a dedicated
// write-granted login on an otherwise-empty profile, in its own cookie context.
// Every assertion is by VALUE, never a count, and the one piece of mutable state
// it depends on (the seeded dose's log rows) is cleared at test start, so
// --repeat-each and re-runs start from the same place.

// A raw context from loginAs does NOT inherit the `mobile` project's `use` block,
// so the phone viewport has to be restated or this silently runs at desktop width
// where the mobile bar does not render at all (dashboard-now.mobile.spec.ts's
// documented gotcha).
const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

function openDb(): Database.Database {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  return db;
}

// The seeded dose's id on this spec's own profile.
function shellDoseId(): number {
  const db = openDb();
  try {
    return (
      db
        .prepare(
          `SELECT d.id AS id
             FROM intake_item_doses d
             JOIN intake_items i ON i.id = d.item_id
            WHERE i.profile_id = (SELECT id FROM profiles WHERE name = ?)
              AND i.name = ?`
        )
        .get(SHELL_PROFILE, SHELL_DOSE_ITEM) as { id: number }
    ).id;
  } finally {
    db.close();
  }
}

// Clear the dose's logs so it is DUE again — the one mutable precondition.
function clearDoseLogs(doseId: number): void {
  const db = openDb();
  try {
    db.prepare("DELETE FROM intake_item_logs WHERE dose_id = ?").run(doseId);
  } finally {
    db.close();
  }
}

// Flip the seeded dose's `retired` flag behind the app's back — "the schedule was
// edited on another device while your sheet was open". Deliberately chosen over
// writing an intake_item_logs row for a computed date: the suite runs on a FROZEN
// clock that can legitimately sit on the other side of midnight from SQL's
// `date('now')` (#1464), so a hand-computed date is a latent flake. `retired` is
// date-free, and it exercises the same rule — markDoseTaken writes nothing, so
// the confirm must not claim it did.
function setDoseRetired(doseId: number, retired: boolean): void {
  const db = openDb();
  try {
    db.prepare("UPDATE intake_item_doses SET retired = ? WHERE id = ?").run(
      retired ? 1 : 0,
      doseId
    );
  } finally {
    db.close();
  }
}

async function signIn(browser: Parameters<typeof loginAs>[0]): Promise<Page> {
  return loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
}

// Open the quick-log sheet and tap one of its rows. The caret is a pure CLIENT
// toggle, so a pre-hydration tap is swallowed with no POST to settle on and no
// other awaitable open signal — the visibility-guarded retry is the only honest
// wait here (#500/#830).
async function openQuickEntry(page: Page, itemId: string) {
  const sheet = page.getByTestId("quick-log-sheet");
  await expect(async () => {
    if (!(await sheet.isVisible())) {
      await page.getByTestId("quick-log-more").click();
    }
    await expect(sheet).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the caret past the pre-hydration swallow — a client toggle with no POST, visibility-guarded so a late tap can't re-close it

  await sheet.getByTestId(`quick-log-${itemId}`).click();
  await expect(sheet).toHaveCount(0);
  const overlay = page.getByTestId("quick-entry-sheet");
  await expect(overlay).toBeVisible();
  return overlay;
}

test("a weight logged from the dashboard sheet stays put, toasts, and persists", async ({
  browser,
}) => {
  const page = await signIn(browser);
  try {
    await page.goto("/");
    const dashboardUrl = page.url();

    const overlay = await openQuickEntry(page, "log-weight");
    // The overlay mounts the EXISTING BodyQuickAdd — same element ids the Trends
    // page's mount carries, because it is the same component, not a copy.
    const weight = overlay.locator("#bm-weight");
    await expect(weight).toBeVisible();
    await weight.fill(SHELL_WEIGHT_KG);

    await settledClick(
      page,
      overlay.getByRole("button", { name: "Save entry" })
    );

    // After save: overlay closed, toast shown, STAY PUT. All three matter — the
    // last one is the issue.
    await expect(page.getByText("Entry saved")).toBeVisible();
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    expect(page.url()).toBe(dashboardUrl);

    // Durable, and asserted from SERVER-rendered state rather than the toast: a
    // resolved promise is not a committed row. The reload proves the dashboard
    // survives it too (we are still where we started, freshly rendered).
    await page.reload();
    expect(page.url()).toBe(dashboardUrl);

    await page.goto("/trends?tab=body");
    await expect(page.getByTestId("body-history-table")).toContainText(
      SHELL_WEIGHT_KG
    );
  } finally {
    await page.context().close();
  }
});

test("the dose overlay answers from the outcome — it never just confirms", async ({
  browser,
}) => {
  const doseId = shellDoseId();
  clearDoseLogs(doseId);
  setDoseRetired(doseId, false);

  const page = await signIn(browser);
  try {
    await page.goto("/");
    const dashboardUrl = page.url();

    const overlay = await openQuickEntry(page, "log-dose");
    const row = overlay.getByTestId(`quick-entry-dose-${doseId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(SHELL_DOSE_ITEM);

    // The schedule changes elsewhere while this sheet still shows the dose as
    // due. The open sheet is a frozen snapshot; its button is about to describe a
    // world that no longer holds.
    setDoseRetired(doseId, true);
    await settledClick(page, row.getByRole("button", { name: "Mark taken" }));

    // THE assertion: it says what actually happened. markDoseTaken wrote nothing,
    // and claiming "Dose logged" here would be a false confirmation of a
    // possibly-critical medication — the #280 defect the DoseTakenOutcome union
    // exists to prevent.
    // Scoped to the toast: the same sentence also renders as the row's inline
    // note below, and an unscoped match would be two elements.
    await expect(page.getByTestId("toast")).toContainText("Not logged");
    await expect(page.getByText("Dose logged")).toHaveCount(0);
    // Nothing was logged, so the dose has NOT been resolved: the row stays, with
    // the reason beside it. Silently dropping it would be the same lie told
    // quietly.
    await expect(row).toBeVisible();
    await expect(
      overlay.getByTestId(`quick-entry-dose-note-${doseId}`)
    ).toBeVisible();
    expect(page.url()).toBe(dashboardUrl);

    // Restore the schedule and confirm for real. This time a log IS written, so
    // the row resolves, and with nothing left to confirm the overlay closes
    // itself instead of sitting there empty.
    setDoseRetired(doseId, false);
    await page.reload();
    const fresh = await openQuickEntry(page, "log-dose");
    await settledClick(
      page,
      fresh
        .getByTestId(`quick-entry-dose-${doseId}`)
        .getByRole("button", { name: "Mark taken" })
    );
    await expect(page.getByText("Dose logged")).toBeVisible();
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    expect(page.url()).toBe(dashboardUrl);

    // Durable, from SERVER-gathered state: reopening asks the due-dose
    // computation again, and it no longer offers a dose that is taken.
    const reopened = await openQuickEntry(page, "log-dose");
    await expect(reopened.getByTestId("quick-entry-unavailable")).toBeVisible();
    await expect(
      reopened.getByTestId(`quick-entry-dose-${doseId}`)
    ).toHaveCount(0);
  } finally {
    clearDoseLogs(doseId);
    setDoseRetired(doseId, false);
    await page.context().close();
  }
});

test("the food and vitals overlays mount the same forms their pages carry", async ({
  browser,
}) => {
  const page = await signIn(browser);
  try {
    await page.goto("/");

    // Food: the Nutrition tab's own FoodLogBar, scoped to the overlay body so
    // this can never accidentally assert the page's copy.
    const food = await openQuickEntry(page, "log-food");
    const foodBody = page.getByTestId("quick-entry-body");
    await expect(foodBody).toHaveAttribute("data-form", "food");
    await expect(foodBody.getByTestId("food-log-bar")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(food).toHaveCount(0);

    // Vitals — the item #1467 added, opening the SAME VitalsQuickAdd the Trends
    // surfaces mount (no second vitals form was written for the sheet).
    const vitals = await openQuickEntry(page, "log-vitals");
    const vitalsBody = page.getByTestId("quick-entry-body");
    await expect(vitalsBody).toHaveAttribute("data-form", "vitals");
    await expect(vitalsBody.getByTestId("vitals-quick-add")).toBeVisible();

    // And a reading submitted from here lands: the toast fires only after
    // addVitals returned, so the write reached the same server action the page
    // mount uses. (That action's persistence is already pinned by the action tier
    // and manual-vitals.spec.ts — unchanged by #1467, which only adds a mount.)
    await vitals.locator("#v-systolic").fill("118");
    await vitals.locator("#v-diastolic").fill("76");
    await settledClick(
      page,
      vitals.getByRole("button", { name: "Save vitals" })
    );
    await expect(page.getByText("Vitals saved")).toBeVisible();
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await page.context().close();
  }
});
