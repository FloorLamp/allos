import { type Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import { E2E_LOGIN_MULTI } from "./logins/household";
import { E2E_LOGIN_SHELL, SHELL_DOSE_ITEM } from "./logins/metrics";
import { E2E_MEMBER_PASSWORD } from "./logins/shared";
import { hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import {
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
  TAP_TARGET_INSET_PX,
} from "../lib/tap-floor-tokens";

const PHONE = { width: 390, height: 844 };

async function expectRenderedFloor(name: string, locator: Locator) {
  await expect(locator, name).toBeVisible();
  await expect(
    locator,
    `${name} owns its rendered target instead of overlapping its neighbours`
  ).not.toHaveClass(/(?:^|\s)tap-target(?:\s|$)/);
  const box = await locator.boundingBox();
  expect(box, name).not.toBeNull();
  expect(
    box!.height + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} rendered height`
  ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
}

async function expectOverlayFloor(
  name: string,
  locator: Locator,
  exactRenderedPx: number
) {
  await expect(locator, name).toBeVisible();
  await expect(locator, `${name} hit-area mechanism`).toHaveClass(
    /(?:^|\s)tap-target(?:\s|$)/
  );
  const box = await locator.boundingBox();
  expect(box, name).not.toBeNull();
  expect(
    Math.abs(box!.height - exactRenderedPx),
    `${name} rendered height delta from ${exactRenderedPx}px`
  ).toBeLessThanOrEqual(TAP_FLOOR_FLOAT_EPSILON_PX);
  expect(
    box!.height + 2 * TAP_TARGET_INSET_PX + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} effective height`
  ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
}

async function expectRenderedTargetsDisjoint(name: string, row: Locator) {
  await expect(row, `${name} row`).toBeVisible();
  const targets = row.locator("button");
  const count = await targets.count();
  expect(count, `${name} must exercise adjacent targets`).toBeGreaterThan(1);
  const boxes = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      targets.nth(index).boundingBox()
    )
  );
  for (let left = 0; left < boxes.length; left += 1) {
    await expect(
      targets.nth(left),
      `${name} target ${left} owns a rendered box`
    ).not.toHaveClass(/(?:^|\s)tap-target(?:\s|$)/);
    expect(boxes[left], name).not.toBeNull();
    expect(
      boxes[left]!.height + TAP_FLOOR_FLOAT_EPSILON_PX,
      `${name} target ${left}`
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      const overlapX =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(
        overlapX > 0 && overlapY > 0,
        `${name} targets ${left} and ${right} must not own the same point`
      ).toBe(false);
    }
  }
}

