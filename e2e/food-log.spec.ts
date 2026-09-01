import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  awaitHydrated,
  hydratedClick,
  settledBoxes,
  settledClick,
  settledSelect,
} from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_FOODPIN,
  E2E_MEMBER_PASSWORD,
  FOOD_PIN_GROUP,
  FOOD_PIN_PROFILE,
} from "./fixture-logins";
import { workerDbPath, frozenNow } from "./worker-env";
import { FOOD_QUICK_COUNT } from "@/lib/food-rank";

async function revealFoodGroup(page: Page, slug: string) {
  const row = page.getByTestId(`food-group-${slug}`);
  if (!(await row.isVisible())) {
    await hydratedClick(page, page.getByTestId("food-more-groups-summary"));
    await expect(row).toBeVisible();
  }
}

// Food-group serving log (issue #579): one-tap logging on /nutrition, the day-view
// count, and the weekly rollup. Idempotent — logs a serving, asserts it appears in both
// the day count and the weekly rollup, then undoes it so the fixture is left as found.
// Uses the shared authenticated storageState (the seeded profile already has food_daily_totals
// rows from scripts/seed.ts).

test("logging updates the day count, header total, and weekly rollup; undo restores them (#579)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  const bar = page.getByTestId("food-log-bar");
  await expect(bar).toBeVisible();
  await revealFoodGroup(page, "nuts_seeds");

  const count = page.getByTestId("count-nuts_seeds");
  const before = Number((await count.textContent())?.trim() || "0");
  const total = page.getByTestId("food-day-total");
  await expect(total).toBeVisible();
  const readTotal = async () =>
    Number((await total.textContent())?.match(/\d+/)?.[0] ?? "0");
  const totalBefore = await readTotal();

  // One tap → optimistic increment.
  await page.getByTestId("log-nuts_seeds").click();
  await expect(count).toHaveText(String(before + 1));
  await expect.poll(readTotal).toBe(totalBefore + 1);

  // The weekly rollup (server-rendered) reflects the serving after refresh.
  await expect(page.getByTestId("food-weekly-rollup")).toBeVisible();
  await expect(page.getByTestId("rollup-nuts_seeds")).toBeVisible();

  // Undo → decrement back (leave the fixture as found).
  await page.getByTestId("undo-nuts_seeds").click();
  await expect(count).toHaveText(String(before));
  await expect.poll(readTotal).toBe(totalBefore);
});

test("button counts are labeled for the selected meal and day", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await revealFoodGroup(page, "eggs");

  const meal = await page
    .getByTestId("food-slot-chip")
    .getAttribute("data-slot");
  expect(meal).toBeTruthy();
  await expect(page.getByTestId("food-slot-chip")).toHaveClass(
    /text-slate-500/
  );
  await expect(page.getByTestId("food-slot-chip")).not.toHaveClass(/\bbadge\b/);
  await expect(page.getByTestId("food-slot-chip")).toHaveText(meal!);
  await expect(page.getByTestId("count-eggs")).toHaveText(/\d+/);
  await expect(page.getByTestId("food-context-heading")).toHaveAccessibleName(
    new RegExp(`Today ${meal} Food Log`)
  );
  await page.getByTestId("food-day-yesterday").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText(meal!);
  await expect(page.getByTestId("food-day-yesterday")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByTestId("food-context-heading")).toHaveAccessibleName(
    new RegExp(`Yesterday ${meal} Food Log`)
  );
});

test("a food row is one dense line: icon, name, stepper (#3987)", async ({
  page,
}) => {
  // THE REMOVAL AND ITS CONVERSE, in one test. The eat-more/eat-less tags and the
  // per-row serving sentence are gone for everyone (owner rejected per-profile
  // sizing) — but the row still has to SAY WHICH GROUP IT IS and still has to carry
  // the tier, which is why the tint on the icon is asserted here beside the badge's
  // absence. An absence assertion alone passes just as happily on a row that lost
  // its identity too.
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  await revealFoodGroup(page, "cruciferous");
  const row = page.getByTestId("food-group-cruciferous");
  await expect(row.getByTestId("food-tier-cruciferous")).toHaveCount(0);
  await expect(row).not.toContainText("Eat more");
  // The serving sentence ("1 cup") is gone from the row and the phone disclosure that
  // existed only to unfold it went with it.
  await expect(row).not.toContainText("cup");
  await expect(page.getByTestId("detail-cruciferous")).toHaveCount(0);
  await expect(page.getByTestId("detail-static-cruciferous")).toHaveCount(0);

  // THE CONVERSE: name, tier tint, and both stepper halves are still on the row.
  await expect(row.getByTestId("food-name-cruciferous")).toBeVisible();
  await expect(row.getByTestId("food-name-cruciferous")).toHaveText(
    "Cruciferous vegetables"
  );
  await expect(row.getByTestId("food-group-icon")).toHaveClass(
    /text-emerald-500/
  );
  await expect(row.getByTestId("log-cruciferous")).toBeVisible();

  await revealFoodGroup(page, "processed_meat");
  const limitRow = page.getByTestId("food-group-processed_meat");
  await expect(limitRow.getByTestId("food-tier-processed_meat")).toHaveCount(0);
  await expect(limitRow).not.toContainText("Eat less");
  await expect(limitRow.getByTestId("food-group-icon")).toHaveClass(
    /text-amber-500/
  );

  // ONE LINE. The row's rendered height is within a line-box of the stepper's own
  // box — measured as a RELATIONSHIP, because "the row is 56px" says nothing about
  // whether a second line is wrapping inside it.
  const [rowBox, stepBox] = await settledBoxes([
    row,
    row.getByTestId("log-cruciferous"),
  ]);
  expect(rowBox.height).toBeLessThan(stepBox.height + 24);
});

