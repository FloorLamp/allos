import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledBoxes, settledClick } from "./helpers";
import { workerDbPath, frozenNow } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { utcSqlString, zonedWallTimeToUtc, shiftDateStr } from "@/lib/date";
import { DOSE_LOG_DATE_WINDOW_DAYS } from "@/lib/dose-log-window";

// THE DAY LEDGER (#3987 phase 1), on its own seeded stack.
//
// The page's shared profile already carries food servings and a due stack, which is
// what the food specs read; what CANNOT be read off it is a COMPOSED WRITE, a SKIP
// with a reason, or a partially-resolved routine — those are shapes nothing seeds. So
// this file seeds its own three-dose stack on profile 1, drives the ledger against it,
// and removes exactly what it added.
//
// SERIAL, because every test here reads the same seeded stack and two of them resolve
// doses in it. Parallel workers each get their own DB (e2e/worker-env.ts), so the
// isolation that matters is within this file.

const STACK = "Ledger Stack (e2e)";
const ITEMS = ["Ledger Alpha (e2e)", "Ledger Beta (e2e)", "Ledger Gamma (e2e)"];
const SKIPPED_ITEM = "Ledger Skipped (e2e)";
const SKIP_REASON = "felt queasy";
// The minute the composed tap wrote in. Two doses sharing it are one write; a third
// dose of the same routine written at a different minute is not (the ledger keys the
// collapse on the write minute, never on the bucket).
const WRITE_HHMM = "07:07";
const STATED_HHMM = "09:30";

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

function zone(): string {
  return pinnedTimezone(frozenNow().toISOString()).zone;
}

function todayLocal(): string {
  return frozenNow().toLocaleDateString("en-CA", { timeZone: zone() });
}

/** A UTC SQL stamp for a wall time on a profile-local day, in the run's pinned zone. */
function stampAt(day: string, hhmm: string): string {
  const at = zonedWallTimeToUtc(zone(), day, hhmm);
  if (!at) throw new Error(`no instant for ${day} ${hhmm} in ${zone()}`);
  return utcSqlString(at);
}

// Doses THIS FILE resolved on profile 1 that it did not seed — the bulk Take-all
// writes real taken rows against the shared fixture's own stack, and a worker runs
// several spec files against one DB, so leaving them would hand the next file a day
// that is already answered.
const borrowedDoseIds: number[] = [];

function cleanup(): void {
  const db = openDb();
  try {
    if (borrowedDoseIds.length > 0) {
      const marks = borrowedDoseIds.map(() => "?").join(", ");
      db.prepare(
        `DELETE FROM intake_item_logs
          WHERE date = ? AND status = 'taken' AND dose_id IN (${marks})`
      ).run(todayLocal(), ...borrowedDoseIds);
      borrowedDoseIds.length = 0;
    }
    const names = [...ITEMS, SKIPPED_ITEM];
    for (const name of names) {
      const row = db
        .prepare(
          "SELECT id FROM intake_items WHERE profile_id = 1 AND name = ?"
        )
        .get(name) as { id: number } | undefined;
      if (!row) continue;
      db.prepare("DELETE FROM intake_item_logs WHERE item_id = ?").run(row.id);
      db.prepare("DELETE FROM intake_item_doses WHERE item_id = ?").run(row.id);
      db.prepare("DELETE FROM intake_items WHERE id = ?").run(row.id);
    }
  } finally {
    db.close();
  }
}

interface Seeded {
  doseIds: number[];
  itemIds: number[];
  skippedDoseId: number;
}

