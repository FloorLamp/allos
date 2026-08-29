import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";
import { hydratedClick } from "./helpers";
import { utcInstant, zonedWallTimeToUtc } from "../lib/date";
import { TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";

// THE COMPACT LOGGED-EVENT ROW (#3671).
//
// One logged fact used to cost four lines and ~130px on a phone — a date, then
// "AMOUNT 3 g", then "TIME 1:46am" — so two entries filled the screen, while the
// same app's food log fitted seven of the same kind of fact in the same space. The
// owner asked for the food log's row everywhere. It is now one primitive
// (components/LoggedEventRow.tsx) rendered by BOTH, and below `sm` the ledger row
// is that line with its labelled detail one tap away.
//
// WHAT IS ASSERTED, AND WHY IT IS GEOMETRY AND VISIBILITY RATHER THAN CLASSES. The
// defect was a rendered box — a row's height, and a fold that put a door below it —
// so the claims are read from `getBoundingClientRect()` and from `:visible`, not
// from class strings. `textContent` is deliberately NOT the instrument for the
// disclosure: a collapsed detail cell is `display:none` and its text is still in
// `textContent`, so `not.toContainText` would pass over a row that discloses
// nothing and over one that discloses everything alike.
//
// FIXTURE OWNERSHIP: this spec owns one supplement, one dose and one serving, all
// name- or day-addressed, and deletes them before each test (idempotent, so a
// failed run leaves no residue). Instants are built with `zonedWallTimeToUtc` on
// the profile's own zone — the ledgers group by the profile-LOCAL day and the seed
// pins a rotating per-run zone (#1417/#3878), so a naive string would be right only
// for the zone a given run's start hour happened to draw.

const PROFILE = 1;
// A day well inside the ledgers' reach, addressed explicitly in every URL so this
// never depends on a default window.
const DAY = "2026-08-18";
const ITEM = "E2e Row Magnesium";
const ITEM_AMOUNT = "3 g";
// THE STACK DAY (#3937). Two items dosed in the SAME MINUTE is the shape the ledger
// was unreadable in — under the old slotting both rows read "Tuesday, August 18 ·
// 8:46am" and both ⋯ announced those same words.
const ITEM_TWO = "E2e Row Zinc";
const ITEM_TWO_AMOUNT = "15 mg";
// The trailing-less consumer (#3904): two columns, and the second is the person's
// own prose.
const PRACTICE = "E2e Row Breathwork";
const PRACTICE_NOTE = "Felt steadier by the end";
// The serving's group key and the name the app renders for it. TWO of them, on one
// day and one minute: the food ledger is a cross-ITEM ledger too, so it carries the
// same identity question as the dose ledger (#3937).
const FOOD_GROUP = "berries";
const FOOD_NAME = "Berries";
const FOOD_GROUP_TWO = "leafy_greens";
const FOOD_NAME_TWO = "Leafy greens";

// THE COMPACT ROW IS ONE LINE, and this bounds its HEIGHT IN CSS PIXELS at 430px.
// Measured 2026-08-27: 56px on the dose ledger, 57px on the food ledger, on a
// practice session and on a substance day, 52px on the food log's own list. None of
// those is the `min-h-11` floor — what sets the height is the row's ⋯ trigger (40px)
// inside the row's own vertical padding, and the floor is what stops a row WITHOUT
// one going under 44. A row that gained a second 20px line would read 76px or more,
// so the ceiling sits between: the tap floor plus one line of slack, which tolerates
// a font-metric change and still catches a wrapped row.
const COMPACT_ROW_CEILING_PX = TAP_FLOOR_PX + 20;

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

function profileTimezone(db: Database.Database): string {
  const row = db
    .prepare(
      `SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'`
    )
    .get(PROFILE) as { value: string } | undefined;
  return row?.value || "UTC";
}

/** An instant whose PROFILE-LOCAL wall time is the one the assertions name. */
function localInstant(db: Database.Database, hhmm: string): string {
  const at = zonedWallTimeToUtc(profileTimezone(db), DAY, hhmm);
  expect(
    at,
    "the fixture clock must resolve in the profile's zone"
  ).not.toBeNull();
  return utcInstant(at!);
}

function deleteFixtureRows(db: Database.Database): void {
  db.prepare(
    `DELETE FROM intake_item_logs WHERE item_id IN
       (SELECT id FROM intake_items WHERE profile_id = ? AND name = ?)`
  ).run(PROFILE, ITEM);
  db.prepare(
    `DELETE FROM intake_item_doses WHERE item_id IN
       (SELECT id FROM intake_items WHERE profile_id = ? AND name = ?)`
  ).run(PROFILE, ITEM);
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
    PROFILE,
    ITEM
  );
  db.prepare(
    `DELETE FROM food_log_events WHERE profile_id = ? AND date = ? AND group_key IN (?, ?)`
  ).run(PROFILE, DAY, FOOD_GROUP, FOOD_GROUP_TWO);
  db.prepare(
    `DELETE FROM practice_logs WHERE profile_id = ? AND practice = ?`
  ).run(PROFILE, PRACTICE);
}