test("the minus is not drawn until there is something to remove (#3987)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  const slug = "eggs";
  await revealFoodGroup(page, slug);
  const count = page.getByTestId(`count-${slug}`);
  const before = Number((await count.textContent())?.trim() || "0");
  // Reach zero for this meal, whatever the fixture left behind.
  for (let i = 0; i < before; i++) {
    await settledClick(page, page.getByTestId(`undo-${slug}`));
  }
  await expect(count).toHaveText("0");
  await expect(page.getByTestId(`undo-${slug}`)).toHaveCount(0);
  // AND IT COMES BACK. A permanently absent minus would satisfy the line above.
  await settledClick(page, page.getByTestId(`log-${slug}`));
  await expect(count).toHaveText("1");
  await expect(page.getByTestId(`undo-${slug}`)).toBeVisible();
  // Restore the fixture.
  await settledClick(page, page.getByTestId(`undo-${slug}`));
  for (let i = 0; i < before; i++) {
    await settledClick(page, page.getByTestId(`log-${slug}`));
  }
  await expect(count).toHaveText(String(before));
});

test("the quick rows are the head of the ranking — nothing in the overflow outranks them (#2225)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  const quick = page.getByTestId("food-quick-log");
  await expect(quick).toBeVisible();

  // The quick rows carry their position in the frozen ranked order. The tier quota this
  // issue deleted composed the six by tier (4 encourage / 1 neutral / 1 limit), which
  // routinely skipped a higher-ranked group for a lower-ranked one of the "right" tier —
  // exactly the disagreement with the Telegram nudge, which has always sliced the head of
  // the same ranking. The six are now that same head.
  const ranksIn = (rows: Locator) =>
    rows.evaluateAll((els) =>
      els.map((el) => Number(el.getAttribute("data-rank")))
    );

  // THE LIST'S OWN ROWS. Since #3362 the "More food groups" disclosure is a
  // citizen of this same list — it extends it, so it lives in it — which means
  // its (collapsed) rows are under `food-quick-log` too. Those are what the
  // control REACHES; they are not part of the head it sits at the end of, and
  // counting them here would turn "the six are the head of the ranking" into a
  // much weaker sentence that still went green. `food-quick-rows` is the element
  // that draws that line, so no spec has to redraw it.
  const quickRanks = await ranksIn(
    quick
      .getByTestId("food-quick-rows")
      .locator('li[data-testid^="food-group-"]')
  );
  expect(quickRanks).toHaveLength(FOOD_QUICK_COUNT);
  expect(quickRanks.every((rank) => Number.isInteger(rank))).toBe(true);
  // The head of the ranking, in rank order and starting at the top.
  expect(quickRanks).toEqual([...Array(FOOD_QUICK_COUNT).keys()]);

  // Everything else is one disclosure away (#559) and every one of it ranks BELOW the
  // last quick row. The overflow is sectioned by tier, so rank is read off the attribute
  // rather than off DOM order.
  const more = page.getByTestId("food-more-groups");
  await more.getByTestId("food-more-groups-summary").click();
  const overflow = more.locator('li[data-testid^="food-group-"]');
  await expect(overflow.first()).toBeVisible(); // first-ok: the disclosure's own rows, opened by this test
  const overflowRanks = await ranksIn(overflow);
  expect(overflowRanks.length).toBeGreaterThan(0);
  expect(Math.min(...overflowRanks)).toBeGreaterThan(Math.max(...quickRanks));
});

test("dietary preferences can be edited in a modal without leaving the food log", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // ONE preferences affordance at every width since #3987 — the Meals-cards header
  // that carried the desktop twin retired with the cards.
  await expect(page.getByTestId("food-preferences-open-desktop")).toHaveCount(
    0
  );
  const open = page.getByTestId("food-preferences-open");
  await expect(open).toBeVisible();
  await expect(open).not.toHaveAttribute("href");
  await open.click();

  const dialog = page.getByRole("dialog", { name: "Dietary preferences" });
  await expect(dialog).toBeVisible();
  const form = dialog.getByTestId("dietary-preferences-form");
  await expect(form).toBeVisible();
  await expect(form).not.toHaveClass(/\bcard\b/);
  await expect(dialog.getByTestId("dietary-preset")).toBeVisible();

  const done = dialog.getByTestId("food-preferences-done");
  await expect(done).toHaveClass(/\bbtn\b/);
  await done.click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/nutrition/);
});

