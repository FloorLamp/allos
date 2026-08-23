import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { expectNoClippedContent, hydratedClick } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_FITNESS,
  TRENDS_FITNESS_LIFT,
} from "./fixture-logins";

// #3512 deliberately reverses #1492: Training → Analyze is the one fitness-
// analytics surface. Its default is the windowed All training view; selecting an
// entity drills into the existing per-entity analysis.

async function signIn(browser: Parameters<typeof loginAs>[0]): Promise<Page> {
  return loginAs(browser, {
    username: E2E_LOGIN_TRENDS_FITNESS,
    password: E2E_MEMBER_PASSWORD,
  });
}

test.describe("Training → Analyze, All training (#3512)", () => {
  test("the default moves only workout history and data-backed zones", async ({
    browser,
  }) => {
    const page = await signIn(browser);
    await page.goto("/training?tab=analyze");

    await expect(page.getByTestId("analyze-all-training")).toBeVisible();
    await expect(page.getByLabel("Exercise or activity")).toHaveValue(
      "All training"
    );

    const history = page.getByTestId("workout-history");
    await expect(history).toBeVisible();
    await expect(history.getByTestId("day-history-calendar")).toBeVisible();
    await expect(history.getByTestId("day-history-row")).not.toHaveCount(0);

    // This fixture has no workout-scoped HR minutes, so the moved section does
    // not reserve standing empty chrome. e2e/training-zones.spec.ts owns the
    // positive, data-present render.
    await expect(page.getByTestId("fitness-zones")).toHaveCount(0);

    // The four amended retirements do not follow their old mount.
    for (const testId of [
      "fitness-volume",
      "fitness-strength",
      "fitness-sport",
      "fitness-window-prs",
    ]) {
      await expect(page.getByTestId(testId)).toHaveCount(0);
    }
    await expectNoClippedContent(page);
    await page.close();
  });

  test("Analyze's range control re-windows the workout history", async ({
    browser,
  }) => {
    const page = await signIn(browser);
    await page.goto("/training?tab=analyze");

    const history = page.getByTestId("workout-history");
    const defaultFirst = await history
      .getByTestId("day-history-calendar")
      .locator("[data-date]")
      .first() // first-ok: the grid's oldest bucket is the window measurement
      .getAttribute("data-date");

    await page.getByLabel("Range").selectOption("all");
    await expect(page).toHaveURL(/tab=analyze&range=all/);
    await expect(page.getByTestId("analyze-all-training")).toBeVisible();
    await expect(history.getByTestId("day-history-calendar")).toHaveCount(0);
    const allTimeFirst = await history
      .getByTestId("day-history-strip")
      .locator("[data-date]")
      .first() // first-ok: the widened grid's oldest bucket is the comparison
      .getAttribute("data-date");
    expect(allTimeFirst! < defaultFirst!).toBe(true);

    await page.close();
  });

  test("the picker drills into an entity and provides the door back", async ({
    browser,
  }) => {
    const page = await signIn(browser);
    await page.goto("/training?tab=analyze");

    const picker = page.getByLabel("Exercise or activity");
    await hydratedClick(page, picker);
    await picker.fill(TRENDS_FITNESS_LIFT);
    await page.getByRole("option", { name: TRENDS_FITNESS_LIFT }).click();
    await expect(page).toHaveURL(/tab=analyze&kind=strength&item=/);
    await expect(page.getByTestId("analyze-all-training")).toHaveCount(0);
    await expect(page.getByTestId("analyze-sessions")).toBeVisible();

    await hydratedClick(page, page.getByLabel("Exercise or activity"));
    await page.getByRole("option", { name: "All training" }).click();
    await expect(page).toHaveURL(/tab=analyze&range=12w/);
    await expect(page.getByTestId("analyze-all-training")).toBeVisible();

    await page.close();
  });

  test("legacy tab, nested aliases, and anchors redirect to Analyze", async ({
    browser,
  }) => {
    const page = await signIn(browser);

    for (const legacy of [
      "/trends?tab=fitness",
      "/trends?tab=fitness&ftab=cardio#zones",
      "/trends?ftab=sport#sport",
      "/trends?tab=fitness#volume",
      "/trends?tab=fitness#strength",
      "/trends?tab=fitness#prs",
    ]) {
      await page.goto(legacy);
      await expect(page).toHaveURL(/\/training\?tab=analyze/);
      await expect(page.getByTestId("analyze-all-training")).toBeVisible();
      if (legacy.endsWith("#zones")) {
        await expect(page).toHaveURL(/#zones$/);
        await expect(page.locator("#zones")).toHaveCount(1);
      }
    }

    await page.close();
  });
});