/** One supplement, with a dose logged at each of `hhmm` on DAY. */
function seedItem(
  db: Database.Database,
  name: string,
  amount: string,
  ...hhmm: string[]
): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
           VALUES (?, ?, 1, 'supplement', 'daily', 'may')`
      )
      .run(PROFILE, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, ?, 'anytime', 'any', 0)`
      )
      .run(itemId, amount).lastInsertRowid
  );
  const log = db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, occurred_at, status, amount)
       VALUES (?, ?, ?, ?, 'taken', ?)`
  );
  for (const at of hhmm)
    log.run(doseId, itemId, DAY, localInstant(db, at), amount);
}

function seedDose(): void {
  const db = openDb();
  try {
    deleteFixtureRows(db);
    seedItem(db, ITEM, ITEM_AMOUNT, "08:46");
  } finally {
    db.close();
  }
}

/**
 * The stack day, built so BOTH ways two rows can collide are present at once: two
 * different items in the same minute (which only the item tells apart), and the same
 * item twice on one day (which only the clock tells apart).
 */
function seedStackDay(): void {
  const db = openDb();
  try {
    deleteFixtureRows(db);
    seedItem(db, ITEM, ITEM_AMOUNT, "08:46", "12:10");
    seedItem(db, ITEM_TWO, ITEM_TWO_AMOUNT, "08:46");
  } finally {
    db.close();
  }
}

function seedPracticeSession(): void {
  const db = openDb();
  try {
    deleteFixtureRows(db);
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, time, duration_min, notes)
       VALUES (?, ?, ?, '07:15', 20, ?)`
    ).run(PROFILE, PRACTICE, DAY, PRACTICE_NOTE);
  } finally {
    db.close();
  }
}

function seedServing(): void {
  const db = openDb();
  try {
    deleteFixtureRows(db);
    const at = localInstant(db, "08:46");
    const insert = db.prepare(
      `INSERT INTO food_log_events
         (profile_id, group_key, date, meal_slot, recorded_at, occurred_at)
       VALUES (?, ?, ?, 'Morning', ?, ?)`
    );
    insert.run(PROFILE, FOOD_GROUP, DAY, at, at);
    insert.run(PROFILE, FOOD_GROUP_TWO, DAY, at, at);
  } finally {
    db.close();
  }
}

/** The detail a row keeps BEHIND its compact line, and only what is on screen. */
function visibleDetail(row: Locator): Locator {
  return row.locator(':is([data-card="value"], [data-card="meta"]):visible');
}

async function height(target: Locator): Promise<number> {
  const box = await target.boundingBox();
  expect(box, "the row did not render a box").not.toBeNull();
  return box!.height;
}

async function phone(page: Page): Promise<void> {
  // 430px — the width the owner's report and this issue's acceptance criteria name.
  await page.setViewportSize({ width: 430, height: 932 });
}

test.beforeEach(() => {
  const db = openDb();
  try {
    deleteFixtureRows(db);
  } finally {
    db.close();
  }
});