test("the today/yesterday toggle backfills yesterday, not today (#748 item 1)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // A group untouched by the other specs, so parallel runs don't collide.
  const slug = "lean_fish";
  await revealFoodGroup(page, slug);
  const todayCount = page.getByTestId(`count-${slug}`);
  const todayBefore = Number((await todayCount.textContent())?.trim() || "0");

  // Switch the log target to yesterday.
  await page.getByTestId("food-day-yesterday").click();
  await expect(page.getByTestId("food-context-heading")).toHaveAccessibleName(
    /Yesterday (Morning|Midday|Evening) Food Log/
  );
  const yCount = page.getByTestId(`count-${slug}`);
  const yBefore = Number((await yCount.textContent())?.trim() || "0");

  // Log a serving on yesterday — the count reconciles to the server total.
  await page.getByTestId(`log-${slug}`).click();
  await expect(yCount).toHaveText(String(yBefore + 1));

  // Toggling back to today shows today's count UNCHANGED: the write hit yesterday.
  await page.getByTestId("food-day-today").click();
  await expect(page.getByTestId("food-context-heading")).toHaveAccessibleName(
    /Today (Morning|Midday|Evening) Food Log/
  );
  await expect(todayCount).toHaveText(String(todayBefore));

  // Restore the fixture — undo the yesterday serving.
  await page.getByTestId("food-day-yesterday").click();
  await expect(yCount).toHaveText(String(yBefore + 1));
  await page.getByTestId(`undo-${slug}`).click();
  await expect(yCount).toHaveText(String(yBefore));
});

test("a recent day can be viewed and backfilled in a specific meal", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // THE MEALS CARDS ARE GONE AND THE CHOICE THEY CARRIED IS NOT (#3987). Their totals
  // are the ledger's group headings; their SELECTION is this control, beside the rows
  // it targets — three segments, on one line, in the shared segmented idiom.
  await expect(page.getByTestId("food-meal-summary")).toHaveCount(0);
  const mealBoxes = await page
    .getByTestId("food-meal-slots")
    .locator("[data-segmented-option]")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect())
    );
  expect(mealBoxes).toHaveLength(3);
  expect(mealBoxes.every((box) => Math.abs(box.y - mealBoxes[0].y) < 1)).toBe(
    true
  );

  const slug = "cruciferous";
  await revealFoodGroup(page, slug);
  const initialSlot = await page
    .getByTestId("food-slot-chip")
    .getAttribute("data-slot");
  expect(initialSlot).toBeTruthy();
  const todayCount = page.getByTestId(`count-${slug}`);
  const todayBefore = Number((await todayCount.textContent())?.trim() || "0");

  // The picker exposes a bounded seven-day window; choose the third day and Dinner.
  const olderDay = page.locator('[data-days-ago="2"]');
  await olderDay.click();
  await expect(olderDay).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("nutrition-today-section")).toBeHidden();
  await page.getByTestId("food-slot-evening").click();
  await expect(page.getByTestId("food-slot-chip")).toHaveText("Evening");

  // Re-reveal: the day+slot switch re-renders the bar, which re-ranks for the EVENING
  // window and collapses the disclosure, so a group revealed for the initial slot can be
  // folded away again. Since #2369 the slot axis is two-sided — a group with history and
  // none of it in this window sorts BELOW the never-logged ones — so which groups the
  // quick six holds is per window, and this spec must not assume its subject stayed in.
  // The helper is a no-op when the row is already visible.
  await revealFoodGroup(page, slug);
  const olderCount = page.getByTestId(`count-${slug}`);
  const olderBefore = Number((await olderCount.textContent())?.trim() || "0");
  await settledClick(page, page.getByTestId(`log-${slug}`));
  await expect(olderCount).toHaveText(String(olderBefore + 1));
  await expect(olderCount).toHaveClass(/text-slate-700/);
  // The serving is STATED ONCE, in the ledger, under the meal it landed in (#3987).
  const eveningGroup = page.getByTestId("ledger-group-evening");
  await expect(eveningGroup).toBeVisible();
  await expect(eveningGroup).toContainText("Cruciferous vegetables");

  // Selecting Morning changes the logging TARGET only: the serving stays where it
  // happened and never migrates to the group being aimed at.
  await page.getByTestId("food-slot-morning").click();
  await expect(eveningGroup).toContainText("Cruciferous vegetables");
  await expect(page.getByTestId("ledger-group-morning")).not.toContainText(
    "Cruciferous vegetables"
  );
  await expect(olderCount).toHaveText("0");
  await expect(olderCount).toHaveClass(/text-slate-400/);

  // Today remains untouched.
  await page.getByTestId(`food-slot-${initialSlot!.toLowerCase()}`).click();
  await page.getByTestId("food-day-today").click();
  await expect(todayCount).toHaveText(String(todayBefore));

  // Restore the owned write in the exact day/meal where it was created.
  await olderDay.click();
  await page.getByTestId("food-slot-evening").click();
  await settledClick(page, page.getByTestId(`undo-${slug}`));
  await expect(olderCount).toHaveText(String(olderBefore));
});