function seed(): Seeded {
  const db = openDb();
  const created = utcSqlString(new Date(frozenNow().getTime() - 86_400_000));
  const day = todayLocal();
  try {
    const doseIds: number[] = [];
    const itemIds: number[] = [];
    for (const name of ITEMS) {
      const itemId = Number(
        db
          .prepare(
            `INSERT INTO intake_items
               (profile_id, name, active, kind, obligation, condition, source, stack, created_at)
             VALUES (1, ?, 1, 'supplement', 'should', 'daily', 'manual', ?, ?)`
          )
          .run(name, STACK, created).lastInsertRowid
      );
      const doseId = Number(
        db
          .prepare(
            `INSERT INTO intake_item_doses
               (item_id, amount, time_of_day, food_timing, sort, created_at)
             VALUES (?, '1 cap', 'Morning', 'any', 0, ?)`
          )
          .run(itemId, created).lastInsertRowid
      );
      itemIds.push(itemId);
      doseIds.push(doseId);
    }
    // TWO of the three, written in ONE minute — the composed tap, read back. The third
    // stays owed, which is what makes the row say "2 of 3" instead of a bare check.
    for (const doseId of doseIds.slice(0, 2)) {
      const itemId = itemIds[doseIds.indexOf(doseId)];
      db.prepare(
        `INSERT INTO intake_item_logs
           (dose_id, item_id, date, status, amount, recorded_at)
         VALUES (?, ?, ?, 'taken', '1 cap', ?)`
      ).run(doseId, itemId, day, stampAt(day, WRITE_HHMM));
    }

    // A SKIP, with its stored reason, on an unstacked item — a recorded event, never
    // hidden. Its STATED time is later than the composed write's filing time, so it
    // also carries the ordering claim: a stated row sorts above a filing-time one.
    const skipItemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, obligation, condition, source, created_at)
           VALUES (1, ?, 1, 'supplement', 'should', 'daily', 'manual', ?)`
        )
        .run(SKIPPED_ITEM, created).lastInsertRowid
    );
    const skippedDoseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort, created_at)
           VALUES (?, '2 caps', 'Morning', 'any', 0, ?)`
        )
        .run(skipItemId, created).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, status, skip_reason, amount, recorded_at, occurred_at)
       VALUES (?, ?, ?, 'skipped', ?, '2 caps', ?, ?)`
    ).run(
      skippedDoseId,
      skipItemId,
      day,
      SKIP_REASON,
      stampAt(day, WRITE_HHMM),
      stampAt(day, STATED_HHMM)
    );
    itemIds.push(skipItemId);
    return { doseIds, itemIds, skippedDoseId };
  } finally {
    db.close();
  }
}

// Rows of one status for one dose ON ONE DAY. Scoped to the day deliberately: a
// schedule row is not an occurrence (#3936), so a daily supplement carries one row
// for every day it was answered, and counting them all would answer a different
// question.
function statusCount(
  doseId: number,
  date: string,
  status: "taken" | "skipped"
): number {
  const db = openDb();
  try {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM intake_item_logs WHERE dose_id = ? AND date = ? AND status = ?"
        )
        .get(doseId, date, status) as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

/** The ledger's Morning group, whose rows every test here reads. */
function morning(page: Page) {
  return page.getByTestId("ledger-group-morning");
}

test.describe("the Day ledger (#3987 phase 1)", () => {
  test.describe.configure({ mode: "serial" });

  let seeded: Seeded;
  test.beforeAll(() => {
    cleanup();
    seeded = seed();
  });
  test.afterAll(cleanup);

  test("a composed write collapses to one row, and states a partial stack honestly", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    await expect(page.getByTestId("day-ledger")).toBeVisible();

    // ONE row for the two doses one tap wrote — named by the routine, with the
    // routine's own clock.
    const stack = morning(page).locator('[data-testid^="ledger-stack-"]');
    await expect(stack).toHaveCount(1);
    await expect(stack).toContainText(STACK);
    // "2 of 3", never a bare check: the third dose of the routine is still owed, and a
    // single ✓ over a partial stack is a claim the day does not support.
    await expect(stack).toHaveAttribute("data-label", "2 of 3");
    await expect(stack).toContainText("2 of 3");
    // COLLAPSED: the members are not in the DOM until it is opened, which is what
    // makes it one row rather than three wearing a heading.
    await expect(morning(page)).not.toContainText(ITEMS[0]);

    await hydratedClick(page, stack);
    // Expanded: the two it wrote, AND the one still open — the open member rides the
    // stack row rather than the bucket's due row, so the dose is on exactly one row.
    await expect(morning(page)).toContainText(ITEMS[0]);
    await expect(morning(page)).toContainText(ITEMS[1]);
    await expect(
      page.getByTestId(`ledger-due-dose-${seeded.doseIds[2]}`)
    ).toBeVisible();
    // AND NOT ALSO IN THE BUCKET'S DUE ROW. `data-doses` names every dose that row
    // will write, which is what makes this checkable rather than a visual impression.
    const due = morning(page).locator('[data-testid^="ledger-due-group-"]');
    const named = ((await due.getAttribute("data-doses")) ?? "").split(",");
    expect(named).not.toContain(String(seeded.doseIds[2]));
  });

  test("a skip states its stored reason, and a stated row sorts above a filed one", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    const skip = page.locator('[data-testid^="ledger-dose-"]').filter({
      hasText: SKIPPED_ITEM,
    });
    await expect(skip).toHaveAttribute("data-status", "skipped");
    // A skip is a recorded event, and the record includes WHY.
    await expect(skip).toContainText(`Skipped — ${SKIP_REASON}`);

    // ORDERING. The skip states 09:30; the composed stack was only FILED, at 07:07.
    // A clock-only sort would put the stack first; the ledger sinks every filing-time
    // row below every stated one, so the skip leads.
    const stack = morning(page).locator('[data-testid^="ledger-stack-"]');
    const [skipBox, stackBox] = await settledBoxes([skip, stack]);
    expect(skipBox.y).toBeLessThan(stackBox.y);
    // And the filed row says which clock it is showing (#3958's grammar), rather than
    // a bare time claiming an administration minute nobody stated. Read off the ROW,
    // not the summary button: the clock is the row's trailing fact, beside it.
    await expect(
      morning(page).locator('li:has([data-testid^="ledger-stack-"])')
    ).toContainText(/logged \d{1,2}:\d{2}/);
  });

  test("the bulk Take-all writes only what the day still owes (#3936)", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    const due = morning(page).locator('[data-testid^="ledger-due-group-"]');
    await expect(due).toBeVisible();
    const named = ((await due.getAttribute("data-doses")) ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    expect(named.length).toBeGreaterThan(0);
    const takeAll = morning(page).locator('[data-testid^="ledger-takeall-"]');
    await expect(takeAll).toHaveText(`Take all ${named.length}`);

    // THE STALE TAP, forged deliberately: one of the doses this row NAMES is resolved
    // out of band, exactly as a phone tap or another tab would. The row's list is an
    // UPPER BOUND — the core re-derives the day's pending set and writes only the
    // intersection — so the write must land on the REST and must not double-log the
    // one that moved.
    const stale = named[0];
    borrowedDoseIds.push(...named);
    const db = openDb();
    try {
      const item = db
        .prepare("SELECT item_id FROM intake_item_doses WHERE id = ?")
        .get(stale) as { item_id: number };
      db.prepare(
        `INSERT INTO intake_item_logs (dose_id, item_id, date, status, recorded_at)
         VALUES (?, ?, ?, 'taken', ?)`
      ).run(stale, item.item_id, todayLocal(), utcSqlString(frozenNow()));
    } finally {
      db.close();
    }
    const day = todayLocal();
    expect(statusCount(stale, day, "taken")).toBe(1);

    // THE ROW'S PROMISE IS THE SERVER'S PENDING SET, not a client copy of it. A
    // reload after the out-of-band write must drop the stale dose from the names AND
    // from the count the label promises — the half that would still be wrong if the
    // row rendered whatever it was handed at first paint.
    await page.reload();
    const namedAfter = ((await due.getAttribute("data-doses")) ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    expect(namedAfter).not.toContain(stale);
    expect(namedAfter).toHaveLength(named.length - 1);
    await expect(takeAll).toHaveText(`Take all ${named.length - 1}`);

    await settledClick(page, takeAll);
    // ONE taken row for the stale dose, still — no second administration for a dose
    // the day no longer owed. DEFENDED TWICE, and the second defence is why this
    // assertion alone is not the whole claim: `resolveDayDoses` intersects the named
    // ids with the day's freshly-derived pending set, AND `markDoseTaken` is
    // idempotent per (dose, date). Measured by mutation: removing the intersection
    // leaves this line green, which is what the reload assertions above are for.
    expect(statusCount(stale, day, "taken")).toBe(1);
    // And the rest of the named set did land.
    for (const doseId of named.slice(1))
      expect(statusCount(doseId, day, "taken")).toBe(1);
  });

  test("past-day dose interactivity flips at the write window, from both sides", async ({
    page,
  }) => {
    // INSIDE the window a past day's rows are live; the day after it is record only.
    // Both sides are read off the SAME constant the write cores gate on, so the spec
    // cannot drift from the rule it is checking.
    const inside = shiftDateStr(todayLocal(), -DOSE_LOG_DATE_WINDOW_DAYS);
    const outside = shiftDateStr(
      todayLocal(),
      -(DOSE_LOG_DATE_WINDOW_DAYS + 1)
    );
    expect(inside).not.toBe(outside);

    await page.goto("/nutrition");
    await hydratedClick(
      page,
      page.locator(`[data-testid="food-day-${inside}"]`)
    );
    const insideDue = page
      .locator('[data-testid^="ledger-due-group-"]')
      .first(); // first-ok: any due group carries the bulk control — order-agnostic
    await expect(insideDue).toBeVisible();
    await expect(
      page.locator('[data-testid^="ledger-takeall-"]').first() // first-ok: same group
    ).toBeVisible();

    await hydratedClick(
      page,
      page.locator(`[data-testid="food-day-${outside}"]`)
    );
    // Beyond the window the day still STATES what it owed — the record outlives the
    // write window — and offers nothing to tap.
    //
    // THE ABSENCE IS NOT THE ASSERTION. `toHaveCount(0)` on the bulk control passes on
    // an EMPTY page exactly as happily as on the intended one, and an empty page is what
    // this surface actually shipped for a while: the pending half was gathered only
    // inside the write window, so a day four back rendered "Nothing logged yet." for a
    // day that owed doses. So the statement is asserted first and the absence second.
    const outsideDue = page.locator('[data-testid^="ledger-due-group-"]');
    await expect(outsideDue.first()).toBeVisible(); // first-ok: any due group proves the day still states what it owed
    await expect(page.getByTestId("day-ledger-empty")).toHaveCount(0);
    await expect(page.locator('[data-testid^="ledger-takeall-"]')).toHaveCount(
      0
    );
    // And expanding it states the doses themselves as record, not as offers.
    await hydratedClick(page, outsideDue.first()); // first-ok: same group
    const outsideDose = page
      .locator('[data-testid^="ledger-due-dose-"]')
      .first(); // first-ok: any named dose row — order-agnostic
    await expect(outsideDose).toContainText("Not recorded");
    await expect(outsideDose.getByRole("button")).toHaveCount(0);
  });

  test("a past-day dose captured offline leaves the ledger, then replays onto that day", async ({
    page,
  }) => {
    const day = shiftDateStr(todayLocal(), -1);
    const doseId = seeded.doseIds[0]!;
    const todayBefore = statusCount(doseId, todayLocal(), "taken");

    await page.goto("/nutrition");
    await hydratedClick(page, page.getByTestId("food-day-yesterday"));
    const group = morning(page).locator('[data-testid^="ledger-due-group-"]');
    await expect(group).toHaveAttribute(
      "data-doses",
      new RegExp(`(^|,)${doseId}(,|$)`)
    );
    await hydratedClick(page, group);

    const row = page.getByTestId(`ledger-due-dose-${doseId}`);
    await expect(row).toBeVisible();

    await page.context().setOffline(true);
    // A plain click: the queue, rather than a Server Action response, settles this tap.
    // The row's own shared control (#4424 ruling 3), which on a past day used to be a
    // hand-rolled Take/Skip pair beside it.
    await row.getByTestId("dose-take").click();
    await expect(
      page.getByText("Dose saved offline — will sync when you reconnect.")
    ).toBeVisible();
    await expect(page.getByTestId("offline-queue-badge")).toHaveText(
      /1 queued offline/
    );
    // A kept capture resolves this occurrence now, before replay owns the durable write.
    await expect(row).toHaveCount(0);

    await page.context().setOffline(false);
    await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0, {
      timeout: 20_000,
    });

    // Replay lands once on the day the ledger named, without disturbing today's row.
    expect(statusCount(doseId, day, "taken")).toBe(1);
    expect(statusCount(doseId, todayLocal(), "taken")).toBe(todayBefore);
  });

  test("a past-day dose skipped offline leaves the ledger, then replays onto that day", async ({
    page,
  }) => {
    const day = shiftDateStr(todayLocal(), -1);
    const doseId = seeded.doseIds[1]!;
    const todayBefore = statusCount(doseId, todayLocal(), "taken");

    await page.goto("/nutrition");
    await hydratedClick(page, page.getByTestId("food-day-yesterday"));
    const group = morning(page).locator('[data-testid^="ledger-due-group-"]');
    await expect(group).toHaveAttribute(
      "data-doses",
      new RegExp(`(^|,)${doseId}(,|$)`)
    );
    await hydratedClick(page, group);

    const row = page.getByTestId(`ledger-due-dose-${doseId}`);
    await expect(row).toBeVisible();

    await page.context().setOffline(true);
    await row.getByTestId("dose-skip").click();
    await expect(
      page.getByText("Skip saved offline — will sync when you reconnect.")
    ).toBeVisible();
    await expect(page.getByTestId("offline-queue-badge")).toHaveText(
      /1 queued offline/
    );
    // The missing row also removes the only second-tap control before replay.
    await expect(row).toHaveCount(0);

    await page.context().setOffline(false);
    await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0, {
      timeout: 20_000,
    });

    expect(statusCount(doseId, day, "skipped")).toBe(1);
    expect(statusCount(doseId, day, "taken")).toBe(0);
    expect(statusCount(doseId, todayLocal(), "taken")).toBe(todayBefore);
  });
});

test.describe("the day is stated once, and the chrome is measured", () => {
  test.use({ viewport: { width: 430, height: 932 } });

  test("no serving or dose is rendered twice, and the ledger leads the page", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    const ledger = page.getByTestId("day-ledger");
    await expect(ledger).toBeVisible();

    // THE REMOVAL. The Meals cards and the LOGGED-TODAY list were two full renderings
    // of the same servings, adjacent; neither survives.
    await expect(page.getByTestId("food-meal-summary")).toHaveCount(0);
    await expect(page.getByTestId("food-logged-list")).toHaveCount(0);
    // Every serving row is unique: one <li> per ledger event id, page-wide.
    const ids = await page
      .locator('[data-testid^="ledger-serving-"]')
      .evaluateAll((nodes) =>
        nodes
          .map((n) => n.getAttribute("data-testid") ?? "")
          .filter((id) => /^ledger-serving-\d+$/.test(id))
      );
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);

    // THE CONVERSE, and it is the half the removal cannot make: an empty page passes
    // "nothing renders it twice" just as happily. These are the named surfaces that
    // must STILL carry the day — the ledger states the servings, and the add list
    // still offers the groups to add.
    await expect(ledger.locator("li[data-group]").first()).toBeVisible(); // first-ok: any serving row proves the ledger states the day — order-agnostic
    await expect(
      page
        .getByTestId("food-quick-rows")
        .locator('li[data-testid^="food-group-"]')
    ).not.toHaveCount(0);
    // The day's census, once, in the header — and a POSITIVE count. `/\d+ servings?/`
    // matches "0 servings", so the whole converse above would have been undone by one
    // regex: an empty day states its emptiness in exactly that grammar.
    await expect(page.getByTestId("day-ledger-census")).toContainText(
      new RegExp(`^${ids.length} servings?\\b`)
    );

    // THE MEASUREMENT (#3987's chrome gate). The redesign's goal is LESS, so less is
    // measured: the y of the FIRST LEDGER ROW — of any kind, since a dose row can
    // legitimately lead the day — at 430x932. Reported in the PR body.
    // `[data-testid="ledger-rows"] > li` and NOT `ul > li`, which says what this
    // measurement means instead of relying on the rows being the section's only list.
    //
    // WHAT IS NOT KNOWN, stated because the commit that changed this first claimed
    // otherwise. On CI at 8627f824 this line failed with `expected null not to be null`
    // — `boundingBox()` on an element that was attached but not visible. I proposed that
    // a keep-apart notice above the rows had carried its own list, and then checked:
    // `Notice` renders no `ul` and no `li`, `DayLedger` contains no `<details>` and no
    // Disclosure, and the only lists in this section are the rows and the two nested
    // ones inside expanded rows. So that explanation is DISPROVEN, and with it the
    // weaker claim that the old locator could match anything outside the rows on today's
    // markup. The real mechanism is unexplained and was never reproduced locally.
    //
    // This locator is therefore a precision improvement that removes a dependency the
    // measurement should never have had — not a fix for a mechanism anyone has seen.
    const firstRow = ledger.locator('[data-testid="ledger-rows"] > li').first(); // first-ok: the topmost row IS the measurement — order is the point
    const box = await firstRow.boundingBox();
    expect(box).not.toBeNull();
    // eslint-disable-next-line no-console
    console.log(`LEDGER_FIRST_ROW_Y=${Math.round(box!.y)}`);
    // A ceiling, not the number: the point of the gate is that the chrome above the
    // day cannot grow back. 520px is roughly half the 932px viewport — the schedule
    // this replaces spent ~1,600px before its first supplement (#3892).
    expect(box!.y).toBeLessThan(520);
  });
});

// ── THE SELECTION EDIT, AND THE FORGED POST IT IS BOUNDED BY (#4118) ──────────
//
// Both halves of this block are about the same thing from opposite ends: what a
// hand-built request can put in the food ledger, and what a legitimate batch can take
// out of it. The web surface can only ever offer the bounded day picker, so the FORGED
// case has to be forged — the request is rewritten in flight, which is exactly the
// shape the criterion names.

/**
 * Check one dose row's selection box, opening the composed row when the dose is inside
 * it. A member whose stated clock stops matching its tap-mates STEPS OUT of the collapse
 * (`buildDayLedger`), so the same dose is behind the stack row before a Set time… and
 * standing on its own after one — which is correct, and which a spec that always
 * expanded would break on.
 */
async function pickDose(page: Page, logId: number): Promise<void> {
  const box = page.getByTestId(`ledger-pick-dose-${logId}`);
  if (!(await box.isVisible())) {
    await hydratedClick(
      page,
      morning(page).locator('[data-testid^="ledger-stack-"]')
    );
  }
  await hydratedClick(page, box);
}

/**
 * Bring one add-list row on screen. The list densifies to the profile's own top groups
 * and folds the rest behind "More groups" (#3987 phase 1), so which rows are VISIBLE
 * depends on what this worker's DB has been logging — a spec that assumed a fixed row
 * would pass or fail on its neighbours' history.
 */
async function revealFoodGroup(page: Page, slug: string): Promise<void> {
  const row = page.getByTestId(`food-group-${slug}`);
  if (!(await row.isVisible())) {
    await page.getByTestId("food-more-groups-summary").click();
    await expect(row).toBeVisible();
  }
}

/** Food events for profile 1 on one day, by group. */
function servingRows(day: string, slug: string): { id: number }[] {
  const db = openDb();
  try {
    return db
      .prepare(
        "SELECT id FROM food_log_events WHERE profile_id = 1 AND date = ? AND group_key = ? ORDER BY id"
      )
      .all(day, slug) as { id: number }[];
  } finally {
    db.close();
  }
}

function dropServings(ids: readonly number[]): void {
  if (ids.length === 0) return;
  const db = openDb();
  try {
    db.prepare(
      `DELETE FROM food_log_events WHERE id IN (${ids.map(() => "?").join(", ")})`
    ).run(...ids);
    db.prepare(
      "DELETE FROM food_daily_totals WHERE profile_id = 1 AND servings <= 0"
    ).run();
  } finally {
    db.close();
  }
}

/** The stored instant of one ledger row, or null when nobody stated one. */
function servingInstant(id: number): string | null {
  const db = openDb();
  try {
    return (
      (
        db
          .prepare("SELECT occurred_at AS at FROM food_log_events WHERE id = ?")
          .get(id) as { at: string | null } | undefined
      )?.at ?? null
    );
  } finally {
    db.close();
  }
}

function doseLogRow(
  doseId: number
): { id: number; date: string; at: string | null } | undefined {
  const db = openDb();
  try {
    return db
      .prepare(
        "SELECT id, date, occurred_at AS at FROM intake_item_logs WHERE dose_id = ? AND status = 'taken' ORDER BY id DESC LIMIT 1"
      )
      .get(doseId) as
      { id: number; date: string; at: string | null } | undefined;
  } finally {
    db.close();
  }
}

test.describe("a forged POST cannot date a serving into the future", () => {
  const SLUG = "berries";

  test("the same tap writes today, and dies when its day is rewritten ahead", async ({
    page,
  }) => {
    const day = todayLocal();
    const future = shiftDateStr(day, 400);
    const before = servingRows(day, SLUG).length;
    const added: number[] = [];

    // The control tap's own request, kept so the forged one can be built from it
    // rather than from a guess about how Next encodes a Server Action call.
    let captured: {
      url: string;
      headers: Record<string, string>;
      body: string;
    } | null = null;
    page.on("request", (request) => {
      const postBody = request.postData();
      if (
        captured === null &&
        request.method() === "POST" &&
        request.headers()["next-action"] != null &&
        postBody != null
      ) {
        captured = {
          url: request.url(),
          headers: request.headers(),
          body: postBody,
        };
      }
    });

    await page.goto("/nutrition");
    await expect(page.getByTestId("food-log-bar")).toBeVisible();
    await revealFoodGroup(page, SLUG);

    // THE POSITIVE CONTROL FIRST, THROUGH THE SAME CONTROL AND THE SAME QUERY the
    // forged case is judged by. Without it "no future row exists" is satisfied by a tap
    // that never reached the server at all, which is the state a broken locator, a
    // dead route handler and a genuine guard all produce alike.
    await hydratedClick(page, page.getByTestId(`log-${SLUG}`));
    await expect.poll(() => servingRows(day, SLUG).length).toBe(before + 1);
    added.push(servingRows(day, SLUG).at(-1)!.id);

    // NOW FORGE IT — and forge it OUTSIDE the page, which is what "a forged POST"
    // means. The earlier shape of this test rewrote the body in flight through
    // `page.route`, and that was intermittently a no-op: this app registers a service
    // worker, and a request the worker fetches never reaches `page.route` at all (the
    // mechanism e2e/stale-build-save.spec.ts documents). Measured 2 of 3 repeats with
    // the interception never firing. Replaying the CAPTURED request through Playwright's
    // own request context has no such gap — and it is also a stronger claim: the
    // request never went near the app's own code.
    expect(
      captured,
      "no server-action POST was captured from the control tap"
    ).not.toBeNull();
    const body = captured!.body;
    // The day appears in the body exactly where the picker put it; a body that did not
    // carry it would make the rewrite below a no-op that still "passed".
    expect(body.includes(day)).toBe(true);
    const headers = { ...captured!.headers };
    delete headers["content-length"];
    const forged = await page.request.fetch(captured!.url, {
      method: "POST",
      headers,
      data: body.split(day).join(future),
    });
    expect(forged.status()).toBeLessThan(500);

    // NOTHING LANDED — not on the forged day, and not on today either. A bound that
    // silently fell back to today would satisfy the first assertion and quietly write
    // the serving somewhere nobody asked for.
    expect(servingRows(future, SLUG)).toEqual([]);
    expect(servingRows(day, SLUG).length).toBe(before + 1);

    dropServings(added);
  });
});

test.describe("the Day ledger's selection edit", () => {
  test.describe.configure({ mode: "serial" });

  let seeded: Seeded;
  test.beforeAll(() => {
    cleanup();
    seeded = seed();
  });
  test.afterAll(cleanup);

  test("one selection of a serving and a dose is re-timed, re-dated, then removed", async ({
    page,
  }) => {
    const day = todayLocal();
    const yesterday = shiftDateStr(day, -1);
    // A serving of our own to select, written through the page's own add control.
    const before = servingRows(day, "berries").length;
    await page.goto("/nutrition");
    await revealFoodGroup(page, "berries");
    await hydratedClick(page, page.getByTestId("log-berries"));
    await expect
      .poll(() => servingRows(day, "berries").length)
      .toBe(before + 1);
    const servingId = servingRows(day, "berries").at(-1)!.id;
    const doseLog = doseLogRow(seeded.doseIds[0])!;
    expect(doseLog.date).toBe(day);

    // ── Set time… over a MIXED selection ─────────────────────────────────────
    await page.goto("/nutrition");
    await hydratedClick(page, page.getByTestId("ledger-select-toggle"));
    await hydratedClick(
      page,
      page.getByTestId(`ledger-pick-serving-${servingId}`)
    );
    // The dose lives inside the collapsed composed row; open it to reach the member.
    await pickDose(page, doseLog.id);
    await expect(page.getByTestId("ledger-selection-count")).toHaveText(
      "2 selected"
    );

    await hydratedClick(page, page.getByTestId("ledger-selection-set-time"));
    // 08:15, deliberately BEFORE the run's pinned 13:mm local time: a stated instant
    // later than now is refused by the same gate every other occurred_at write passes,
    // so a batch that asked for the evening would be testing the refusal instead.
    await page.getByTestId("ledger-selection-when-time").fill("08:15");
    await hydratedClick(page, page.getByTestId("ledger-selection-time-apply"));

    const stated = stampAt(day, "08:15");
    await expect.poll(() => servingInstant(servingId)).not.toBeNull();
    // BOTH TABLES. A batch that quietly covered only food would satisfy every
    // serving assertion here.
    expect(new Date(servingInstant(servingId)!).getTime()).toBe(
      new Date(`${stated.replace(" ", "T")}Z`).getTime()
    );
    await expect.poll(() => doseLogRow(seeded.doseIds[0])!.at).not.toBeNull();
    expect(new Date(doseLogRow(seeded.doseIds[0])!.at!).getTime()).toBe(
      new Date(`${stated.replace(" ", "T")}Z`).getTime()
    );

    // ── Move to day… carries each row's own wall clock ───────────────────────
    await page.goto("/nutrition");
    await hydratedClick(page, page.getByTestId("ledger-select-toggle"));
    await hydratedClick(
      page,
      page.getByTestId(`ledger-pick-serving-${servingId}`)
    );
    await pickDose(page, doseLog.id);
    await hydratedClick(page, page.getByTestId("ledger-selection-move-day"));
    await page
      .getByTestId("ledger-selection-day-select")
      .selectOption({ label: "Yesterday" });
    await hydratedClick(page, page.getByTestId("ledger-selection-day-apply"));

    await expect
      .poll(() => servingRows(yesterday, "berries").map((r) => r.id))
      .toContain(servingId);
    await expect
      .poll(() => doseLogRow(seeded.doseIds[0])!.date)
      .toBe(yesterday);
    // The clock came WITH the day. A re-date that left 08:15 on the day before would
    // put a stated instant on a row it no longer belongs to.
    const movedTo = stampAt(yesterday, "08:15");
    expect(new Date(servingInstant(servingId)!).getTime()).toBe(
      new Date(`${movedTo.replace(" ", "T")}Z`).getTime()
    );

    // ── Delete asks once, for the batch ──────────────────────────────────────
    await page.goto("/nutrition");
    await hydratedClick(page, page.getByTestId("food-day-yesterday"));
    await hydratedClick(page, page.getByTestId("ledger-select-toggle"));
    await hydratedClick(
      page,
      page.getByTestId(`ledger-pick-serving-${servingId}`)
    );
    await pickDose(page, doseLog.id);
    await hydratedClick(page, page.getByTestId("ledger-selection-delete"));
    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Remove 2 rows?");
    await dialog.getByRole("button", { name: "Remove" }).click();
    // ONE question for the batch: the dialog is gone and no second one takes its place.
    await expect(dialog).toHaveCount(0);

    await expect
      .poll(() => servingRows(yesterday, "berries").map((r) => r.id))
      .not.toContain(servingId);
    await expect.poll(() => doseLogRow(seeded.doseIds[0])).toBeUndefined();
  });
});
