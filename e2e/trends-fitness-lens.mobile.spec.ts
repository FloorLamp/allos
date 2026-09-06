import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { expectNoClippedContent, hydratedClick, settledBoxes } from "./helpers";
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

    // #1492's phone stacking contract follows the history to its new owner: an
    // expanded activity matrix starts below the calendar instead of overlaying it.
    // eslint-disable-next-line no-restricted-properties -- first-ok: every history row shares this stacking contract
    await history
      .getByRole("button", { name: /View occurrences for/ })
      .first()
      .click();
    const [calendarBox, rowBox] = await settledBoxes([
      history.getByTestId("day-history-calendar-panel"),
      history.getByTestId("day-history-rowpanel"),
    ]);
    expect(rowBox.y).toBeGreaterThanOrEqual(calendarBox.y + calendarBox.height);

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

  test("the first chart remains inside the first viewport at the default range", async ({
    browser,
  }) => {
    const page = await signIn(browser);
    await page.goto("/training?tab=analyze");

    // The workout-history chart was #1492's answer to a 1,776px pre-chart wall.
    // Moving it must preserve that measured phone outcome, not merely its DOM.
    const firstChart = page.getByTestId("workout-day-history");
    const box = await firstChart.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.y).toBeLessThan(viewport!.height);
    await expectNoClippedContent(page);

    await page.close();
  });

  test("Analyze's range control re-windows the workout history", async ({
    browser,
  }) => {
    const page = await signIn(browser);
    await page.goto("/training?tab=analyze");

    const history = page.getByTestId("workout-history");
    // eslint-disable-next-line no-restricted-properties -- first-ok: the grid's oldest bucket is the window measurement
    const defaultFirst = await history
      .getByTestId("day-history-calendar")
      .locator("[data-date]")
      .first()
      .getAttribute("data-date");

    await page.getByLabel("Range").selectOption("all");
    await expect(page).toHaveURL(/tab=analyze&range=all/);
    await expect(page.getByTestId("analyze-all-training")).toBeVisible();
    await expect(history.getByTestId("day-history-calendar")).toHaveCount(0);
    // eslint-disable-next-line no-restricted-properties -- first-ok: the widened grid's oldest bucket is the comparison
    const allTimeFirst = await history
      .getByTestId("day-history-strip")
      .locator("[data-date]")
      .first()
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

    const aliases = [
      { href: "/trends?tab=fitness", anchor: null },
      { href: "/trends?tab=fitness&ftab=cardio#zones", anchor: "zones" },
      { href: "/trends?ftab=sport#sport", anchor: "sport" },
      { href: "/trends?tab=fitness#volume", anchor: "volume" },
      { href: "/trends?tab=fitness#strength", anchor: "strength" },
      { href: "/trends?tab=fitness#prs", anchor: "prs" },
    ] as const;

    for (const legacy of aliases) {
      await page.goto(legacy.href);
      await expect(page).toHaveURL(/\/training\?tab=analyze/);
      await expect(page.getByTestId("analyze-all-training")).toBeVisible();
      if (legacy.anchor) {
        await expect(page).toHaveURL(
          new RegExp(
            `#${legacy.anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
          )
        );
        await expect(page.locator(`#${legacy.anchor}`)).toHaveCount(1);
      }
    }

    await page.close();
  });
});