test("the labs food-suggestions sidebar row opens its content without leaving the rail (#591)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  // The disclosure lives in the sidebar while minimized to a small badge. The
  // seeded profile has flagged-low omega-3 + folate readings
  // (e2e/seed-events.ts), so a suggestion exists.
  const badge = page.getByTestId("nutrition-suggestions");
  await expect(badge).toBeVisible();
  await expect(
    page.getByTestId("nutrition-sidebar").getByTestId("nutrition-suggestions")
  ).toBeVisible();
  const summary = page.getByTestId("nutrition-suggestions-summary");
  await expect(summary).toContainText("Lab suggestions");

  // Collapsed by default: a suggestion inside is not shown until the badge is opened.
  const suggestion = page.getByTestId("food-suggestion-omega-3");
  await expect(suggestion).toBeHidden();

  // Open → the suggestion becomes visible in a modal while the trigger remains
  // anchored in the sidebar.
  await summary.click();
  await expect(
    page.getByRole("dialog", { name: "Lab suggestions" })
  ).toBeVisible();
  await expect(
    page.getByTestId("nutrition-sidebar").getByTestId("nutrition-suggestions")
  ).toBeVisible();
  await expect(suggestion).toBeVisible();
});

test("logging a serving keeps the row order fixed (no reorder under the finger)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  const rowIds = () =>
    page.$$eval('li[data-testid^="food-group-"]', (els) =>
      els.map((e) => e.getAttribute("data-testid"))
    );
  const before = await rowIds();

  // Tap a low-ranked, zero-weight group. The server re-ranks by recency-decayed
  // frequency, so WITHOUT the client-side order freeze this tap would push the row
  // up its tier on the refresh; with the freeze it stays put until the user
  // navigates away. ONE tap: a second one here would land inside the post-success
  // cooldown (#2007) and be absorbed, and one serving is all the re-ranking
  // pressure this assertion needs.
  await revealFoodGroup(page, "other_vegetables");
  await page.getByTestId("log-other_vegetables").click();
  // The weekly rollup is server-rendered, so its row appearing proves the
  // router.refresh() (which carries the re-ranked order) has landed.
  await expect(page.getByTestId("rollup-other_vegetables")).toBeVisible();

  expect(await rowIds()).toEqual(before);

  // Restore the fixture.
  await page.getByTestId("undo-other_vegetables").click();
});

test.describe("the dense row keeps its anatomy on a phone (#3987)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("one line, one name mount, the icon centred on it", async ({ page }) => {
    // The disclosure this replaces existed ONLY to unfold the serving sentence, and
    // the sentence is gone, so the row has nothing left to expand. What has to survive
    // is the anatomy the disclosure's geometry test was really about: the leading icon
    // stays optically centred on the name, at the width where the row is tightest.
    await page.goto("/nutrition");
    await revealFoodGroup(page, "leafy_greens");

    await expect(page.getByTestId("detail-leafy_greens")).toHaveCount(0);
    // ONE name mount now — the `-mobile` twin went with the breakpoint fork.
    await expect(page.getByTestId("food-name-leafy_greens-mobile")).toHaveCount(
      0
    );
    const row = page.getByTestId("food-group-leafy_greens");
    const name = row.getByTestId("food-name-leafy_greens");
    await expect(name).toBeVisible();
    const icon = row.getByTestId("food-group-icon");
    const [rowBox, iconBox, nameBox, stepBox] = await settledBoxes([
      row,
      icon,
      name,
      row.getByTestId("log-leafy_greens"),
    ]);
    expect(
      Math.abs(
        iconBox.y + iconBox.height / 2 - (nameBox.y + nameBox.height / 2)
      )
    ).toBeLessThan(3);
    // The row is one line: its height is the stepper's box plus padding, not two.
    expect(rowBox.height).toBeLessThan(stepBox.height + 24);
  });
});

test("the Trends → Nutrition tab is the over-time view, not the duplicate rollup (#1166)", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  // #1166 reframed the tab: the duplicate FoodWeeklyRollup left for /nutrition; the
  // over-time cards (macros+fiber, adherence trend, intake grid) took its place. (The
  // detailed over-time assertions live in trends-nutrition.spec.ts.)
  await expect(page.getByTestId("nutrition-macros-chart")).toBeVisible();
  await expect(page.getByTestId("nutrition-trends-rollup")).toHaveCount(0);
  await expect(page.getByTestId("food-weekly-rollup")).toHaveCount(0);
});

