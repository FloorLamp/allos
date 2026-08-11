import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { followLink, settledClick } from "./helpers";
import {
  E2E_LOGIN_TRAINING_ROLLUP,
  E2E_MEMBER_PASSWORD,
  TRAINING_ROLLUP_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Issue #1496 — Training → Overview becomes the DOING surface (the other half of
// #1492's rule: analyze on Trends, do on /training). On a 390×844 phone the tab was
// an 8,798px wall whose first chart sat at 7,973px, led by ~17 uncapped per-muscle
// finding cards with today's session buried mid-page. This spec pins the recomposed
// order, the ONE findings rollup (with its item-wise dismiss still working through
// the shared bus), the departed charts, the capped PR lists, and the #105
// build-only-the-active-tab structure.
//
// Runs on the MOBILE project (the viewport the audit measured).

// ── Layout assertions: read-only, against the shared seeded admin session ──────

// The vertical position of an element, for order assertions.
async function topOf(page: Page, testid: string): Promise<number> {
  return await page
    .getByTestId(testid)
    .evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
}

test("Overview leads with today's session, then the week, then the findings rollup", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");

  // On phones the six-tab navigation IS the page identity: the visible
  // Training title/subtitle leave the content flow and the one-row strip joins
  // the auto-hiding app shell. Unlike the compact equal-column pages, six tabs
  // scroll horizontally instead of becoming two tall rows.
  await expect(page.getByTestId("training-page-title")).toBeHidden();
  const shell = page.getByTestId("shell-chrome");
  const shellTabs = shell.getByTestId("shell-tab-strip");
  const tabs = shellTabs.getByTestId("training-tabs");
  await expect(tabs).toBeVisible();
  await expect(tabs).toHaveCSS("overflow-y", "hidden");
  await expect(tabs.getByRole("tab")).toHaveCount(6);
  await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  const stripOverflow = await tabs.evaluate(
    (el) => el.scrollWidth > el.clientWidth
  );
  expect(stripOverflow).toBe(true);

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

  // #1937: the week tile is Sessions + Days. The "Streak" tile that used to sit
  // beside them is gone — it restated the active-day count next to it, and did so
  // less honestly (it counted ACTIVE days with a rest day of tolerance, so a
  // Mon/Wed/Fri rhythm read as a five-day run across nine days).
  const week = page.getByTestId("training-week");
  await expect(week.getByText("Sessions", { exact: true })).toBeVisible();
  await expect(week.getByText("Days", { exact: true })).toBeVisible();
  await expect(week.getByText("Streak", { exact: true })).toHaveCount(0);
});

test("a later deep-linked Training tab is brought into the visible tab row", async ({
  page,
}) => {
  await page.goto("/training?tab=goals");
  const tabs = page.getByTestId("training-tabs");
  const goals = tabs.getByRole("tab", { name: "Goals" });
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
  await expect(items).toHaveCount(6);

  const [stripBox, firstBox, lastBox] = await Promise.all([
    tabs.boundingBox(),
    items.first().boundingBox(), // first-ok: the six-tab strip's first edge is the assertion
    items.last().boundingBox(),
  ]);
  expect(stripBox).not.toBeNull();
  expect(firstBox).not.toBeNull();
  expect(lastBox).not.toBeNull();
  expect(Math.abs(firstBox!.x - stripBox!.x)).toBeLessThan(2);
  expect(
    Math.abs(lastBox!.x + lastBox!.width - (stripBox!.x + stripBox!.width))
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
  await expect(items).toHaveCount(6);

  const [stripBox, firstBox, lastBox] = await Promise.all([
    tabs.boundingBox(),
    items.first().boundingBox(), // first-ok: the six-tab strip's first edge is the assertion
    items.last().boundingBox(),
  ]);
  expect(stripBox).not.toBeNull();
  expect(firstBox).not.toBeNull();
  expect(lastBox).not.toBeNull();
  expect(Math.abs(firstBox!.x - stripBox!.x)).toBeLessThan(2);
  expect(lastBox!.x + lastBox!.width).toBeLessThan(
    stripBox!.x + stripBox!.width - 100
  );
});

// Issue #1661 — a tab-first page's header action used to be handed to PageHeader,
// which lives inside the `hidden md:block` heading band, so on a phone the action
// simply did not exist. Training's Equipment link was the casualty: no door at all
// from Training to the equipment registry below `md`. The action is now its own
// cell beside the heading band rather than inside it, so it survives the band's
// disappearance — ONE node, right-aligned above the tab panel on a phone.
test("Training's Equipment door is reachable on a phone (#1661)", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");

  // The heading band itself is still gone below `md` — the action is not part of it.
  await expect(page.getByTestId("training-page-title")).toBeHidden();

  const action = page.getByTestId("training-page-action");
  await expect(action).toBeVisible();
  const door = action.getByTestId("training-equipment-link");
  await expect(door).toBeVisible();
  await expect(door).toHaveAttribute("href", "/equipment");

  // It sits above the tab panel's content rather than overlapping it, and is a
  // real tap target rather than a bare line of text.
  const [doorBox, todayBox] = await Promise.all([
    door.boundingBox(),
    page.getByTestId("training-today").boundingBox(),
  ]);
  expect(doorBox!.height).toBeGreaterThanOrEqual(24);
  expect(doorBox!.y + doorBox!.height).toBeLessThanOrEqual(todayBox!.y);

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
  const [titleBox, doorBox] = await Promise.all([
    title.boundingBox(),
    door.boundingBox(),
  ]);
  expect(doorBox!.x).toBeGreaterThan(titleBox!.x);
  expect(doorBox!.y).toBeLessThan(titleBox!.y + titleBox!.height);
});

