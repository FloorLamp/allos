import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  E2E_LOGIN_PREVENTIVE,
  E2E_LOGIN_TL_EMPTY,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { openDashboardAll, settledBoxes } from "./helpers";
import { loginAs } from "./nav";
import {
  CONTROL_BOX_PX,
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
} from "@/lib/tap-floor-tokens";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 800, height: 900 };

type Box = { x: number; y: number; width: number; height: number };

// The reach READ OFF THE RENDER, not off the class list (#3938). `button-control`
// carries no `tap-target` token any more — the control box's own coarse-pointer
// rule gives it the reach — so a class-name test would report zero extension for a
// control that has one, and the effective floor would fail on a correct tree.
async function reachOf(target: Locator): Promise<number> {
  return target.evaluate((node) => {
    const after = getComputedStyle(node, "::after");
    if (after.content === "none") return 0;
    const inset = Math.abs(Number.parseFloat(after.top));
    return Number.isFinite(inset) ? inset : 0;
  });
}

function effectiveBox(box: Box, inset: number): Box {
  return {
    x: box.x - inset,
    y: box.y - inset,
    width: box.width + 2 * inset,
    height: box.height + 2 * inset,
  };
}

async function expectEffectiveFloor(name: string, target: Locator) {
  await expect(target, name).toBeVisible();
  const [box] = await settledBoxes([target]);
  const effective = effectiveBox(box, await reachOf(target));
  expect(
    effective.height + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} effective height`
  ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
  expect(
    effective.width + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} effective width`
  ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
  expect(effective.x, `${name} left viewport edge`).toBeGreaterThanOrEqual(0);
  expect(
    effective.x + effective.width,
    `${name} right viewport edge`
  ).toBeLessThanOrEqual(PHONE.width);
}

async function expectEffectiveTargetsDisjoint(name: string, group: Locator) {
  await expect(group, name).toBeVisible();
  const targets = group.locator("a:visible, button:visible");
  const count = await targets.count();
  expect(count, `${name} must exercise adjacent targets`).toBeGreaterThan(1);
  const locators = Array.from({ length: count }, (_, index) =>
    targets.nth(index)
  );
  const boxes = await settledBoxes(locators);
  const extended = await targets.evaluateAll((nodes) =>
    nodes.map((node) => {
      const after = getComputedStyle(node, "::after");
      if (after.content === "none") return 0;
      const inset = Math.abs(Number.parseFloat(after.top));
      return Number.isFinite(inset) ? inset : 0;
    })
  );
  const effective = boxes.map((box, index) =>
    effectiveBox(box, extended[index] ?? 0)
  );

  for (let left = 0; left < effective.length; left += 1) {
    expect(
      effective[left]!.height + TAP_FLOOR_FLOAT_EPSILON_PX,
      `${name} target ${left} effective height`
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    expect(
      effective[left]!.width + TAP_FLOOR_FLOAT_EPSILON_PX,
      `${name} target ${left} effective width`
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    for (let right = left + 1; right < effective.length; right += 1) {
      const a = effective[left]!;
      const b = effective[right]!;
      const overlapX =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(
        overlapX > TAP_FLOOR_FLOAT_EPSILON_PX &&
          overlapY > TAP_FLOOR_FLOAT_EPSILON_PX,
        `${name} targets ${left} and ${right} share an effective point`
      ).toBe(false);
    }
  }
}

test.use({ viewport: PHONE, hasTouch: true });

test("Dashboard ordinary actions render through Button at the phone floor", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("dashboard-canvas")).toBeVisible();

  // AHEAD'S "+N more" WAS AN ADOPTER AND IS NOT ONE ANY MORE (#4232): the zone opens,
  // so the control is retired rather than restyled. Nothing replaces it here — the
  // dashboard's Button corpus on a phone is the row controls below.
  await expect(
    page.getByTestId("dashboard-ahead").getByRole("button")
  ).toHaveCount(0);

  await openDashboardAll(page);
  const markTakenActions = page.getByTestId("attention-mark-taken");
  const markTakenCount = await markTakenActions.count();
  expect(markTakenCount, "Dashboard Mark taken adopter corpus").toBeGreaterThan(
    0
  );
  for (let index = 0; index < markTakenCount; index += 1) {
    const markTaken = markTakenActions.nth(index);
    await expect(markTaken).toHaveAttribute("data-button-control", "");
    await expect(markTaken).toHaveAccessibleName("Mark taken");
    await expectEffectiveFloor(`Dashboard Mark taken ${index}`, markTaken);
  }
});

