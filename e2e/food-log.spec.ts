import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_FOODPIN,
  E2E_MEMBER_PASSWORD,
  FOOD_PIN_GROUP,
  FOOD_PIN_PROFILE,
} from "./fixture-logins";
import { workerDbPath, frozenNow } from "./worker-env";

async function revealFoodGroup(page: Page, slug: string) {
  const row = page.getByTestId(`food-group-${slug}`);
  if (!(await row.isVisible())) {
    await page.getByTestId("food-more-groups-summary").click();
    await expect(row).toBeVisible();
  }
}

// Food-group serving log (issue #579): one-tap logging on /nutrition, the day-view
// count, and the weekly rollup. Idempotent — logs a serving, asserts it appears in both
// the day count and the weekly rollup, then undoes it so the fixture is left as found.
// Uses the shared authenticated storageState (the seeded profile already has food_log
// rows from scripts/seed.ts).

test("logging a serving shows in the day count and the weekly rollup, undo decrements (#579)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  const bar = page.getByTestId("food-log-bar");
  await expect(bar).toBeVisible();
  await revealFoodGroup(page, "nuts_seeds");

  const count = page.getByTestId("count-nuts_seeds");
  const before = Number((await count.textContent())?.trim() || "0");

  // One tap → optimistic increment.
  await page.getByTestId("log-nuts_seeds").click();
  await expect(count).toHaveText(String(before + 1));

  // The weekly rollup (server-rendered) reflects the serving after refresh.
  await expect(page.getByTestId("food-weekly-rollup")).toBeVisible();
  await expect(page.getByTestId("rollup-nuts_seeds")).toBeVisible();

  // Undo → decrement back (leave the fixture as found).
  await page.getByTestId("undo-nuts_seeds").click();
  await expect(count).toHaveText(String(before));
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
  await expect(page.getByTestId("count-eggs")).toHaveAttribute(
    "title",
    new RegExp(`in ${meal} today$`)
  );
  await page.getByTestId("food-day-yesterday").click();
  await expect(page.getByTestId("count-eggs")).toHaveAttribute(
    "title",
    new RegExp(`in ${meal} yesterday$`)
  );
});

test("compact food rows identify eat-more and eat-less guidance", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  await revealFoodGroup(page, "cruciferous");
  await expect(page.getByTestId("food-tier-cruciferous")).toHaveText(
    "Eat more"
  );
  await expect(
    page.getByTestId("food-group-cruciferous").getByTestId("food-group-icon")
  ).toHaveClass(/text-emerald-500/);

  await revealFoodGroup(page, "processed_meat");
  await expect(page.getByTestId("food-tier-processed_meat")).toHaveText(
    "Eat less"
  );
  await expect(
    page.getByTestId("food-group-processed_meat").getByTestId("food-group-icon")
  ).toHaveClass(/text-amber-500/);
});

