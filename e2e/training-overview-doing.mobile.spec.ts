import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { followLink, settledBoxes } from "./helpers";
import {
  E2E_LOGIN_TRAINING_ROLLUP,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Issue #1496 — Training → Overview becomes the DOING surface (the other half of
// #1492's rule: analyze on Trends, do on /training). On a 390×844 phone the tab was
// an 8,798px wall whose first chart sat at 7,973px, led by ~17 uncapped per-muscle
// finding cards with today's session buried mid-page. This spec pins the recomposed
// order, the coverage-owned volume status, the departed charts, the standards
// ladder, and the #105 build-only-the-active-tab structure.
//
// Runs on the MOBILE project (the viewport the audit measured).

// ── Layout assertions: read-only, against the shared seeded admin session ──────

// The vertical position of an element, for order assertions.
async function topOf(page: Page, testid: string): Promise<number> {
  return await page
    .getByTestId(testid)
    .evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
}

test("Overview leads with today's session, then the week, then depth", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");

  // On phones the six-tab navigation IS the page identity: the visible
  // Training title/subtitle leave the content flow and the one-row strip joins
  // the auto-hiding app shell. Four tabs since #2892/#2894 — the strip keeps its
  // scroll layout but now fits a phone row without overflowing.
  await expect(page.getByTestId("training-page-title")).toBeHidden();
  const shell = page.getByTestId("shell-chrome");
  const shellTabs = shell.getByTestId("shell-tab-strip");
  const tabs = shellTabs.getByTestId("training-tabs");
  await expect(tabs).toBeVisible();
  await expect(tabs).toHaveCSS("overflow-y", "hidden");
  await expect(tabs.getByRole("tab")).toHaveCount(4);
  await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  // The four-tab bar's win (#2893): no horizontal scroll left to do.
  const stripOverflow = await tabs.evaluate(
    (el) => el.scrollWidth > el.clientWidth
  );
  expect(stripOverflow).toBe(false);

  const today = page.getByTestId("training-today");
  await expect(today).toBeVisible();

  // Doing-first: the daily payload is the FIRST thing on the tab and sits inside the
  // opening viewport (the audit's "today's session buried mid-page" defect).
  const todayTop = await topOf(page, "training-today");
  const weekTop = await topOf(page, "training-week");
  expect(todayTop).toBeLessThan(weekTop);
  expect(todayTop).toBeLessThan(260);

  // Muscle coverage follows the week (and the findings card, when one is firing).
  expect(weekTop).toBeLessThan(await topOf(page, "muscle-coverage"));

  // #2566: the week is the SPINE now — ONE card holding a seven-day band plus the
  // weekly routine's chips, in place of the two-number tile ("Sessions 4 · Days 3")
  // and the separate routine card beside it. The band survives a 390px phone as seven
  // cells inside the card rather than overflowing it.
  // (#1937's rule still holds inside it: no "Streak" figure restating the active-day
  // count — it counted ACTIVE days with a rest day of tolerance, so a Mon/Wed/Fri
  // rhythm read as a five-day run across nine days.)
  const week = page.getByTestId("training-week");
  const cells = week.getByTestId("week-spine-day");
  await expect(cells).toHaveCount(7);
  await expect(week.getByTestId("week-spine-caption")).toContainText(
    "this week"
  );
  await expect(week.getByText("Weekly routine", { exact: true })).toBeVisible();
  await expect(week.getByText("Streak", { exact: true })).toHaveCount(0);
  const [cardBox, lastCellBox] = await settledBoxes([week, cells.nth(6)]);
  expect(lastCellBox.x + lastCellBox.width).toBeLessThanOrEqual(
    cardBox.x + cardBox.width + 1
  );
});

test("a later deep-linked Training tab is brought into the visible tab row", async ({
  page,
}) => {
  // The retired goals deep link resolves to Plan (#2892) — the LAST tab, which
  // is exactly what this scroll-into-view assertion needs.
  await page.goto("/training?tab=goals");
  const tabs = page.getByTestId("training-tabs");
  const goals = tabs.getByRole("tab", { name: "Plan" });
  await expect(goals).toHaveAttribute("aria-selected", "true");

  await expect
    .poll(() =>
      goals.evaluate((tab) => {
        const strip = tab.parentElement;
        if (!strip) return false;
        const tabRect = tab.getBoundingClientRect();
        const stripRect = strip.getBoundingClientRect();
        return (
          tabRect.left >= stripRect.left && tabRect.right <= stripRect.right
        );
      })
    )
    .toBe(true);
});

test("the Training tabs fill the strip at 640px instead of clustering left", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto("/training?tab=overview");

  const tabs = page.getByTestId("shell-tab-strip").getByTestId("training-tabs");
  const items = tabs.getByRole("tab");
  await expect(items).toHaveCount(4);

  const [stripBox, firstBox, lastBox] = await settledBoxes([
    tabs,
    items.first(), // first-ok: the strip's first edge is the assertion
    items.last(),
  ]);
  expect(Math.abs(firstBox.x - stripBox.x)).toBeLessThan(2);
  expect(
    Math.abs(lastBox.x + lastBox.width - (stripBox.x + stripBox.width))
  ).toBeLessThan(2);
  expect(
    await tabs.evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
});