test("Household dose confirmation uses the same contained phone target", async ({
  page,
}) => {
  await page.goto("/household");
  await expect(page.getByRole("heading", { name: "Household" })).toBeVisible();

  const visibleConfirms = page
    .getByTestId("household-confirm-dose")
    .filter({ visible: true });
  if ((await visibleConfirms.count()) === 0) {
    const summaries = page
      .getByTestId("household-dose-aggregate-summary")
      .filter({ visible: true });
    const summaryCount = await summaries.count();
    expect(
      summaryCount,
      "Household aggregate with confirm adopters"
    ).toBeGreaterThan(0);
    for (let index = 0; index < summaryCount; index += 1) {
      await summaries.nth(index).click();
    }
  }
  const confirmCount = await visibleConfirms.count();
  expect(
    confirmCount,
    "visible Household confirm adopter corpus"
  ).toBeGreaterThan(0);
  for (let index = 0; index < confirmCount; index += 1) {
    const confirm = visibleConfirms.nth(index);
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveAttribute("data-button-control", "");
    await expect(confirm).toHaveAccessibleName(/^Confirm .+/);
    await expectEffectiveFloor(`Household dose confirmation ${index}`, confirm);

    const card = confirm.locator(
      'xpath=ancestor::*[@data-testid="household-card"][1]'
    );
    await expect(card, `Household card for confirm ${index}`).toHaveCount(1);
    const [confirmBox, cardBox] = await settledBoxes([confirm, card]);
    expect(
      confirmBox.x,
      `Household confirm ${index} left card edge`
    ).toBeGreaterThanOrEqual(cardBox.x);
    expect(
      confirmBox.x + confirmBox.width,
      `Household confirm ${index} right card edge`
    ).toBeLessThanOrEqual(cardBox.x + cardBox.width);
  }
});

test("Appointment row actions keep compact boxes and disjoint effective targets", async ({
  page,
}) => {
  await page.goto("/records/history/visits");
  const settled = page.getByText(/Completed & cancelled/);
  await expect(settled).toBeVisible();
  await settled.click();

  const reopenActions = page.getByRole("button", {
    name: "Reopen",
    exact: true,
  });
  const reopenCount = await reopenActions.count();
  expect(reopenCount, "Appointment Reopen adopter corpus").toBeGreaterThan(0);
  for (let index = 0; index < reopenCount; index += 1) {
    const reopen = reopenActions.nth(index);
    await expect(reopen).toHaveAttribute("data-button-control", "");
    await expectEffectiveFloor(`Appointment Reopen ${index}`, reopen);
    const row = reopen.locator(
      'xpath=ancestor::*[@data-testid="appointment-row"][1]'
    );
    await expect(row, `Appointment row for Reopen ${index}`).toHaveCount(1);
    await expectEffectiveTargetsDisjoint(
      `Appointment adjacent actions ${index}`,
      row.getByTestId("appointment-row-actions")
    );
  }
});