test("dietary preferences can be edited in a modal without leaving the food log", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  const open = page.getByTestId("food-preferences-open-desktop");
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

  const mealLayouts = await page
    .getByTestId("food-meal-slots")
    .locator("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const firstChild = button.firstElementChild;
        return {
          offset: firstChild
            ? firstChild.getBoundingClientRect().top -
              button.getBoundingClientRect().top
            : Number.NaN,
          justifyContent: getComputedStyle(button).justifyContent,
        };
      })
    );
  expect(mealLayouts).toHaveLength(3);
  expect(
    mealLayouts.every(({ justifyContent }) => justifyContent === "flex-start")
  ).toBe(true);
  expect(
    mealLayouts.every(
      ({ offset }) => Math.abs(offset - mealLayouts[0].offset) < 1
    )
  ).toBe(true);
  await expect(page.getByTestId("food-meal-summary")).toHaveCSS(
    "border-top-width",
    "0px"
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

  const olderCount = page.getByTestId(`count-${slug}`);
  const olderBefore = Number((await olderCount.textContent())?.trim() || "0");
  await settledClick(page, page.getByTestId(`log-${slug}`));
  await expect(olderCount).toHaveText(String(olderBefore + 1));
  await expect(olderCount).toHaveClass(/text-slate-700/);
  const eveningItem = page.getByTestId(`food-meal-item-evening-${slug}`);
  await expect(eveningItem).toBeVisible();

  // All meals remain visible at once. Selecting Morning changes the logging target,
  // but the serving stays visible in the Evening card and never appears in Morning.
  await page.getByTestId("food-slot-morning").click();
  await expect(eveningItem).toBeVisible();
  await expect(page.getByTestId(`food-meal-item-morning-${slug}`)).toHaveCount(
    0
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

test("the header shows today's total, ticking up on log and back on undo", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await revealFoodGroup(page, "eggs");
  const total = page.getByTestId("food-day-total");
  await expect(total).toBeVisible();
  const read = async () =>
    Number((await total.textContent())?.match(/\d+/)?.[0] ?? "0");

  const before = await read();
  await page.getByTestId("log-eggs").click();
  await expect.poll(read).toBe(before + 1);
  await page.getByTestId("undo-eggs").click();
  await expect.poll(read).toBe(before);
});

test.describe("tapping a category expands its serving detail on mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the truncated serving line expands in place on tap", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    await revealFoodGroup(page, "leafy_greens");

    const toggle = page.getByTestId("detail-leafy_greens");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Collapsed: the serving line is clamped to one line.
    const desc = toggle.locator("span span").last();
    const collapsedH = (await desc.boundingBox())!.height;
    const row = page.getByTestId("food-group-leafy_greens");
    const icon = row.getByTestId("food-group-icon");
    const name = row.getByTestId("food-name-leafy_greens");
    const collapsedRowBox = (await row.boundingBox())!;
    const collapsedIconBox = (await icon.boundingBox())!;
    const collapsedNameBox = (await name.boundingBox())!;
    const collapsedIconOffset = collapsedIconBox.y - collapsedRowBox.y;
    expect(
      Math.abs(
        collapsedIconBox.y +
          collapsedIconBox.height / 2 -
          (collapsedNameBox.y + collapsedNameBox.height / 2)
      )
    ).toBeLessThan(3);

    // Tap the label → it expands downward without recentering the leading icon.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const expandedH = (await desc.boundingBox())!.height;
    const expandedRowBox = (await row.boundingBox())!;
    const expandedIconBox = (await icon.boundingBox())!;
    const expandedIconOffset = expandedIconBox.y - expandedRowBox.y;
    expect(expandedH).toBeGreaterThan(collapsedH);
    expect(Math.abs(expandedIconOffset - collapsedIconOffset)).toBeLessThan(1);

    // Tap again → collapses back.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

test("food serving details are always visible and not expandable above mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/nutrition");
  await revealFoodGroup(page, "leafy_greens");

  await expect(page.getByTestId("detail-leafy_greens")).toBeHidden();
  const detail = page.getByTestId("detail-static-leafy_greens");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(
    "A cup of raw (or ½ cup cooked) spinach, kale, chard, romaine"
  );
  await expect(detail).not.toHaveAttribute("aria-expanded", /.*/);
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

test("a double-tap logs ONE serving, and a food tap never asks (#2007)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // A group untouched by the other specs, so parallel runs don't collide.
  const slug = "legumes";
  await revealFoodGroup(page, slug);
  const count = page.getByTestId(`count-${slug}`);
  const before = Number((await count.textContent())?.trim() || "0");
  const add = page.getByTestId(`log-${slug}`);

  // The fat-finger double: two taps in the same instant. The second lands inside the
  // post-success cooldown and is absorbed — no second request, no queued write.
  await add.click();
  await add.click();
  await expect(count).toHaveText(String(before + 1));
  // A food serving is ADDITIVE and declares no expected interval, so it must never
  // raise the re-log question, however many times it is tapped.
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);

  // The pin: a reload re-reads the server's own count, so this is the row that
  // exists and not the optimistic number the second tap would also have shown.
  await page.reload();
  await revealFoodGroup(page, slug);
  await expect(page.getByTestId(`count-${slug}`)).toHaveText(
    String(before + 1)
  );

  // A deliberate repeat still lands — the reload cleared the window — and still
  // asks nothing.
  await settledClick(page, page.getByTestId(`log-${slug}`));
  await expect(page.getByTestId(`count-${slug}`)).toHaveText(
    String(before + 2)
  );
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);

  // Restore the fixture. An undo is a DIFFERENT write from the log above it, so it
  // is never absorbed by that tap's cooldown.
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
    const rows = quickLog.locator('li[data-testid^="food-group-"]');
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

function loggedListRows(page: Page) {
  return page.getByTestId("food-logged-list").locator("li[data-group]");
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
  return added[0].replace("food-logged-", "");
}

function eatingTimeOf(eventId: string): {
  eaten_at: string | null;
  time_source: string | null;
} {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return db
      .prepare("SELECT eaten_at, time_source FROM food_log_events WHERE id = ?")
      .get(Number(eventId)) as {
      eaten_at: string | null;
      time_source: string | null;
    };
  } finally {
    db.close();
  }
}