test("a rapid double-tap logs TWO additive servings and never asks (#2007/#3611)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // A group untouched by the other specs, so parallel runs don't collide.
  const slug = "legumes";
  await revealFoodGroup(page, slug);
  const count = page.getByTestId(`count-${slug}`);
  const before = Number((await count.textContent())?.trim() || "0");
  const today = frozenNow().toISOString().slice(0, 10);
  // The shared authenticated fixture starts on its canonical profile 1 (file header).
  // Read the DAY axis directly: the visible row count above is meal-scoped, while the
  // cumulative receipt deliberately reports the group's whole-day total.
  const db = new Database(workerDbPath(), { readonly: true });
  const beforeDay = (() => {
    try {
      return (
        (
          db
            .prepare(
              `SELECT servings FROM food_daily_totals
                WHERE profile_id = 1 AND date = ? AND group_key = ?`
            )
            .get(today, slug) as { servings: number } | undefined
        )?.servings ?? 0
      );
    } finally {
      db.close();
    }
  })();
  const add = page.getByTestId(`log-${slug}`);

  // #3611 supersedes the old #2007 cooldown for this uncadenced additive row:
  // two taps mean two servings, even in the same instant.
  await awaitHydrated(add);
  await add.click();
  await add.click();
  await expect(count).toHaveText(String(before + 2));
  // A food serving is ADDITIVE and declares no expected interval, so it must never
  // raise the re-log question, however many times it is tapped.
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);

  // The count is optimistic. The one keyed cumulative toast is published only
  // after every pending add has settled and a fresh authoritative truth read says
  // both servings exist; wait for that durable marker before navigating away.
  const toast = page.locator(
    `[data-toast-key^="food-serving:"][data-toast-key$=":${today}:${slug}"]`
  );
  await expect(toast).toContainText(
    `${beforeDay + 2} servings of Legumes & beans today`
  );

  // The pin: a reload re-reads the server's own count, so this is the row that
  // exists and not merely the optimistic number shown above.
  await page.reload();
  await revealFoodGroup(page, slug);
  await expect(page.getByTestId(`count-${slug}`)).toHaveText(
    String(before + 2)
  );

  // A deliberate repeat still lands after the server-truth pin and asks nothing.
  await settledClick(page, page.getByTestId(`log-${slug}`));
  await expect(page.getByTestId(`count-${slug}`)).toHaveText(
    String(before + 3)
  );
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);

  // Restore the fixture. An undo is a DIFFERENT write from the log above it, so it
  // is never absorbed by that tap's cooldown.
  await settledClick(page, page.getByTestId(`undo-${slug}`));
  await expect(page.getByTestId(`count-${slug}`)).toHaveText(
    String(before + 2)
  );
  await page.reload();
  await revealFoodGroup(page, slug);
  await settledClick(page, page.getByTestId(`undo-${slug}`));
  await expect(page.getByTestId(`count-${slug}`)).toHaveText(
    String(before + 1)
  );
  await page.reload();
  await revealFoodGroup(page, slug);
  await settledClick(page, page.getByTestId(`undo-${slug}`));
  await expect(page.getByTestId(`count-${slug}`)).toHaveText(String(before));
});