test("Upcoming primary destinations stay one-line, contained, and disjoint from overflow", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    {
      username: E2E_LOGIN_PREVENTIVE,
      password: E2E_MEMBER_PASSWORD,
    },
    { viewport: PHONE, hasTouch: true }
  );
  try {
    await page.goto("/upcoming");
    const ctas = page.locator("[data-testid^='upcoming-cta-']");
    const ctaCount = await ctas.count();
    expect(ctaCount, "Upcoming primary CTA adopter corpus").toBeGreaterThan(0);
    for (let index = 0; index < ctaCount; index += 1) {
      const cta = ctas.nth(index);
      await expect(cta).toHaveAttribute("data-button-control", "");
      const visibleLabel = (await cta.innerText()).trim();
      await expect(cta).toHaveAccessibleName(visibleLabel);
      await expectEffectiveFloor(`Upcoming primary CTA ${index}`, cta);
      expect(
        await cta.evaluate((node) => {
          const label = node.querySelector("span")!;
          return (
            getComputedStyle(node).whiteSpace === "nowrap" &&
            label.getClientRects().length === 1
          );
        }),
        `Upcoming CTA ${index} must retain its intended one-line layout`
      ).toBe(true);

      const row = cta.locator(
        'xpath=ancestor::*[starts-with(@data-testid, "upcoming-item-")][1]'
      );
      await expect(row, `Upcoming row for CTA ${index}`).toHaveCount(1);
      const group = row.getByTestId("upcoming-primary-actions");
      await expect(group.getByTestId("overflow-menu-trigger")).toBeVisible();
      await expectEffectiveTargetsDisjoint(
        `Upcoming CTA and overflow ${index}`,
        group
      );
    }

    // This record-free preventive profile is the thin mixed state: its Upcoming
    // actions are present above, while the reached Visits surface has no completed
    // appointment that could honestly offer Reopen.
    await page.goto("/records/history/visits");
    await expect(page.getByTestId("records-visits")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Reopen", exact: true })
    ).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

// THE DESKTOP HALF, AND WHAT IT CLAIMS NOW. This test used to prove
// `button-control` dropped to its compact 26px row above `sm`; #3938 retired that
// height into the one box, so the claim is the opposite one and it has to be
// stated as an EQUALITY. `< 44` would still pass on a 34px tree — and on a 12px
// one — which is exactly the way a boundary-crossing fixture goes quiet.
test("Button and destination actions wear the same box above sm", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);

  await page.goto("/");
  await openDashboardAll(page);
  const buttons = page.getByTestId("attention-mark-taken");
  const buttonCount = await buttons.count();
  expect(buttonCount, "desktop Button adopter corpus").toBeGreaterThan(0);
  for (let index = 0; index < buttonCount; index += 1) {
    const button = buttons.nth(index);
    await expect(button).toHaveAttribute("data-button-control", "");
    const [buttonBox] = await settledBoxes([button]);
    expect(buttonBox.height, `desktop Button ${index} height`).toBe(
      CONTROL_BOX_PX
    );
  }

  await page.goto("/upcoming");
  const destinations = page.locator("[data-testid^='upcoming-cta-']");
  const destinationCount = await destinations.count();
  expect(
    destinationCount,
    "desktop DestinationActionLink adopter corpus"
  ).toBeGreaterThan(0);
  for (let index = 0; index < destinationCount; index += 1) {
    const destination = destinations.nth(index);
    await expect(destination).toHaveAttribute("data-button-control", "");
    const [destinationBox] = await settledBoxes([destination]);
    expect(
      destinationBox.height,
      `desktop DestinationActionLink ${index} height`
    ).toBe(CONTROL_BOX_PX);
  }
});

test("a fresh profile reaches each route without inventing conditional action families", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    {
      username: E2E_LOGIN_TL_EMPTY,
      password: E2E_MEMBER_PASSWORD,
    },
    { viewport: PHONE, hasTouch: true }
  );
  try {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-canvas")).toBeVisible();
    await expect(page.getByTestId("attention-mark-taken")).toHaveCount(0);

    await page.goto("/records/history/visits");
    await expect(page.getByTestId("records-visits")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Reopen", exact: true })
    ).toHaveCount(0);

    await page.goto("/upcoming");
    await expect(
      page.getByRole("heading", { name: "Upcoming", exact: true })
    ).toBeVisible();
    await expect(page.locator("[data-testid^='upcoming-cta-']")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