async function removeLoggedServing(page: Page, eventId: string): Promise<void> {
  const row = page.getByTestId(`food-logged-${eventId}`);
  await row.getByRole("button", { name: /^Actions for the/ }).click();
  await settledClick(page, page.getByTestId(`food-logged-remove-${eventId}`));
  await expect(row).toHaveCount(0);
}

test("a serving logged with no stated time records no eating time (#2053)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // The affordance is offered, and untouched it asserts nothing.
  await expect(page.getByTestId("food-eating-now")).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  await expect(page.getByTestId("food-eating-time-note")).toContainText(
    "record no eating time"
  );

  await revealFoodGroup(page, "nuts_seeds");
  const before = await loggedListIds(page);
  await settledClick(page, page.getByTestId("log-nuts_seeds"));
  await expect(loggedListRows(page)).toHaveCount(before.length + 1);

  const eventId = await newlyLoggedId(page, before);
  // NULL, not "now": defaulting a web log to the tap instant would reintroduce the
  // guess `eaten_at` exists to end, under a more authoritative name.
  expect(eatingTimeOf(eventId)).toEqual({ eaten_at: null, time_source: null });

  await removeLoggedServing(page, eventId);
});

test("the Now chip stamps servings as eaten now, stated (#2053)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  await hydratedClick(page, page.getByTestId("food-eating-now"));
  await expect(page.getByTestId("food-eating-now")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByTestId("food-eating-time-note")).toContainText(
    "recorded as eaten now"
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
  expect(stamped.eaten_at).not.toBeNull();
  expect(
    Math.abs(new Date(stamped.eaten_at!).getTime() - frozenNow().getTime())
  ).toBeLessThan(10 * 60_000);

  // Pressing it again withdraws the statement — the chips are toggles, so there is no
  // separate "clear" and no way to be stuck in a mode.
  await hydratedClick(page, page.getByTestId("food-eating-now"));
  await expect(page.getByTestId("food-eating-now")).toHaveAttribute(
    "aria-pressed",
    "false"
  );

  await removeLoggedServing(page, eventId);
});