test.describe("tap-target rendered census (#3562)", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("multi-profile identity control", async ({ browser }) => {
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_MULTI, password: E2E_MEMBER_PASSWORD },
      { viewport: PHONE, hasTouch: true }
    );
    try {
      await page.goto("/");
      await expectRenderedFloor(
        "mobile profile identity",
        page.getByTestId("profile-identity-bar-mobile")
      );
    } finally {
      await page.context().close();
    }
  });

  test("shell dock and quick-log controls", async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
      { viewport: PHONE, hasTouch: true }
    );
    try {
      await page.goto("/");
      await expectRenderedFloor(
        "mobile dock slot",
        page.getByTestId("dock-slot-home")
      );
      await hydratedClick(page, page.getByTestId("dock-log-puck"));
      const sheet = page.getByTestId("quick-log-sheet");
      await expect(sheet).toBeVisible();
      const trainSegment = sheet.getByTestId("log-sheet-segment-train");
      await hydratedClick(page, trainSegment);
      await expect(trainSegment).toHaveAttribute("aria-pressed", "true");
      await expectRenderedFloor(
        "quick-log row",
        sheet.getByTestId("quick-log-log-activity")
      );
      const context = sheet.getByTestId("log-sheet-context");
      const dueDose = context.getByTestId("log-sheet-chip-doses");
      await expect(dueDose).toHaveText(`Due: ${SHELL_DOSE_ITEM}`);
      await expectRenderedFloor("owned due-dose context chip", dueDose);
    } finally {
      await page.context().close();
    }
  });

  test("visit controls", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/records/history/visits");
    await hydratedClick(
      page,
      page.getByRole("button", { name: "Add visit", exact: true })
    );
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    await expectOverlayFloor(
      "past-visit tense switch",
      dialog.getByTestId("visit-tense-past"),
      32
    );
    await expectRenderedFloor(
      "visit fact chip",
      dialog.getByTestId("visit-fact-when")
    );
    await expectRenderedFloor(
      "visit more trigger",
      dialog.getByTestId("visit-fact-more")
    );
    await hydratedClick(page, dialog.getByTestId("visit-fact-more"));
    await expectRenderedFloor(
      "visit more choice",
      dialog.getByTestId("visit-more-provider")
    );
    await expectRenderedTargetsDisjoint(
      "visit more choices",
      dialog.getByTestId("visit-fact-more-menu")
    );
    await hydratedClick(page, dialog.getByTestId("visit-tense-past"));
    await expectOverlayFloor(
      "upcoming-visit tense switch",
      dialog.getByTestId("visit-tense-upcoming"),
      32
    );
  });

  test("protocol, goal and injury detail menus", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/longevity#protocols");
    await hydratedClick(
      page,
      page.getByRole("main").getByTestId("new-protocol-toggle")
    );
    const protocol = page.getByTestId("protocol-form");
    await expectRenderedFloor(
      "protocol more trigger",
      protocol.getByTestId("protocol-fact-more")
    );
    await hydratedClick(page, protocol.getByTestId("protocol-fact-more"));
    await expectRenderedFloor(
      "protocol more choice",
      protocol.getByTestId("protocol-more-notes")
    );
    await expectRenderedTargetsDisjoint(
      "protocol more choices",
      protocol.getByTestId("protocol-more-notes").locator("..")
    );

    await page.goto("/training?tab=goals");
    await hydratedClick(
      page,
      page.getByRole("button", { name: "Add goal", exact: true })
    );
    const goal = page.getByTestId("goal-form");
    await hydratedClick(page, goal.getByTestId("goal-kind-freeform"));
    await goal.getByLabel("Title").fill("Geometry goal");
    await hydratedClick(page, goal.getByTestId("goal-editor-done"));
    await expectRenderedFloor(
      "goal more trigger",
      goal.getByTestId("goal-fact-more")
    );
    await hydratedClick(page, goal.getByTestId("goal-fact-more"));
    await expectRenderedFloor(
      "goal more choice",
      goal.getByTestId("goal-more-category")
    );
    await expectRenderedTargetsDisjoint(
      "goal more choices",
      goal.getByTestId("goal-more-category").locator("..")
    );

    await page.goto("/training");
    await hydratedClick(
      page,
      page.getByRole("button", { name: "Log injury", exact: true })
    );
    const injury = page.getByTestId("injury-form");
    await expectRenderedFloor(
      "injury more trigger",
      injury.getByTestId("injury-fact-more")
    );
    await hydratedClick(page, injury.getByTestId("injury-fact-more"));
    await expectRenderedFloor(
      "injury more choice",
      injury.getByTestId("injury-more-laterality")
    );
    await expectRenderedTargetsDisjoint(
      "injury more choices",
      injury.getByTestId("injury-more-laterality").locator("..")
    );
  });

  test("intake and cadence controls", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/nutrition?tab=supplements");
    await hydratedClick(page, page.getByTestId("supplement-add-toggle"));
    const form = page.getByTestId("intake-item-form");
    await expect(form).toBeVisible();
    await form.getByLabel("Name").fill("Geometry thing");
    await form.getByLabel("Name").press("Escape");
    await expectRenderedFloor(
      "intake fact chip",
      form.getByTestId("intake-fact-dose")
    );
    await expectRenderedFloor(
      "intake add-rule chip",
      form.getByTestId("intake-add-rule")
    );
    await expectRenderedFloor(
      "intake more trigger",
      form.getByTestId("intake-fact-more")
    );
    await expectRenderedTargetsDisjoint(
      "intake fact row",
      form.getByTestId("intake-fact-row")
    );

    await hydratedClick(page, form.getByTestId("intake-fact-more"));
    await expect(form.getByTestId("intake-editor")).toHaveAttribute(
      "data-panel",
      "more"
    );
    await expectRenderedFloor(
      "intake more choice",
      form.getByTestId("intake-more-purpose")
    );
    await expectRenderedTargetsDisjoint(
      "intake more choices",
      form.getByTestId("intake-more-purpose").locator("..")
    );
    await hydratedClick(page, form.getByTestId("intake-more-purpose"));
    await form.getByLabel("Name").fill("Lutein");
    await form.getByLabel("Name").press("Escape");
    await expectRenderedFloor(
      "purpose goal",
      form.getByTestId("purpose-goal-energy")
    );
    await expectRenderedFloor(
      "purpose suggestion",
      form.getByTestId("purpose-suggest-eyes")
    );
    await expectRenderedTargetsDisjoint(
      "purpose goals",
      form.getByTestId("purpose-goal-energy").locator("..")
    );
    await hydratedClick(page, form.getByTestId("intake-editor-done"));
    await hydratedClick(page, form.getByTestId("intake-add-rule"));
    await expectRenderedFloor(
      "rule offer",
      form.getByTestId("intake-rule-add-only-when")
    );
    await expectRenderedTargetsDisjoint(
      "rule offers",
      form.getByTestId("intake-rule-add-only-when").locator("..")
    );
    await hydratedClick(page, form.getByTestId("intake-rule-add-only-when"));
    await hydratedClick(page, form.getByTestId("intake-editor-done"));
    await expectRenderedTargetsDisjoint(
      "fact chip split",
      form.getByTestId("intake-fact-rule")
    );

    await hydratedClick(page, form.getByTestId("intake-fact-timing"));
    await form.getByLabel("How often").selectOption("weekly");
    await expectRenderedFloor(
      "cadence weekday",
      form.getByTestId("cadence-weekday-1")
    );
    await expectRenderedTargetsDisjoint(
      "cadence weekdays",
      form.getByTestId("cadence-weekdays")
    );
  });
});