// ── The deep-linked pin vs the ranked protein control (#2061) ────────────────────
//
// A protocol's "Log servings" opens the food bar with its own group pinned to the FRONT
// of the quick rows, whatever that group's rank. The protein control is placed by RANK
// ("N groups sit ahead of it"), and turning a rank into a slice point only works against
// the order the rows are actually rendered in: counting the quick rows that outrank
// protein put the split PAST the pin, which left a higher-ranked row below the control
// while the pinned lower-ranked one sat above it.
//
// The fixture profile logs no food, so the order is the curated catalog order: the
// protein entry ranks mid-list and FOOD_PIN_GROUP ranks after it. Protein therefore
// outranks every quick row once the pin leads, and the control renders first.
test("a protocol deep link pins its group, and the protein control still sits by rank (#2061)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FOODPIN,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    test.slow(); // local `next dev` compiles the protocol + overlay routes on first hit
    const db = new Database(workerDbPath());
    let protocolId: number;
    try {
      db.pragma("busy_timeout = 5000");
      protocolId = (
        db
          .prepare(
            `SELECT p.id AS id FROM protocols p
               JOIN profiles pr ON pr.id = p.profile_id
              WHERE pr.name = ?`
          )
          .get(FOOD_PIN_PROFILE) as { id: number }
      ).id;
    } finally {
      db.close();
    }

    await page.goto(`/protocols/${protocolId}`);
    await settledClick(page, page.getByTestId("protocol-log-button"));

    const quickLog = page
      .getByTestId("quick-entry-body")
      .getByTestId("food-quick-log");
    await expect(quickLog).toBeVisible();

    // The deep-linked group is the pinned row, and it is the first food row.
    const pinned = quickLog.locator('li[data-prefilled="true"]');
    await expect(pinned).toHaveAttribute(
      "data-testid",
      `food-group-${FOOD_PIN_GROUP}`
    );
    // The quick rows themselves — the disclosure's rows are in this section too
    // since #3362, and "the control leads the rows it outranks" is about the ones
    // it is laid out beside.
    const rows = quickLog
      .getByTestId("food-quick-rows")
      .locator('li[data-testid^="food-group-"]');
    const firstRow = rows.first(); // first-ok: the pin LEADING the quick rows is the assertion, on this spec's own fixture profile
    await expect(firstRow).toHaveAttribute("data-prefilled", "true");

    // The control leads the rows it outranks — including the pin, which it now
    // outranks BY RANK rather than by position in a list it never joined.
    const control = quickLog.getByTestId("protein-quickadd");
    await expect(control).toBeVisible();
    const controlBox = await control.boundingBox();
    expect(controlBox).not.toBeNull();
    const rowTops = (await rows.all()).map(
      async (row) => (await row.boundingBox())!.y
    );
    for (const top of await Promise.all(rowTops)) {
      expect(top).toBeGreaterThan(controlBox!.y);
    }
  } finally {
    await page.context().close();
  }
});

// ── Eating-time capture on the web bar (#2053, from #2019 §2) ───────────────────
//
// The Telegram button's tap contract is "I'm eating now", so #2052 records its instant.
// The web "+" carries no such contract — the same button logs the apple in your hand and
// backfills Sunday's dinner — so it stays SILENT unless the user says otherwise, and
// these chips are that statement. What is asserted is what the issue asked for: an
// explicit choice writes `time_source = 'stated'`, silence writes nothing at all, and the
// affordance is absent on a day where "now" would be meaningless.
//
// Fixture discipline: each test logs its OWN serving, finds that row by the id that
// appeared in the day's list, reads THAT row from SQLite, and removes it again through
// the product's own ⋯ → "Remove this serving" — so the shared profile is left as found
// and nothing exact-counts a seeded row.

// THE DAY LEDGER'S SERVING ROWS (#3987). The LOGGED-TODAY list retired into it; the
// rows carry the same `data-group`/`data-slot` attributes they always did, so the
// fixture discipline below is unchanged — only the container it reads from moved.
function loggedListRows(page: Page) {
  return page.getByTestId("day-ledger").locator("li[data-group]");
}

// THE STATEMENT IS BEHIND A FOLD NOW (#3273's ruled shape). Idempotent: the tests
// below open it once and it stays open for the rest of their run.
async function openWhenFold(page: Page): Promise<void> {
  const fold = page.getByTestId("food-eating-time");
  const open = await fold.evaluate(
    (el) => (el as HTMLDetailsElement).open === true
  );
  if (!open) await hydratedClick(page, page.getByTestId("food-when-summary"));
}

async function loggedListIds(page: Page): Promise<string[]> {
  return loggedListRows(page).evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("data-testid") ?? "")
  );
}

// The ledger id of the one row that appeared since `before`.
async function newlyLoggedId(page: Page, before: string[]): Promise<string> {
  const added = (await loggedListIds(page)).filter(
    (id) => !before.includes(id)
  );
  if (added.length !== 1)
    throw new Error(
      `expected exactly one new serving row, saw ${added.length}: ${added.join(", ")}`
    );
  return added[0].replace("ledger-serving-", "");
}

function eatingTimeOf(eventId: string): {
  occurred_at: string | null;
  time_source: string | null;
} {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return db
      .prepare(
        "SELECT occurred_at, time_source FROM food_log_events WHERE id = ?"
      )
      .get(Number(eventId)) as {
      occurred_at: string | null;
      time_source: string | null;
    };
  } finally {
    db.close();
  }
}

// AN HOUR THAT IS OFFERED AND FILES DETERMINISTICALLY, at every UTC start hour.
// e2e/pinned-timezone.ts puts the frozen clock at 13:mm LOCAL, so the control offers
// today's hours 00:00…13:00 and the active tab is Midday under the default
// 11:00/15:00 boundaries. 08:00 is therefore always on offer and always Morning —
// the two facts every eating-time test below leans on.
const EARLIER_HOUR = "08:00";
const EARLIER_HOUR_SLOT = "Morning";