test.describe("the compact logged-event row at 430px (#3671)", () => {
  test("a logged dose is one row, and tapping it discloses exactly the detail the card showed", async ({
    page,
  }) => {
    seedDose();
    await phone(page);
    await page.goto(`/nutrition/dose-history?from=${DAY}&to=${DAY}&kind=all`);

    const row = page.getByTestId("dose-ledger-row").filter({ hasText: ITEM });
    await expect(row).toHaveCount(1);

    // ONE ROW, at the tap floor and not under it (#644).
    const collapsed = await height(row);
    expect(
      collapsed,
      `the collapsed dose row is ${collapsed}px tall at 430px`
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    expect(collapsed).toBeLessThanOrEqual(COMPACT_ROW_CEILING_PX);

    // Collapsed, the labelled detail is not on screen — but the row's IDENTITY is,
    // and identity at ledger scope is the ITEM (#3937). Asserted as the title cell's
    // whole text, not as a substring of the row: the item name is also inside the ⋯
    // trigger's accessible name and inside the disclosed amount cell's neighbourhood,
    // so `row.toContainText(ITEM)` would pass on the very tree this replaced.
    await expect(visibleDetail(row)).toHaveCount(0);
    const title = row.locator('[data-card="title"]');
    await expect(title).toBeVisible();
    await expect(title).toHaveText(ITEM);

    // Beside it, WHEN — one cell, short date and clock, because a multi-day list that
    // shows only a clock leaves every row's day unnamed.
    const when = row.locator('[data-card="trailing"]');
    await expect(when).toBeVisible();
    const whenText = (await when.textContent())?.trim() ?? "";
    // `^Tue,` and not `Tuesday,`: the dense-row formatter, which is also what stops
    // the desktop column wrapping (asserted at 1280px below).
    expect(whenText, "the head line's when-cell").toMatch(/^Tue,/);
    expect(whenText).toMatch(/·\s*\d{1,2}:\d{2}/);

    // THE DISCLOSURE IS A CONTROL, not a row-wide click handler: it says what it
    // does and it says whether it is open.
    const toggle = row.getByRole("button", { name: "Show details" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await hydratedClick(page, toggle);

    // Expanded: the labelled detail, which is now the amount alone. The item left
    // the disclosure when it became the head line — a fact the row states once.
    const detail = visibleDetail(row);
    await expect(detail).toHaveCount(1);
    await expect(detail).toContainText(ITEM_AMOUNT);
    const opened = row.getByRole("button", { name: "Hide details" });
    await expect(opened).toHaveAttribute("aria-expanded", "true");
    expect(await height(row)).toBeGreaterThan(collapsed);

    // The row keeps its ⋯ throughout: disclosure is not a detour on the way to an
    // edit.
    await expect(
      row.getByRole("button", { name: /Dose actions/ })
    ).toBeVisible();

    // COLLAPSING RESTORES THE ROW, to the same box it started in.
    await hydratedClick(page, opened);
    await expect(visibleDetail(row)).toHaveCount(0);
    expect(await height(row)).toBe(collapsed);
  });

  test("the in-card dose history panel collapses and discloses the same way", async ({
    page,
  }) => {
    seedDose();
    await phone(page);
    await page.goto("/nutrition?tab=supplements");

    // The fixture item carries no scheduled time of day, so the supplements tab
    // files it under "More supplements" — a closed <details>. Opening it is the
    // route to the panel, and it keeps the fixture this spec's own rather than
    // borrowing a seeded supplement whose dose count nothing here controls.
    await hydratedClick(
      page,
      page.locator('[data-testid="not-scheduled-section"] summary')
    );
    const card = page
      .locator('[data-testid="supplement-row"]')
      .filter({ hasText: ITEM });
    await expect(card).toHaveCount(1);
    await hydratedClick(
      page,
      card.getByRole("button", { name: `Supplement actions for ${ITEM}` })
    );
    await hydratedClick(
      page,
      page.getByRole("menuitem", { name: "Dose history" })
    );

    const row = card.getByTestId("dose-history-row");
    await expect(row).toHaveCount(1);
    const collapsed = await height(row);
    expect(collapsed).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    expect(collapsed).toBeLessThanOrEqual(COMPACT_ROW_CEILING_PX);
    await expect(visibleDetail(row)).toHaveCount(0);

    await hydratedClick(
      page,
      row.getByRole("button", { name: "Show details" })
    );
    // The panel's only labelled detail is the amount; the date is the row's identity
    // and the clock is its trailing fact, so neither is behind the disclosure.
    await expect(visibleDetail(row)).toHaveCount(1);
    await expect(visibleDetail(row)).toContainText(ITEM_AMOUNT);

    await hydratedClick(
      page,
      row.getByRole("button", { name: "Hide details" })
    );
    await expect(visibleDetail(row)).toHaveCount(0);
    expect(await height(row)).toBe(collapsed);
  });

  test("the food log and the food ledger render the same row primitive, divider-separated", async ({
    page,
  }) => {
    seedServing();
    await phone(page);

    // ── The food log's own "Logged <day>" list ──────────────────────────────────
    await page.goto(`/nutrition?date=${DAY}`);
    const logRow = page
      .getByTestId("food-logged-list")
      .locator("li[data-group]")
      .first(); // first-ok: the anatomy claim is about any row of the list, not a chosen one
    await expect(logRow).toBeVisible();
    await expect(logRow.locator("[data-logged-event-row]")).toHaveCount(1);

    // DIVIDERS, NOT PER-ROW CARDS: the frame is the LIST's, the hairline is the
    // row's, and the row itself has neither a corner nor a fill of its own.
    const listChrome = await logRow.evaluate((el) => {
      const row = getComputedStyle(el);
      const list = getComputedStyle(el.parentElement!);
      return {
        rowRadius: row.borderTopLeftRadius,
        rowBackground: row.backgroundColor,
        rowDivider: row.borderTopWidth,
        listRadius: list.borderTopLeftRadius,
        listBorder: list.borderTopWidth,
      };
    });
    expect(listChrome.rowRadius).toBe("0px");
    expect(listChrome.rowBackground).toBe("rgba(0, 0, 0, 0)");
    expect(listChrome.listBorder).toBe("1px");
    expect(listChrome.listRadius).not.toBe("0px");

    // ── The same fact on the ledger, through the same component ────────────────
    await page.goto(`/nutrition/food-history?from=${DAY}&to=${DAY}`);
    const ledgerRow = page
      .getByTestId("food-ledger-row")
      .filter({ hasText: FOOD_NAME });
    await expect(ledgerRow).toHaveCount(1);
    await expect(ledgerRow.locator("[data-logged-event-row]")).toHaveCount(1);

    const rowChrome = await ledgerRow.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        radius: cs.borderTopLeftRadius,
        background: cs.backgroundColor,
        divider: cs.borderBottomWidth,
      };
    });
    expect(rowChrome.radius).toBe("0px");
    expect(rowChrome.background).toBe("rgba(0, 0, 0, 0)");
    expect(rowChrome.divider).toBe("1px");

    const collapsed = await height(ledgerRow);
    expect(collapsed).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    expect(collapsed).toBeLessThanOrEqual(COMPACT_ROW_CEILING_PX);
    await expect(visibleDetail(ledgerRow)).toHaveCount(0);

    // ── AND IT IS A CROSS-ITEM LEDGER, SO IDENTITY IS THE FOOD (#3937) ─────────
    //
    // The third consumer with the same defect, re-slotted in the same change so the
    // three ledgers #3958 inherits speak one grammar rather than two.
    const greens = page
      .getByTestId("food-ledger-row")
      .filter({ hasText: FOOD_NAME_TWO });
    await expect(greens).toHaveCount(1);

    const whenOf = (row: Locator) =>
      row
        .locator('[data-card="trailing"]')
        .textContent()
        .then((t) => (t ?? "").trim());

    // THE PREMISE. Both servings were logged in the same minute of the same day, so
    // the when-cell cannot be what tells these two rows apart.
    expect(
      await whenOf(ledgerRow),
      "the two seeded servings no longer share a minute"
    ).toBe(await whenOf(greens));

    // THE HEAD LINE TELLS THEM APART, with no tap, and carries the day beside the
    // clock rather than a clock on an unnamed day.
    await expect(ledgerRow.locator('[data-card="title"]')).toHaveText(
      FOOD_NAME
    );
    await expect(greens.locator('[data-card="title"]')).toHaveText(
      FOOD_NAME_TWO
    );
    expect(await whenOf(ledgerRow)).toMatch(/^Tue,.*·/);

    // AND SO DO THEIR CONTROLS.
    const nameOf = (row: Locator) =>
      row
        .getByRole("button", { name: /Serving actions/ })
        .getAttribute("aria-label")
        .then((n) => n ?? "");
    const [berriesName, greensName] = [
      await nameOf(ledgerRow),
      await nameOf(greens),
    ];
    expect(berriesName).toContain(FOOD_NAME);
    expect(greensName).toContain(FOOD_NAME_TWO);
    expect(berriesName, `both ⋯ announced "${berriesName}"`).not.toBe(
      greensName
    );
    // AND THE NAME CARRIES THE WHOLE WHEN-CELL, not just its date — two servings of
    // one food on one day are told apart only by the clock. That pair lives in the
    // dose ledger's fixture above, where this same spelling is proven able to fail;
    // here the claim is made against the cell the reader is looking at, so the two
    // ledgers cannot drift to two spellings.
    expect(berriesName).toContain(await whenOf(ledgerRow));
  });

  test("the compact row is the five EntryHistoryTable surfaces' and nobody else's", async ({
    page,
  }) => {
    seedDose();
    await phone(page);

    // ONE OF THE FIVE: the ledger's rows carry the compact contract.
    await page.goto(`/nutrition/dose-history?from=${DAY}&to=${DAY}&kind=all`);
    const ledgerRow = page
      .getByTestId("dose-ledger-row")
      .filter({ hasText: ITEM });
    await expect(ledgerRow).toHaveCount(1);
    await expect(
      page.locator("table.logged-event-rows").filter({ has: ledgerRow })
    ).toHaveCount(1);
    await expect(visibleDetail(ledgerRow)).toHaveCount(0);

    // ONE OF THE OTHER TEN: a metric's readings are a record with a multi-field
    // body, and #3671 deliberately left them alone — same `.table-cards` card mode
    // as before, meta cells on screen with no disclosure to open first.
    await page.goto("/trends/metric/weight");
    const readings = page.locator("table.table-cards").first(); // first-ok: the readings list is this route's only card-mode table
    await expect(readings).toBeVisible();
    await expect(readings).not.toHaveClass(/logged-event-rows/);
    expect(
      await readings.locator('[data-card="meta"]:visible').count()
    ).toBeGreaterThan(0);
  });

  test("a stack day's rows are told apart without a tap, and no two ⋯ say the same words", async ({
    page,
  }) => {
    seedStackDay();
    await phone(page);
    await page.goto(`/nutrition/dose-history?from=${DAY}&to=${DAY}&kind=all`);

    // SCOPED TO THIS SPEC'S OWN ROWS. The shared seed logs its own doses on this day,
    // and a claim about "every row" would be a claim about a fixture nothing here
    // controls.
    const magnesium = page
      .getByTestId("dose-ledger-row")
      .filter({ hasText: ITEM });
    const zinc = page
      .getByTestId("dose-ledger-row")
      .filter({ hasText: ITEM_TWO });
    await expect(magnesium).toHaveCount(2);
    await expect(zinc).toHaveCount(1);

    const whens = await magnesium
      .locator('[data-card="trailing"]')
      .allTextContents()
      .then((all) => all.map((t) => t.trim()));
    const zincWhen = (
      (await zinc.locator('[data-card="trailing"]').textContent()) ?? ""
    ).trim();

    // THE PREMISES, BOTH OF THEM, BEFORE THE VERDICT — because there are two ways a
    // pair of rows can collide and the fix has to answer both.
    //
    // ONE: a dose of each item written in the same minute, which only the ITEM tells
    // apart. Under the old slotting these two head lines were the same string.
    expect(
      whens,
      "no seeded dose shares a minute with the second item any more"
    ).toContain(zincWhen);
    // TWO: the same item twice on one day, which only the CLOCK tells apart. This is
    // the pair #3937's literal "item — date" spelling would have left colliding.
    const dayOf = (when: string) => when.split("·")[0].trim();
    expect(dayOf(whens[0])).toBe(dayOf(whens[1]));
    expect(whens[0], "the two doses of one item share a clock").not.toBe(
      whens[1]
    );

    // THE HEAD LINE TELLS THE ITEMS APART, with no tap.
    await expect(zinc.locator('[data-card="title"]')).toHaveText(ITEM_TWO);
    expect(
      await magnesium.locator('[data-card="title"]').allTextContents()
    ).toEqual([ITEM, ITEM]);

    // AND EVERY ⋯ ANNOUNCES A DIFFERENT ROW (#2615). A sheet detaches from the row it
    // came from, so two identical names are two rows a reader cannot tell apart once
    // it opens. Three rows, three names — the count is the assertion, because a pair
    // that collided would still satisfy "each name contains its item".
    const names = await page
      .getByTestId("dose-ledger-row")
      .filter({ hasText: /E2e Row (Magnesium|Zinc)/ })
      .getByRole("button", { name: /Dose actions/ })
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("aria-label") ?? "")
      );
    expect(names).toHaveLength(3);
    expect(new Set(names).size, `the ⋯ names were ${names.join(" | ")}`).toBe(
      3
    );
    expect(names.filter((n) => n.includes(ITEM_TWO))).toHaveLength(1);
  });

  test("the practice history has no trailing fact, so its note is never collapsed away", async ({
    page,
  }) => {
    seedPracticeSession();
    await phone(page);
    await page.goto(`/wellness/practice-history?from=${DAY}&to=${DAY}`);

    const row = page
      .locator("table.logged-event-rows tbody tr")
      .filter({ hasText: PRACTICE });
    await expect(row).toHaveCount(1);

    // THE NOTE IS ON SCREEN WITH NO TAP. Two columns and the second is the person's
    // own prose: the collapse had nothing to leave on the head line and spent the
    // only content the row carried (#3904). Asserted as a COUNT of visible detail
    // cells plus the note's exact text — `toContainText` on the row would pass while
    // the cell is `display:none`, because textContent does not care.
    const note = row.locator('[data-card="meta"]:visible');
    await expect(note).toHaveCount(1);
    await expect(note).toHaveText(PRACTICE_NOTE);

    // AND NO CONTROL OPENS ONTO IT, because there is nothing behind the line.
    await expect(row.getByRole("button", { name: /details$/ })).toHaveCount(0);

    // THE NOTE KEEPS ITS OWN DENSITY, the one `practice-session-list` declared before
    // it was absorbed: one step above the shared meta's `text-xs`. In CSS pixels at
    // the app's 16px root, `text-sm` is 14 and `text-xs` is 12, so the equality is
    // what distinguishes the restored density from the inherited one.
    expect(
      await note.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    ).toBe(14);

    // The row meets the tap floor and fits inside the phone — at THIS file's 430px
    // and again at 390, the narrowest width the density work measures, because the
    // note is now on screen at every width and a two-line row is where an overflow
    // would first show.
    for (const width of [430, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(note).toHaveCount(1);
      const box = await row.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height, `the row at ${width}px`).toBeGreaterThanOrEqual(
        TAP_FLOOR_PX
      );
      expect(Math.round(box!.x + box!.width)).toBeLessThanOrEqual(width);
    }
  });

  // ── THE OTHER SIDE OF THE BOUNDARY ────────────────────────────────────────────
  //
  // "Desktop tables are unchanged" is the invariant a compact-row change is most
  // likely to break WITHOUT any spec noticing, because every desktop spec here
  // addresses text and the change is presentational. It nearly did: the shared
  // primitive's identity span carried `font-medium`, and two of the five ledgers
  // set no weight on their desktop title column, so those two would have rendered
  // bold at every width with nothing red. So this asserts the two properties the
  // phone work could leak upward — the disclosure and the weight — above `sm`.
  test("above the boundary the ledger is still a table: no disclosure, no borrowed weight", async ({
    page,
  }) => {
    seedDose();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/nutrition/dose-history?from=${DAY}&to=${DAY}&kind=all`);

    const row = page.getByTestId("dose-ledger-row").filter({ hasText: ITEM });
    await expect(row).toHaveCount(1);
    // Every cell is a column again: nothing is behind a toggle, and no toggle is
    // rendered to be behind. ONE value, since the item became the identity column.
    await expect(row.locator('[data-card="value"]:visible')).toHaveCount(1);

    // THE WHEN COLUMN DOES NOT WRAP (#3937 rider). The long shape ("Tuesday, August
    // 18") drew into a column narrow enough that every row read "Tuesday, August /
    // 18" — ten identical two-line dates in the report that prompted this.
    //
    // THREE READINGS, BECAUSE ONE OF THEM IS FIXTURE-DEPENDENT AND SAYS SO. The
    // rendered line count is the thing a reader sees, but it is only decisive at a
    // column width, and this spec runs on the SHARED profile, where the 55-character
    // imported name that squeezes the column may not be seeded (that name is the
    // dedicated fixture's, e2e/dose-ledger-phone.mobile.spec.ts, deliberately kept
    // off profile 1 so it does not widen every neighbour's controls). What holds at
    // ANY column width is the other two: the dense short shape, and `nowrap`. All
    // three fail on the pre-fix cell — measured, this file's own mutation round.
    const desktopWhen = await row
      .locator('[data-card="trailing"]')
      .evaluate((cell) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        return {
          text: (cell.textContent ?? "").trim(),
          lines: range.getClientRects().length,
          whiteSpace: getComputedStyle(cell).whiteSpace,
        };
      });
    expect(desktopWhen.text, "the desktop When cell").toMatch(/^Tue,/);
    expect(desktopWhen.whiteSpace).toBe("nowrap");
    expect(desktopWhen.lines, `"${desktopWhen.text}" wrapped`).toBe(1);
    await expect(row.getByRole("button", { name: /details$/ })).toHaveCount(0);
    await expect(row.locator("thead")).toHaveCount(0);
    // The card-mode column labels stay card-mode-only.
    await expect(row.locator(".card-cell-label:visible")).toHaveCount(0);

    // THE WEIGHT IS THE COLUMN'S, not the primitive's. A substance day's Date
    // column declares none, so it must still resolve to the document default.
    await page.goto("/records/specialty/substance-use");
    const title = page
      .locator('table.logged-event-rows td[data-card="title"]')
      .first(); // first-ok: every row of every substance card takes the same column classes
    await expect(title).toBeVisible();
    expect(await title.evaluate((el) => getComputedStyle(el).fontWeight)).toBe(
      "400"
    );
    expect(
      await title.evaluate(
        (el) =>
          getComputedStyle(el.querySelector("[data-logged-event-row] span")!)
            .fontWeight
      )
    ).toBe("400");
  });

  test("both intake surfaces open their ledger from the day header, in one shape", async ({
    page,
  }) => {
    await phone(page);

    // SUPPLEMENTS: the door used to sit in a desktop rail that stacks to the very
    // BOTTOM of this page below `lg` — present in the DOM, unreachable in practice,
    // which is what the owner reported as a missing link. It sits in the day header
    // now, so the claim is POSITIONAL and is asserted that way: the door is above
    // every supplement row it is a door to, and above where the rail begins.
    //
    // WHY NOT "inside the first 932px". Measured 2026-08-27 at 430px on the e2e
    // seed: this page renders ~1500px of intake findings (ul-warnings,
    // rda-adequacy, demotion-suggestions, interaction warnings) before the schedule
    // begins at y=1619, so nothing in the schedule is inside the first viewport for
    // this profile whatever the door does. The move is still the whole fix —
    // y=3253 in the rail, y=1639 in the day header — and a viewport-absolute
    // assertion would be a claim about the FINDINGS stack, which #3671 does not
    // touch.
    await page.goto("/nutrition?tab=supplements");
    const doseDoor = page.getByTestId("dose-ledger-link");
    await expect(doseDoor).toBeVisible();
    const geometry = await page.evaluate(() => {
      const top = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return el.getBoundingClientRect().top + window.scrollY;
      };
      const rect = document
        .querySelector('[data-testid="dose-ledger-link"]')!
        .getBoundingClientRect();
      return {
        doorBottom: rect.top + window.scrollY + rect.height,
        firstRow: top('[data-testid="supplement-row"]'),
        rail: top('[data-testid="supplement-sidebar"]'),
      };
    });
    expect(
      geometry.firstRow,
      "the supplements page rendered no rows for the door to be a door to"
    ).not.toBeNull();
    expect(
      geometry.doorBottom,
      `the ledger door's bottom is at ${Math.round(geometry.doorBottom)}px, the ` +
        `first supplement row at ${geometry.firstRow}px`
    ).toBeLessThan(geometry.firstRow!);
    expect(geometry.doorBottom).toBeLessThan(geometry.rail!);
    const doseShape = await doseDoor.getAttribute("class");

    // FOOD: the same door, not a bare text link in a row of its own.
    await page.goto("/nutrition");
    const foodDoor = page.getByTestId("food-ledger-link");
    await expect(foodDoor).toBeVisible();
    expect(await foodDoor.getAttribute("class")).toBe(doseShape);
    // Icon plus real text plus the destination indicator — never icon-only.
    await expect(foodDoor).toContainText("Food history");
    expect(await foodDoor.locator("svg").count()).toBeGreaterThanOrEqual(2);
  });
});