test("no chart card renders on Overview — the volume/intensity block moved to Trends → Fitness", async ({
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

test("recent PRs render top-3 with a show-all hand-off to Analyze", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");
  const card = page.getByTestId("overview-strength-prs");
  await expect(card).toBeVisible();

  // The seeded profile has more than three recent strength PRs, so the hand-off link
  // renders — and exactly three rows are drawn (the 14-row list is gone).
  const showAll = card.getByTestId("overview-strength-prs-all");
  await expect(showAll).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveCount(3);

  await followLink(page, showAll, /tab=analyze/);
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

  // The default (paramless) tab is still the Training Log.
  await page.goto("/training");
  await expect(page.getByTestId("training-today")).toHaveCount(0);
  await expect(page.getByTestId("analyze-section")).toHaveCount(0);
});

// ── The findings rollup + its item-wise dismiss ───────────────────────────────

// SPEC-OWNED FIXTURE (#868): the dismiss below writes a suppression row, so it runs
// as a dedicated login on a dedicated profile whose light accessory log fires several
// per-muscle volume-band shortfalls. Clearing that profile's volume-band dismissals
// before AND after keeps the test self-contained under --repeat-each and leaves the
// DB as it found it.
function clearRollupDismissals(): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `DELETE FROM upcoming_dismissals
        WHERE signal_key LIKE 'muscle-volume:%'
          AND profile_id = (SELECT id FROM profiles WHERE name = ?)`
    ).run(TRAINING_ROLLUP_PROFILE);
  } finally {
    db.close();
  }
}

test.describe("the coaching findings render as ONE rollup card", () => {
  test.beforeAll(() => clearRollupDismissals());
  test.afterAll(() => clearRollupDismissals());

  test("expanding the rollup dismisses item-wise and the rollup survives with N−1", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles /training on first hit
    clearRollupDismissals();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRAINING_ROLLUP,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/training?tab=overview");

      // ONE card, ONE rollup row — never N sibling cards.
      const card = page.getByTestId("training-findings");
      await expect(card).toBeVisible();
      const rollup = card.getByTestId("training-findings-rollup");
      await expect(rollup).toHaveCount(1);
      await expect(
        rollup.getByTestId("training-findings-rollup-title")
      ).toContainText(/\d+ muscle groups under weekly target/);

      // The per-muscle findings live INSIDE it, revealed by the disclosure — each
      // with its own dismiss button (a pure client toggle, no POST).
      const items = rollup.getByTestId("training-findings-rollup-item");
      await rollup.locator("summary").click();
      await expect(items.first()).toBeVisible(); // first-ok: this spec owns the fixture; the rollup's first item
      const before = await items.count();
      expect(before).toBeGreaterThan(1);

      // Dismiss ONE of them: the identities/dedupeKeys are untouched by the
      // aggregation, so this is the same shared-bus write a flat card always made.
      const victim = items.nth(0);
      const victimTitle = (await victim.innerText()).split("\n")[0];
      await settledClick(
        page,
        victim.getByTestId("training-findings-rollup-dismiss")
      );

      // That ONE finding is gone; the rollup itself survives with N−1 and re-counts.
      await expect(items).toHaveCount(before - 1);
      await expect(rollup).toHaveCount(1);
      await expect(items.filter({ hasText: victimTitle })).toHaveCount(0);
      await expect(
        rollup.getByTestId("training-findings-rollup-title")
      ).toContainText(`${before - 1} muscle group`);
    } finally {
      await page.close();
    }
  });
});