// State an eating time by the wall clock it READS, through the settled path.
//
// Two reasons it is a helper and not a `selectOption`. The control's option VALUES
// are ISO instants — the day's hours resolved in the profile's rotating zone — which
// a spec has no business spelling; the LABEL is the absolute local time, which is the
// thing the user picks and the thing #2236's invariant 4 is about. And a bare
// `selectOption` on a CONTROLLED select can land before hydration, set the DOM value,
// fire no `onChange`, and be reverted — the swallow `settledSelect` exists for. It is
// not hypothetical here: measured 2 runs in 3 on this file the first time the box was
// loaded enough to widen the window.
async function stateEatingTime(page: Page, hhmm: string): Promise<void> {
  const field = page.getByTestId("food-when-time");
  const value = await field
    .getByRole("option", { name: hhmm, exact: true })
    .getAttribute("value");
  await settledSelect(page, field, value ?? "");
}

async function removeLoggedServing(page: Page, eventId: string): Promise<void> {
  const row = page.getByTestId(`ledger-serving-${eventId}`);
  await hydratedClick(
    page,
    row.getByRole("button", { name: /^Actions for the/ })
  );
  await settledClick(
    page,
    page.getByTestId(`ledger-serving-remove-${eventId}`)
  );
  await expect(row).toHaveCount(0);
}

test("a serving logged with no stated time records no eating time (#2053)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // The affordance is offered — as a fold, closed, because it is a question most taps
  // never answer (#3987) — and untouched it asserts nothing. The shared control NEVER
  // defaults to now (#2236 invariant 3): the field is empty on arrival.
  await expect(page.getByTestId("food-when-summary")).toHaveText(
    "Happened earlier?"
  );
  await openWhenFold(page);
  await expect(page.getByTestId("food-when-time")).toHaveValue("");
  await expect(page.getByTestId("food-eating-time-note")).toContainText(
    "recorded with no eating time"
  );

  await revealFoodGroup(page, "nuts_seeds");
  const before = await loggedListIds(page);
  await settledClick(page, page.getByTestId("log-nuts_seeds"));
  await expect(loggedListRows(page)).toHaveCount(before.length + 1);

  const eventId = await newlyLoggedId(page, before);
  // NULL, not "now": defaulting a web log to the tap instant would reintroduce the
  // guess `occurred_at` exists to end, under a more authoritative name.
  expect(eatingTimeOf(eventId)).toEqual({
    occurred_at: null,
    time_source: null,
  });

  await removeLoggedServing(page, eventId);
});

test("the control's Now fills an absolute local time, and it is what lands (#2053/#3273)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // Not a "now" MODE — the button FILLS the field with the absolute local time it
  // means, so what will be written is on screen and adjustable before the tap.
  await openWhenFold(page);
  await hydratedClick(page, page.getByTestId("food-when-now"));
  const field = page.getByTestId("food-when-time");
  await expect(field).not.toHaveValue("");
  const filled = (await field.locator("option:checked").textContent())!.trim();
  expect(filled).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
  await expect(page.getByTestId("food-eating-time-note")).toContainText(
    `recorded as eaten at ${filled}`
  );

  await revealFoodGroup(page, "nuts_seeds");
  const before = await loggedListIds(page);
  await settledClick(page, page.getByTestId("log-nuts_seeds"));
  await expect(loggedListRows(page)).toHaveCount(before.length + 1);

  const eventId = await newlyLoggedId(page, before);
  const stamped = eatingTimeOf(eventId);
  // 'stated', never 'tap': the web "+" declares no contract of its own, so the source of
  // the instant is the person who pressed the chip.
  expect(stamped.time_source).toBe("stated");
  expect(stamped.occurred_at).not.toBeNull();
  expect(
    Math.abs(new Date(stamped.occurred_at!).getTime() - frozenNow().getTime())
  ).toBeLessThan(10 * 60_000);

  // The statement is withdrawable — the empty option is a real answer, so there is no
  // way to be stuck having said something.
  await settledSelect(page, page.getByTestId("food-when-time"), "");
  await expect(page.getByTestId("food-eating-time-note")).toContainText(
    "recorded with no eating time"
  );

  await removeLoggedServing(page, eventId);
});

