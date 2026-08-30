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
      `INSERT INTO practice_logs (profile_id, practice, date, start_time, duration_min, notes)
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
  // THE CROSS-ITEM DOSE LEDGER'S DISCLOSURE CASE LEFT WITH ITS SURFACE (#3958). That
  // ledger folded into `/history`, whose rows are ONE LINE AT EVERY VIEWPORT by owner
  // ruling — a deliberate exception to the compact-card default, argued from what a
  // record is for — so there is no collapse there to assert. The identical claim on a
  // SURVIVING EntryHistoryTable consumer is the next test: the in-card dose panel,
  // which is the same component at item scope and still discloses on tap.

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

  test("the food log and the record render the same row primitive, divider-separated", async ({
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
    //
    // THE READ IS POLLED, AND ONLY THE READ. `getComputedStyle` on a node that is not
    // in a rendered document answers an EMPTY declaration rather than throwing, so
    // every field below comes back `""` — and a bare `evaluate` asserts whatever that
    // instant returned. This list is client-rendered, so the row Playwright resolves
    // can be mid-remount when the callback runs, and `""` is then compared against
    // `"0px"` and reported as a wrong corner radius. Seen in CI on 2026-08-30
    // (`e2e (4)`): `Expected: "0px" / Received: ""`, on a branch that renders nothing
    // on this page, irreproducible in 28 local runs across two trees.
    //
    // Waiting for a non-empty read cannot invent a measurement: a row that genuinely
    // carried a corner would answer with that corner, and a list that never rendered
    // would time out with `""` and say so. So the four claims below stay exactly as
    // they were and do NOT retry — what retries is the act of measuring.
    type ListChrome = {
      rowRadius: string;
      rowBackground: string;
      rowDivider: string;
      listRadius: string;
      listBorder: string;
    };
    let listChrome: ListChrome | null = null;
    await expect
      .poll(
        async () => {
          listChrome = await logRow.evaluate((el) => {
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
          return listChrome.rowRadius;
        },
        {
          message:
            "the row's computed style never became readable — the node stayed detached",
        }
      )
      .not.toBe("");
    const chrome = listChrome as unknown as ListChrome;
    expect(chrome.rowRadius).toBe("0px");
    expect(chrome.rowBackground).toBe("rgba(0, 0, 0, 0)");
    expect(chrome.listBorder).toBe("1px");
    expect(chrome.listRadius).not.toBe("0px");

    // ── THE SAME FACT ON THE RECORD, THROUGH THE SAME PRIMITIVE (#3958) ───────
    //
    // The food ledger route is gone; its rows are `/history`'s now. What has to
    // survive the move is the anatomy — the identity half is still
    // `LoggedEventRow` — and #3937's identity rule at cross-item scope, which is
    // what this half of the test was always for.
    await page.goto(`/history?kind=food&day=${DAY}`);
    const berries = page
      .getByTestId("history-row")
      .filter({ hasText: FOOD_NAME });
    await expect(berries).toHaveCount(1);
    await expect(berries.locator("[data-logged-event-row]")).toHaveCount(1);

    // ONE LINE, AT THIS VIEWPORT AND NOT ONLY ABOVE `sm`. The record's row does not
    // collapse, so there is nothing to open and nothing behind it: a control here
    // would be the disclosure the ruling took away.
    await expect(berries.getByRole("button", { name: /details$/ })).toHaveCount(
      0
    );
    const rowChrome = await berries.evaluate((el) => {
      const cs = getComputedStyle(el);
      const list = getComputedStyle(el.parentElement!);
      return {
        radius: cs.borderTopLeftRadius,
        background: cs.backgroundColor,
        divider: cs.borderTopWidth,
        listBorder: list.borderTopWidth,
        listRadius: list.borderTopLeftRadius,
      };
    });
    // DIVIDERS, NOT PER-ROW CARDS — the same row contract the food log above has.
    expect(rowChrome.radius).toBe("0px");
    expect(rowChrome.background).toBe("rgba(0, 0, 0, 0)");
    // THE FRAME AROUND THEM IS A BAND, NOT A CARD, and that is where the record and
    // the food log's list legitimately differ: below `sm` the record's fill is
    // full-bleed and flat (#3673/#3920 — it is one of the four swept surfaces), so it
    // has no corners to meet the viewport with. The food log's list is not swept and
    // keeps its rounded frame; asserting one shape for both would have made this test
    // a claim about which surfaces #3673 named.
    expect(rowChrome.listRadius).toBe("0px");

    // ── AND IT IS A CROSS-ITEM RECORD, SO IDENTITY IS THE FOOD (#3937) ─────────
    const greens = page
      .getByTestId("history-row")
      .filter({ hasText: FOOD_NAME_TWO });
    await expect(greens).toHaveCount(1);

    const titleOf = (row: Locator) =>
      row
        .getByTestId("history-row-title")
        .textContent()
        .then((t) => (t ?? "").trim());
    const clockOf = (row: Locator) =>
      row
        .getByTestId("history-row-clock")
        .textContent()
        .then((t) => (t ?? "").trim());

    // THE PREMISE. Both servings were logged in the same minute of the same day, so
    // the clock cannot be what tells these two rows apart.
    expect(
      await clockOf(berries),
      "the two seeded servings no longer share a minute"
    ).toBe(await clockOf(greens));

    // THE HEAD LINE TELLS THEM APART, with no tap.
    expect(await titleOf(berries)).toBe(FOOD_NAME);
    expect(await titleOf(greens)).toBe(FOOD_NAME_TWO);

    // AND SO DO THEIR CONTROLS (#2615): a sheet detaches from the row it came from,
    // so two identical names are two rows a reader cannot tell apart once it opens.
    const nameOf = (row: Locator) =>
      row
        .getByRole("button", { name: /Food actions/ })
        .getAttribute("aria-label")
        .then((n) => n ?? "");
    const [berriesName, greensName] = [
      await nameOf(berries),
      await nameOf(greens),
    ];
    expect(berriesName).toContain(FOOD_NAME);
    expect(greensName).toContain(FOOD_NAME_TWO);
    expect(berriesName, `both ⋯ announced "${berriesName}"`).not.toBe(
      greensName
    );
  });

  test("the compact row is the EntryHistoryTable surfaces' and nobody else's", async ({
    page,
  }) => {
    seedDose();
    await phone(page);

    // ONE OF THEM: the in-card dose panel's rows carry the compact contract. It was
    // the cross-item LEDGER here until #3958 deleted that route; the panel is the
    // same component at item scope, which is what makes it the honest stand-in.
    await page.goto("/nutrition?tab=supplements");
    // The fixture item carries no scheduled time of day, so the tab files it under
    // "More supplements" — a closed <details>, exactly as the panel test above.
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
    const panelRow = card.getByTestId("dose-history-row");
    await expect(panelRow).toHaveCount(1);
    // The row's OWN table, reached from the row rather than by filtering the page's
    // tables: `has:` takes a locator relative to the outer element, and a chained
    // page-level one resolves to nothing inside it.
    await expect(panelRow.locator("xpath=ancestor::table[1]")).toHaveClass(
      /logged-event-rows/
    );
    await expect(visibleDetail(panelRow)).toHaveCount(0);

    // ONE OF THE OTHERS: a metric's readings are a record with a multi-field body,
    // and #3671 deliberately left them alone — same `.table-cards` card mode as
    // before, meta cells on screen with no disclosure to open first.
    await page.goto("/trends/metric/weight");
    const readings = page.locator("table.table-cards").first(); // first-ok: the readings list is this route's only card-mode table
    await expect(readings).toBeVisible();
    await expect(readings).not.toHaveClass(/logged-event-rows/);
    expect(
      await readings.locator('[data-card="meta"]:visible').count()
    ).toBeGreaterThan(0);

    // AND THE RECORD IS NEITHER: `/history` renders the same IDENTITY primitive and
    // no table at all, which is what "one line at every viewport" means structurally.
    await page.goto(`/history?kind=dose&day=${DAY}`);
    const record = page.getByTestId("history-row").filter({ hasText: ITEM });
    await expect(record).toHaveCount(1);
    await expect(record.locator("[data-logged-event-row]")).toHaveCount(1);
    await expect(page.locator("table.logged-event-rows")).toHaveCount(0);
  });

  test("a stack day's rows are told apart without a tap, and no two ⋯ say the same words", async ({
    page,
  }) => {
    seedStackDay();
    await phone(page);
    // THE RECORD IS WHERE THIS DEFECT LIVES NOW (#3958). #3937 found it on the
    // cross-item dose ledger — six rows of one morning stack reading "Friday,
    // August 28 · 10:07am" — and that ledger is this page. The rule travelled with
    // the rows: identity is the ITEM, the clock is beside it, and no two ⋯ announce
    // the same words.
    await page.goto(`/history?kind=dose&day=${DAY}`);

    // SCOPED TO THIS SPEC'S OWN ROWS. The shared seed logs its own doses on this day,
    // and a claim about "every row" would be a claim about a fixture nothing here
    // controls.
    const magnesium = page.getByTestId("history-row").filter({ hasText: ITEM });
    const zinc = page.getByTestId("history-row").filter({ hasText: ITEM_TWO });
    await expect(magnesium).toHaveCount(2);
    await expect(zinc).toHaveCount(1);

    const clocks = await magnesium
      .getByTestId("history-row-clock")
      .allTextContents()
      .then((all) => all.map((t) => t.trim()));
    const zincClock = (
      (await zinc.getByTestId("history-row-clock").textContent()) ?? ""
    ).trim();

    // THE PREMISES, BOTH OF THEM, BEFORE THE VERDICT — because there are two ways a
    // pair of rows can collide and the page has to answer both.
    //
    // ONE: a dose of each item written in the same minute, which only the ITEM tells
    // apart. Under the old slotting these two head lines were the same string.
    expect(
      clocks,
      "no seeded dose shares a minute with the second item any more"
    ).toContain(zincClock);
    // TWO: the same item twice on one day, which only the CLOCK tells apart. This is
    // the pair #3937's literal "item — date" spelling would have left colliding.
    expect(clocks[0], "the two doses of one item share a clock").not.toBe(
      clocks[1]
    );

    // ONE CLOCK GRAMMAR, PAGE-WIDE (#3958): a stated time renders bare, in one
    // meridiem style, and never as the "Ate 2:03 PM" / "recorded 12:02pm" pair the
    // four ledgers shipped between them.
    for (const clock of [...clocks, zincClock]) {
      expect(clock, "the record's clock grammar").toMatch(
        /^(logged )?\d{1,2}:\d{2}(am|pm)?$/
      );
    }

    // THE HEAD LINE TELLS THE ITEMS APART, with no tap.
    await expect(zinc.getByTestId("history-row-title")).toHaveText(ITEM_TWO);
    expect(
      await magnesium.getByTestId("history-row-title").allTextContents()
    ).toEqual([ITEM, ITEM]);

    // AND EVERY ⋯ ANNOUNCES A DIFFERENT ROW (#2615). Three rows, three names — the
    // COUNT is the assertion, because a pair that collided would still satisfy
    // "each name contains its item".
    const names = await page
      .getByTestId("history-row")
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
    // THE SURVIVING CONSUMER (#3958). This was the practice LEDGER route, which
    // folded into `/history`; `PracticeSessionHistory` itself is untouched and still
    // ships on the practice card, which is where #3904's claim belongs — it is a
    // claim about that component's collapse, not about a route.
    await page.goto("/wellness");

    // SCOPED TO THIS SPEC'S OWN CARD, because the ROW does not name its practice
    // here and must not: the card header already does, so `showPracticeName` is
    // false and a row-level `hasText` filter would match nothing. That difference
    // between the card and the deleted ledger is exactly why this had to move rather
    // than be retargeted.
    const card = page
      .getByTestId("wellness-practice-card")
      .filter({ hasText: PRACTICE });
    await expect(card).toHaveCount(1);
    const row = card
      .getByTestId("practice-session-history")
      .locator("table.logged-event-rows tbody tr");
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
  // "Desktop tables are unchanged" had a dedicated case here, asserted on the
  // cross-item dose ledger at 1280px: no disclosure above `sm`, and no weight
  // borrowed from the shared primitive. BOTH of the surfaces it addressed —
  // the dose ledger and the food ledger — were deleted with their routes (#3958),
  // and the record that replaced them is not a table at any width, which the
  // consumer-census test above asserts directly. The remaining EntryHistoryTable
  // consumers keep their desktop columns and their own specs; nothing here is left
  // to make the claim about.

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