test("Earlier… states an absolute hour, and it is what lands (#2053)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // The hours stay one tap deep: "now" is the common answer, and a dozen hours
  // permanently on screen would bury it.
  const earlier = page.getByTestId("food-eating-earlier");
  await expect(earlier).toHaveAttribute("aria-expanded", "false");
  await hydratedClick(page, earlier);
  await expect(earlier).toHaveAttribute("aria-expanded", "true");

  // Every offered hour is one the write will accept — the server filtered them to hours
  // that land on the day being logged to, so nothing on screen can be refused.
  const hourChips = page.locator('[data-testid^="food-eating-at-"]');
  const newestHour = hourChips.first(); // first-ok: the newest offered hour is the one this test states, and the chips are this page's own eating-time group
  await expect(newestHour).toBeVisible();
  // The chip announces the FILING, not just the hour (#2269): `19:00 · Evening` —
  // the #2268 correction-sheet enrichment worn at log time.
  const chipText = (await newestHour.textContent())!.trim();
  expect(chipText).toMatch(
    /^([01]\d|2[0-3]):[0-5]\d · (Morning|Midday|Evening)$/
  );
  const hhmm = chipText.split("·")[0].trim();
  await hydratedClick(page, newestHour);
  await expect(earlier).toHaveText(chipText);
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
  await expect(page.getByTestId(`food-logged-${eventId}`)).toBeVisible();
  expect(stamped.eaten_at).not.toBeNull();
  expect(new Date(stamped.eaten_at!).getTime()).toBeLessThan(
    frozenNow().getTime()
  );
  // AND THE ROW STATES IT (#2206). The web half of "a surface must not go on showing the
  // time a statement replaced": the logged list names this serving by the hour that was
  // chosen, not by the moment the "+" was pressed. Both surfaces are absolute, so the
  // chip's own label is what the row ends up reading.
  await expect(page.getByTestId(`food-logged-${eventId}`)).toContainText(hhmm);

  await removeLoggedServing(page, eventId);
});

test("a stated time wins over the tab: the serving lands, visibly, in its derived section (#2269)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // State the newest offered hour and read the filing its chip announces.
  await hydratedClick(page, page.getByTestId("food-eating-earlier"));
  const newestHour = page.locator('[data-testid^="food-eating-at-"]').first(); // first-ok: the newest offered hour is the one this test states, and the chips are this page's own eating-time group
  await expect(newestHour).toBeVisible();
  const filingSlot = (await newestHour.getAttribute("data-slot"))!;
  expect(["Morning", "Midday", "Evening"]).toContain(filingSlot);
  await hydratedClick(page, newestHour);

  // Stand in a DIFFERENT tab than the one the hour files under. The tab is
  // navigation; the chip stated the consequence.
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

  const filingTotal = page.getByTestId(
    `food-slot-total-${filingSlot.toLowerCase()}`
  );
  const tabTotal = page.getByTestId(
    `food-slot-total-${otherTab.toLowerCase()}`
  );
  const filingBefore = Number((await filingTotal.textContent())!.trim());
  const tabBefore = Number((await tabTotal.textContent())!.trim());

  await revealFoodGroup(page, "nuts_seeds");
  const before = await loggedListIds(page);
  // The DERIVED section's total ticks on the tap itself — the optimistic update
  // places the serving where the chip said it would land, not in the cell being
  // looked at. Asserted right after the click, before the action settles.
  await page.getByTestId("log-nuts_seeds").click();
  await expect(filingTotal).toHaveText(String(filingBefore + 1));
  await expect(tabTotal).toHaveText(String(tabBefore));

  // Settled: the server files it under the same derived meal (no meal_slot echo was
  // stored — the row's window comes from the stated instant).
  await expect(loggedListRows(page)).toHaveCount(before.length + 1);
  const eventId = await newlyLoggedId(page, before);
  await expect(page.getByTestId(`food-logged-${eventId}`)).toHaveAttribute(
    "data-slot",
    filingSlot
  );
  await expect(filingTotal).toHaveText(String(filingBefore + 1));
  await expect(tabTotal).toHaveText(String(tabBefore));

  await removeLoggedServing(page, eventId);
});

test("the eating-time chips are a today-only affordance (#2053)", async ({
  page,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await expect(page.getByTestId("food-eating-time")).toBeVisible();

  // "Now" is meaningless on a backfill, and a seven-day-old serving genuinely has no
  // stated eating time — which is exactly what the NULL default is for.
  await hydratedClick(page, page.getByTestId("food-day-yesterday"));
  await expect(page.getByTestId("food-eating-time")).toHaveCount(0);

  await hydratedClick(page, page.getByTestId("food-day-today"));
  await expect(page.getByTestId("food-eating-time")).toBeVisible();
});