test("an earlier hour states an absolute time, and it is what lands (#2053)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  await openWhenFold(page);
  // The day half is FIXED to the SELECTED day, so the control renders it as text
  // rather than as a picker that could disagree with the tab.
  await expect(page.getByTestId("food-when-date")).toHaveText("Today");

  // Every offered hour is one the write will accept: the control truncates today's
  // hours at the current local hour, so nothing on screen can be refused. The e2e
  // clock is pinned to 13:mm local, so 08:00 is always among them.
  const hhmm = EARLIER_HOUR;
  await stateEatingTime(page, hhmm);
  await expect(page.getByTestId("food-eating-time-note")).toContainText(
    `recorded as eaten at ${hhmm}`
  );

  await revealFoodGroup(page, "nuts_seeds");
  const before = await loggedListIds(page);
  await settledClick(page, page.getByTestId("log-nuts_seeds"));
  await expect(loggedListRows(page)).toHaveCount(before.length + 1);

  const eventId = await newlyLoggedId(page, before);
  const stamped = eatingTimeOf(eventId);
  expect(stamped.time_source).toBe("stated");
  // The stated wall time is what the row carries — resolved server-side in the profile's
  // timezone, so the browser never converted it.
  await expect(page.getByTestId(`ledger-serving-${eventId}`)).toBeVisible();
  expect(stamped.occurred_at).not.toBeNull();
  expect(new Date(stamped.occurred_at!).getTime()).toBeLessThan(
    frozenNow().getTime()
  );
  // AND THE ROW STATES IT (#2206). The web half of "a surface must not go on showing the
  // time a statement replaced": the logged list names this serving by the hour that was
  // chosen, not by the moment the "+" was pressed. Both surfaces are absolute, so the
  // control's own option label is what the row ends up reading.
  await expect(page.getByTestId(`ledger-serving-${eventId}`)).toContainText(
    hhmm
  );

  await removeLoggedServing(page, eventId);
});

test("a stated time wins over the tab: the serving lands, visibly, in its derived section (#2269)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // State an hour whose window is DETERMINED rather than read off the control: the
  // e2e clock is pinned to 13:mm local (Midday under the default 11:00/15:00
  // boundaries), so 08:00 is offered and files under Morning at every UTC start hour.
  const filingSlot = EARLIER_HOUR_SLOT;
  await openWhenFold(page);
  await stateEatingTime(page, EARLIER_HOUR);

  // Stand in a DIFFERENT tab than the one the hour files under. The tab is
  // navigation; the statement stated the consequence.
  const otherTab = ["Morning", "Midday", "Evening"].find(
    (slot) => slot !== filingSlot
  )!;
  await hydratedClick(
    page,
    page.getByTestId(`food-slot-${otherTab.toLowerCase()}`)
  );
  // The answer text names the filing before the tap does.
  await expect(page.getByTestId("food-eating-time-note")).toContainText(
    `and land in ${filingSlot}`
  );

  await revealFoodGroup(page, "nuts_seeds");
  const before = await loggedListIds(page);
  await settledClick(page, page.getByTestId("log-nuts_seeds"));

  // The server files it under the DERIVED meal (no meal_slot echo was stored — the
  // row's window comes from the stated instant), and the ledger states it there and
  // ONLY there: the tab that was being looked at gains nothing.
  await expect(loggedListRows(page)).toHaveCount(before.length + 1);
  const eventId = await newlyLoggedId(page, before);
  const row = page.getByTestId(`ledger-serving-${eventId}`);
  await expect(row).toHaveAttribute("data-slot", filingSlot);
  await expect(
    page.getByTestId(`ledger-group-${filingSlot.toLowerCase()}`)
  ).toContainText("Nuts & seeds");
  expect(
    await page
      .getByTestId(`ledger-group-${otherTab.toLowerCase()}`)
      .locator(`[data-testid="ledger-serving-${eventId}"]`)
      .count()
  ).toBe(0);

  await removeLoggedServing(page, eventId);
});

test("the time question relabels on a past day and its answer is per-day (#4118)", async ({
  page,
}) => {
  // THE OWNER AMENDMENT. The statement used to be withheld entirely on a backfill,
  // because "now" is meaningless there. It is not withheld any more — "8pm on Tuesday"
  // is a perfectly honest thing to say about a meal being reconstructed — but the
  // QUESTION changes, because a bare tap on a past day means the meal slot and no
  // instant rather than "now".
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await expect(page.getByTestId("food-when-summary")).toHaveText(
    "Happened earlier?"
  );

  await hydratedClick(page, page.getByTestId("food-day-yesterday"));
  await expect(page.getByTestId("food-eating-time")).toBeVisible();
  await expect(page.getByTestId("food-when-summary")).toHaveText("Set time?");
  await openWhenFold(page);
  // The shared control renders a FIXED day as text, and names it relatively only for
  // today — a past day reads as its own calendar date.
  await expect(page.getByTestId("food-when-date")).toHaveText(
    /^\d{4}-\d{2}-\d{2}$/
  );
  await expect(page.getByTestId("food-eating-time-note")).toContainText(
    "with no time until you set one"
  );

  // STICKY FOR THE BATCH, AND THE BATCH IS A DAY. A time set for yesterday is shown
  // in the summary so nothing is silently in force, and it is NOT in force on today.
  await stateEatingTime(page, EARLIER_HOUR);
  await expect(page.getByTestId("food-when-set")).toHaveText(EARLIER_HOUR);
  await hydratedClick(page, page.getByTestId("food-day-today"));
  await expect(page.getByTestId("food-when-summary")).toHaveText(
    "Happened earlier?"
  );
  await expect(page.getByTestId("food-when-set")).toHaveCount(0);
  await expect(page.getByTestId("food-eating-time-note")).toContainText(
    "recorded with no eating time"
  );
});
