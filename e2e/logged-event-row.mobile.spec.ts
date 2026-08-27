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
// The serving's group key and the name the app renders for it.
const FOOD_GROUP = "berries";
const FOOD_NAME = "Berries";

// The compact row is ONE line. Measured 2026-08-27 at 430px: 44px on every one of
// the five consumers, which is `min-h-11` — the row's content (a 15px title beside
// a 12px clock, `py-2`) asks for less, so the floor is what sets the height. The
// ceiling is the floor plus one 20px line of slack: a row that gained a second line
// reads 64px or more, and this catches it while tolerating a font-metric change.
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
    `DELETE FROM food_log_events WHERE profile_id = ? AND date = ? AND group_key = ?`
  ).run(PROFILE, DAY, FOOD_GROUP);
}

function seedDose(): void {
  const db = openDb();
  try {
    deleteFixtureRows(db);
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
           VALUES (?, ?, 1, 'supplement', 'daily', 'may')`
        )
        .run(PROFILE, ITEM).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, ?, 'anytime', 'any', 0)`
        )
        .run(itemId, ITEM_AMOUNT).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, occurred_at, status, amount)
       VALUES (?, ?, ?, ?, 'taken', ?)`
    ).run(doseId, itemId, DAY, localInstant(db, "08:46"), ITEM_AMOUNT);
  } finally {
    db.close();
  }
}

function seedServing(): void {
  const db = openDb();
  try {
    deleteFixtureRows(db);
    const at = localInstant(db, "08:46");
    db.prepare(
      `INSERT INTO food_log_events
         (profile_id, group_key, date, meal_slot, recorded_at, occurred_at)
       VALUES (?, ?, ?, 'Morning', ?, ?)`
    ).run(PROFILE, FOOD_GROUP, DAY, at, at);
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

    // Collapsed, the labelled detail is not on screen — but the trailing clock is,
    // which is what makes the row scannable rather than merely short.
    await expect(visibleDetail(row)).toHaveCount(0);
    await expect(row.locator('[data-card="trailing"]')).toBeVisible();

    // THE DISCLOSURE IS A CONTROL, not a row-wide click handler: it says what it
    // does and it says whether it is open.
    const toggle = row.getByRole("button", { name: "Show details" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await hydratedClick(page, toggle);

    // Expanded: exactly what the card carried — the item and the amount, each with
    // the label the hidden column header would have given it.
    const detail = visibleDetail(row);
    await expect(detail).toHaveCount(2);
    await expect(detail.filter({ hasText: ITEM })).toHaveCount(1);
    await expect(detail.filter({ hasText: ITEM_AMOUNT })).toHaveCount(1);
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

    const card = page.locator("div.card").filter({ hasText: ITEM }).first(); // first-ok: this spec owns the only supplement named ITEM; the filter is the identity
    await hydratedClick(
      page,
      card.getByRole("button", { name: /Supplement actions/ })
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

  test("both intake surfaces open their ledger from the day header, in one shape", async ({
    page,
  }) => {
    await phone(page);

    // SUPPLEMENTS: the door used to sit in a desktop rail that stacks to the bottom
    // of this page below `lg` — present in the DOM, unreachable in practice. It is
    // above the fold now, which is the claim, so it is measured against the
    // viewport rather than asserted as visibility.
    await page.goto("/nutrition?tab=supplements");
    const doseDoor = page.getByTestId("dose-ledger-link");
    await expect(doseDoor).toBeVisible();
    const doseBox = await doseDoor.boundingBox();
    expect(
      doseBox,
      "the supplements ledger door did not render"
    ).not.toBeNull();
    expect(
      doseBox!.y + doseBox!.height,
      `the supplements ledger door's bottom edge is at ${Math.round(
        doseBox!.y + doseBox!.height
      )}px in a 932px viewport`
    ).toBeLessThanOrEqual(932);
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