test("the desktop Training tabs remain a compact left-aligned strip", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/training?tab=overview");

  const tabs = page.getByTestId("training-page").getByTestId("training-tabs");
  const items = tabs.getByRole("tab");
  await expect(items).toHaveCount(4);

  const [stripBox, firstBox, lastBox] = await settledBoxes([
    tabs,
    items.first(), // first-ok: the strip's first edge is the assertion
    items.last(),
  ]);
  expect(Math.abs(firstBox.x - stripBox.x)).toBeLessThan(2);
  expect(lastBox.x + lastBox.width).toBeLessThan(
    stripBox.x + stripBox.width - 100
  );
});

// Issue #1661 — a tab-first page's header action used to be handed to PageHeader,
// which lives inside the `hidden md:block` heading band, so on a phone the action
// simply did not exist. Training's Equipment link was the casualty: no door at all
// from Training to the equipment registry below `md`. The action is now its own
// cell beside the heading band rather than inside it, so it survives the band's
// disappearance — ONE node, right-aligned above the tab panel on a phone.
test("Training's Equipment door is reachable on a phone (#1661) — via Plan since #2892", async ({
  page,
}) => {
  // The header action is desktop-only now: on phones it rendered as a
  // full-width row above every tab, so the Plan tab's Equipment card is the
  // phone door. #1661's guarantee — gear reachable on a phone — holds; only
  // the door moved.
  await page.goto("/training?tab=overview");
  await expect(page.getByTestId("training-page-title")).toBeHidden();
  await expect(page.getByTestId("training-equipment-link")).toBeHidden();

  await page.goto("/training?tab=plan");
  const door = page.getByTestId("plan-equipment-link");
  await expect(door).toBeVisible();
  await expect(door).toHaveAttribute("href", "/equipment");

  await followLink(page, door, /\/equipment$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Equipment" })
  ).toBeVisible();
});

test("the desktop Training header keeps the Equipment door beside the title (#1661)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/training?tab=overview");

  const title = page.getByTestId("training-page-title");
  await expect(title).toBeVisible();
  const door = page
    .getByTestId("training-page-action")
    .getByTestId("training-equipment-link");
  await expect(door).toBeVisible();

  // Same row as the heading, to its right — where #1616 put it.
  const [titleBox, doorBox] = await settledBoxes([title, door]);
  expect(doorBox.x).toBeGreaterThan(titleBox.x);
  expect(doorBox.y).toBeLessThan(titleBox.y + titleBox.height);
});

test("no chart card renders on Overview — aggregate volume stays retired", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");
  await expect(page.getByTestId("training-today")).toBeVisible();

  const main = page.getByRole("main");
  await expect(main.getByText("Strength volume", { exact: true })).toHaveCount(
    0
  );
  await expect(main.getByText("Cardio volume", { exact: true })).toHaveCount(0);
  await expect(
    main.getByText("Cardio intensity mix", { exact: true })
  ).toHaveCount(0);
  // No recharts plot at all (the muscle-anatomy figure is a plain inline SVG, not a
  // chart, and stays) — the tab renders zero chart cards now.
  await expect(main.locator(".recharts-wrapper")).toHaveCount(0);
});

test("strength progress is folded into the standards ladder", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");
  const ladder = page.getByTestId("strength-standards-ladder");
  await expect(ladder).toBeVisible();
  expect(
    await ladder.getByTestId("strength-ladder-row").count()
  ).toBeLessThanOrEqual(3);
  await expect(page.getByTestId("overview-strength-prs")).toHaveCount(0);

  await followLink(
    page,
    ladder.getByRole("link", { name: "Full standards →" }),
    /tab=analyze/
  );
  await expect(page.getByTestId("analyze-section")).toBeVisible();
});

// ── #105: build ONLY the active tab ───────────────────────────────────────────

test("a tab renders only its own section (#105)", async ({ page }) => {
  await page.goto("/training?tab=overview");
  await expect(page.getByTestId("training-today")).toBeVisible();
  // The Analyze section is NOT built for an Overview request — the whole point of
  // the switch: six tabs of queries per visit became one.
  await expect(page.getByTestId("analyze-section")).toHaveCount(0);

  // …and the deep link still lands on Analyze, which then doesn't build Overview.
  await page.goto("/training?tab=analyze");
  await expect(page.getByTestId("analyze-section")).toBeVisible();
  await expect(page.getByTestId("training-today")).toHaveCount(0);

  // The default (paramless) tab is OVERVIEW since #2893 — the headline shell
  // change, pinned here so a quiet regression to log-as-default cannot pass.
  await page.goto("/training");
  await expect(page.getByTestId("training-today")).toBeVisible();
  await expect(page.getByTestId("analyze-section")).toHaveCount(0);
});

// ── Volume status belongs to coverage, not a second findings presentation ─────

test.describe("weekly volume has one presentation", () => {
  test("coverage owns the under-target count and findings do not repeat it", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRAINING_ROLLUP,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/training?tab=overview");

      await expect(
        page.getByTestId("muscle-coverage-below-target")
      ).toContainText(/\d+ muscle groups under weekly target/);
      await expect(page.getByTestId("training-findings-rollup")).toHaveCount(0);
      await expect(
        page
          .getByTestId("training-findings")
          .getByText(/muscle groups under weekly target/)
      ).toHaveCount(0);
    } finally {
      await page.close();
    }
  });
});
