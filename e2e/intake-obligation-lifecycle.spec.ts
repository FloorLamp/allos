import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { closeEditor, intakeForm, openFact } from "./intake-form-helpers";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { utcSqlString, zonedWallTimeToUtc } from "@/lib/date";
import {
  appContent,
  expandUpcomingAggregates,
  hydratedClick,
  settledClick,
  settledFill,
} from "./helpers";

// Issue #1505, the rendered halves of the obligation model:
//   • a `may` item is TRACKED — it renders on Supplements & Meds like any other —
//     but NEVER PUSHED: no Upcoming due row, while a `should` twin seeded beside it
//     has one. It is COLLAPSED, not removed: it appears in Upcoming's "available"
//     disclosure, so the difference is visible on one screen.
//   • the demotion SUGGESTION renders for an abandoned should-tier supplement, and
//     accepting it is what MOVES the item from the due list into that disclosure —
//     the user's tap, never the system's.
//
// Each test owns its fixture rows (unique names, deleted in `finally`) and asserts
// only on those, so nothing here depends on the shared seed's counts. Dates are
// derived from frozenNow() — never wall-clock.

const LOW_NAME = "Tracked Never Pushed (e2e)";
const HIGH_NAME = "Pushed Comparison (e2e)";
const ABANDONED_NAME = "Abandoned Habit (e2e)";
const GUARDED_MED_NAME = "Guarded Med (e2e)";
const GATED_MED_NAME = "Gated Med (e2e)";
const HELD_MED_NAME = "Held Med (e2e)";
const PAUSE_SITUATION = "Presurgery day 2";

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// The frozen run clock as a YYYY-MM-DD calendar day, `back` days earlier.
function dayBack(back: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// `intake_items.created_at` is an instant whose local day bounds adherence.
// Build the named 08:00 fixture in the run's pinned profile zone, then store UTC
// SQL — a naive day + time string crosses the local day in rotating zones.
function createdAt(back: number): string {
  const zone = pinnedTimezone(frozenNow().toISOString()).zone;
  return utcSqlString(zonedWallTimeToUtc(zone, dayBack(back), "08:00")!);
}

// One daily item with a single morning dose on profile 1, created `createdDaysAgo`
// days before the frozen clock so the adherence window's lifetime clamp sees a
// genuinely long-lived item.
function seedItem(
  db: Database.Database,
  name: string,
  obligation: "may" | "should",
  createdDaysAgo: number
): { itemId: number; doseId: number } {
  const created = createdAt(createdDaysAgo);
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, obligation, condition, source, created_at)
         VALUES (1, ?, 1, 'supplement', ?, 'daily', 'manual', ?)`
      )
      .run(name, obligation, created).lastInsertRowid
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
  return { itemId, doseId };
}

// A `must` MEDICATION with one morning dose — the state both #1505 guardrails
// below protect, and the row the owner could not edit (#5336).
function seedMustMed(db: Database.Database, name: string): number {
  const created = createdAt(30);
  const med = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, obligation, condition, source, created_at)
         VALUES (1, ?, 1, 'medication', 'must', 'daily', 'manual', ?)`
      )
      .run(name, created).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses
       (item_id, amount, time_of_day, food_timing, sort, created_at)
     VALUES (?, '1 tablet', 'Morning', 'any', 0, ?)`
  ).run(med, created);
  return med;
}

function dropItem(db: Database.Database, itemId: number | null): void {
  if (itemId == null) return;
  db.prepare(
    `DELETE FROM intake_item_logs
      WHERE dose_id IN (SELECT id FROM intake_item_doses WHERE item_id = ?)`
  ).run(itemId);
  db.prepare("DELETE FROM intake_item_doses WHERE item_id = ?").run(itemId);
  db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key = ?").run(
    `demote-obligation:${itemId}`
  );
  db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key LIKE ?").run(
    `demote-obligation:${itemId}:%`
  );
  db.prepare("DELETE FROM intake_items WHERE id = ?").run(itemId);
}

// The Day ledger collapses a bucket's still-due doses into ONE row with a bulk
// Take-all (#3987/#3936), so the individual names are behind that fold.
async function expandDueGroups(page: Page): Promise<void> {
  const groups = page.locator('[data-testid^="ledger-due-group-"]');
  const n = await groups.count();
  for (let i = 0; i < n; i++) {
    const row = groups.nth(i);
    if ((await row.getAttribute("aria-expanded")) === "false")
      await row.click();
  }
}

test("a `may` item is tracked on its page, off the due list, and inside the available disclosure (#1505)", async ({
  page,
}) => {
  const db = openDb();
  let lowId: number | null = null;
  let highId: number | null = null;
  try {
    const low = seedItem(db, LOW_NAME, "may", 60);
    const high = seedItem(db, HIGH_NAME, "should", 60);
    lowId = low.itemId;
    highId = high.itemId;

    // TRACKED: both items are in the stack, because a `may` item is still an item you
    // keep (#3987 made the stack list a MANAGEMENT list, so it no longer sorts by what
    // this morning owes). What separates them is DUENESS, and dueness is stated once —
    // on the Day ledger, where the `should` one is owed and the `may` one is not.
    await page.goto("/nutrition?tab=supplements");
    const stack = page.getByTestId("supplement-stack");
    await expect(
      stack.getByTestId("intake-item-name").filter({ hasText: HIGH_NAME })
    ).toBeVisible();
    await expect(
      stack.getByTestId("intake-item-name").filter({ hasText: LOW_NAME })
    ).toBeVisible();
    await page.goto("/nutrition?tab=food");
    const ledger = page.getByTestId("day-ledger");
    await expandDueGroups(page);
    await expect(ledger).toContainText(HIGH_NAME);
    await expect(ledger).not.toContainText(LOW_NAME);

    // NEVER PUSHED: only the `should` twin has an Upcoming DUE row…
    await page.goto("/upcoming");
    // The DUE rows fold per band (#1504); the availability disclosure below is a
    // separate, deliberately un-folded surface — a `may` item is in neither the
    // dose aggregate nor its count.
    await expandUpcomingAggregates(page.getByRole("main"), "dose");
    await expect(
      page.getByTestId(`upcoming-item-dose:${high.doseId}`)
    ).toBeVisible();
    await expect(
      page.getByTestId(`upcoming-item-dose:${low.doseId}`)
    ).toHaveCount(0);

    // …and the `may` one is COLLAPSED into the availability disclosure rather than
    // vanishing. Opening it shows the item, labelled as available, not as due.
    const available = appContent(page).getByTestId("available-section");
    await expect(available).toBeVisible();
    await available.locator("summary").click();
    await expect(
      available.getByTestId("available-row").filter({ hasText: LOW_NAME })
    ).toBeVisible();
    await expect(
      available.getByTestId("available-row").filter({ hasText: HIGH_NAME })
    ).toHaveCount(0);
  } finally {
    dropItem(db, lowId);
    dropItem(db, highId);
    db.close();
  }
});

test("accepting a demotion suggestion moves the item into the available disclosure (#1505)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    const item = seedItem(db, ABANDONED_NAME, "should", 90);
    itemId = item.itemId;
    // Taken on only two of its last thirty scheduled days — an abandoned habit.
    for (const back of [29, 22]) {
      db.prepare(
        `INSERT INTO intake_item_logs (dose_id, item_id, date, status, amount)
         VALUES (?, ?, ?, 'taken', '1 cap')`
      ).run(item.doseId, item.itemId, dayBack(back));
    }

    // It still pushes — the suggestion has changed nothing on its own.
    await page.goto("/upcoming");
    await expandUpcomingAggregates(page.getByRole("main"), "dose");
    await expect(
      page.getByTestId(`upcoming-item-dose:${item.doseId}`)
    ).toBeVisible();

    // The suggestion renders, and accepting it is the obligation write.
    await page.goto("/nutrition?tab=supplements");
    const row = page
      .getByTestId("demotion-suggestion-item")
      .filter({ hasText: ABANDONED_NAME });
    await expect(row).toBeVisible();
    await settledClick(page, row.getByTestId("demotion-accept"));

    // The card's row is gone: a low item is never a candidate, so the suggestion
    // clears itself the moment it is acted on.
    await expect(
      page
        .getByTestId("demotion-suggestion-item")
        .filter({ hasText: ABANDONED_NAME })
    ).toHaveCount(0);
    // …and the item is still fully tracked on its own page, in the stack, with the Day
    // ledger no longer claiming it is owed — which is what a `may` item is.
    await expect(
      page
        .getByTestId("supplement-stack")
        .getByTestId("intake-item-name")
        .filter({ hasText: ABANDONED_NAME })
    ).toBeVisible();
    await page.goto("/nutrition?tab=food");
    await expandDueGroups(page);
    await expect(page.getByTestId("day-ledger")).not.toContainText(
      ABANDONED_NAME
    );
    await page.goto("/nutrition?tab=supplements");

    // The push tier no longer carries it.
    await page.goto("/upcoming");
    await expect(
      page.getByTestId(`upcoming-item-dose:${item.doseId}`)
    ).toHaveCount(0);

    // It MOVED rather than disappeared — the visible half of collapse-not-remove.
    const available = appContent(page).getByTestId("available-section");
    await expect(available).toBeVisible();
    await available.locator("summary").click();
    await expect(
      available.getByTestId("available-row").filter({ hasText: ABANDONED_NAME })
    ).toBeVisible();

    const stored = db
      .prepare("SELECT obligation FROM intake_items WHERE id = ?")
      .get(item.itemId) as { obligation: string };
    expect(stored.obligation).toBe("may");
  } finally {
    dropItem(db, itemId);
    db.close();
  }
});

test("a medication's obligation control defaults to Must and states each level's consequences (#1505)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    const med = seedMustMed(db, GUARDED_MED_NAME);
    itemId = med;

    await page.goto(`/medications/${med}?action=edit`);
    const importance = await openFact(page, "importance");
    const obligation = importance.getByTestId("intake-obligation");
    await expect(obligation).toHaveValue("must");

    // The consequence of the CURRENT choice is always on screen — "May" must never be
    // a bare adjective, which is the failure the whole model exists to fix. Each level
    // names what it does, from the one shared copy the confirm dialog also quotes.
    const hint = importance.getByTestId("intake-obligation-hint");
    await expect(hint).toContainText(/follow-up nudge/i);

    await obligation.selectOption("should");
    // The hint names the mechanism the user is giving up, not just its absence: the
    // confirm dialog quotes the same phrase, so a user who reads either sees the same
    // words for the same loss.
    await expect(hint).toContainText(/no missed-dose escalation/i);

    await obligation.selectOption("may");
    await expect(hint).toContainText(/no reminders and no misses/i);
    // Choosing May reveals the as-needed dose shape it IS (#851/#798 key off it) —
    // now under the TIMING fact, which is where "when and how often" lives.
    await closeEditor(page);
    const timing = await openFact(page, "timing");
    await expect(timing.getByTestId("redose-block")).toBeVisible();

    // Nothing is written by looking: the stored obligation is untouched until save.
    const stored = db
      .prepare("SELECT obligation FROM intake_items WHERE id = ?")
      .get(med) as { obligation: string };
    expect(stored.obligation).toBe("must");
  } finally {
    dropItem(db, itemId);
    db.close();
  }
});

// ---- #2419: the collapsed rows can be LOGGED --------------------------------
//
// The doctrine's other promise — a `may` item is "always one tap away", and every
// collapsed row is COLLAPSED, not filtered out. Both web surfaces were
// look-but-don't-log until now, which made taking a situation-bound item mean
// flipping its situation active first, just to make a take button exist. Dueness
// gates NUDGING; logging is a statement about what happened.

const SITUATION_NAME = "Heat Wave (e2e)";
const SITUATION_ITEM = "Situation Bound (e2e)";
const OFFER_ITEM = "Offer Tap (e2e)";

// How many taken rows this dose has — polled after a tap, so the assertion waits on
// the write rather than on a repaint.
function takenCount(db: Database.Database, doseId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM intake_item_logs
          WHERE dose_id = ? AND status = 'taken'`
      )
      .get(doseId) as { n: number }
  ).n;
}

test("a situation-inactive item logs in one tap from More supplements, and the situation stays off (#2419)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  let situationId: number | null = null;
  try {
    const item = seedItem(db, SITUATION_ITEM, "should", 30);
    itemId = item.itemId;
    // Bound to a situation that is NOT active, so the item is off every due path
    // and lands under "More supplements" — the owner-reported case.
    situationId = Number(
      db
        .prepare(
          `INSERT INTO situations (profile_id, name, active, illness_type)
           VALUES (1, ?, 0, 0)`
        )
        .run(SITUATION_NAME).lastInsertRowid
    );
    db.prepare(
      "UPDATE intake_items SET condition = 'situational', situation_id = ? WHERE id = ?"
    ).run(situationId, item.itemId);

    await page.goto("/nutrition?tab=supplements");
    // ONE TAP AWAY, ON THE ROW THE LEDGER CANNOT REACH (#2419, preserved through
    // #3987). The item is off every due path, so the Day ledger has nothing to say
    // about it and no row for it — which is exactly why the tap stays HERE, and why
    // rendering it here is not a second statement of anything.
    const row = page
      .getByTestId("supplement-stack")
      .getByTestId("supplement-row")
      .filter({ hasText: SITUATION_ITEM });
    await expect(row).toBeVisible();

    // One tap, with no edit and no situation change.
    await settledClick(page, row.getByTestId("dose-take"));
    await expect.poll(() => takenCount(db, item.doseId)).toBe(1);

    // Invariant 2: logging is not a lifecycle write. The situation is exactly where
    // it was — nothing implied it, nothing turned it on.
    expect(
      (
        db
          .prepare("SELECT active FROM situations WHERE id = ?")
          .get(situationId) as { active: number }
      ).active
    ).toBe(0);
    // Invariant 3: dueness did not move either — and the DAY moved to where the day
    // lives (#3987). The tap produced a log, so the Day ledger now states it; the
    // control here goes with it, because a dose the ledger states must not be stated
    // twice. The item itself is still in the stack, unchanged.
    await page.reload();
    await expect(
      page
        .getByTestId("supplement-stack")
        .getByTestId("supplement-row")
        .filter({ hasText: SITUATION_ITEM })
        .getByTestId("dose-take")
    ).toHaveCount(0);
    await expect(
      page
        .getByTestId("supplement-stack")
        .getByTestId("intake-item-name")
        .filter({ hasText: SITUATION_ITEM })
    ).toBeVisible();
    await page.goto("/nutrition?tab=food");
    await expandDueGroups(page);
    await expect(page.getByTestId("day-ledger")).toContainText(SITUATION_ITEM);
  } finally {
    dropItem(db, itemId);
    if (situationId != null) {
      db.prepare("DELETE FROM situations WHERE id = ?").run(situationId);
    }
    db.close();
  }
});

test("an Upcoming Available row logs in one tap and stays available rather than becoming due (#2419)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    const item = seedItem(db, OFFER_ITEM, "may", 30);
    itemId = item.itemId;

    await page.goto("/upcoming");
    const available = appContent(page).getByTestId("available-section");
    await available.locator("summary").click();
    const row = available
      .getByTestId("available-row")
      .filter({ hasText: OFFER_ITEM });
    await expect(row).toBeVisible();

    // #2579-F: availability stops wearing work's uniform. The offer is a CHIP in a
    // wrapped run — its name and its slot ON the button, and the tap IS the log —
    // instead of a full-height row whose subtitle led with the section's own heading.
    await expect(available.getByTestId("available-chips")).toBeVisible();
    await expect(row).toContainText("Morning");
    await expect(row).not.toContainText("Available ·");

    await settledClick(page, row.getByTestId("available-mark-taken"));
    await expect.poll(() => takenCount(db, item.doseId)).toBe(1);

    // Carrying a dose id did not make the offer into work: still no due row, and the
    // item is still in the disclosure it was collapsed into.
    await expect(
      page.getByTestId(`upcoming-item-dose:${item.doseId}`)
    ).toHaveCount(0);
    await expect(
      available.getByTestId("available-row").filter({ hasText: OFFER_ITEM })
    ).toBeVisible();
  } finally {
    dropItem(db, itemId);
    db.close();
  }
});

// ---- #5336: the form's confirm gates reach the screen ------------------------
//
// Both guardrails below are asked from INSIDE components/IntakeItemForm.tsx's
// `<form action>`. A form action is a React transition, and React holds every
// `useState` update scheduled inside a pending async action until the action
// settles — so while the confirm provider kept its open sheet in state, the
// action waited on a sheet whose open state React was holding until the wait
// ended. Every Must -> Should/May medication edit sat on "Saving…" with nothing
// to answer, on every device, and no e2e drove one.
//
// So what these two pin is the SHEET ARRIVING WHILE THE ACTION IS STILL PARKED —
// the pending Save beside it is the deadlock's own signature, and it is also what
// says the confirm was not moved to a pre-submit step instead. The answers either
// side of it prove the action was genuinely still there to continue.

// The Save this form posts through. Located by its TYPE, not its name: the name is
// exactly what changes while the action is pending ("Save" -> "Saving…"), and
// these tests need the same handle on both sides of that.
function saveButton(page: Page) {
  return intakeForm(page).locator('button[type="submit"]');
}

// The confirm sheet portals to <body> (BottomSheet), one copy.
function confirmSheet(page: Page) {
  return page.getByTestId("confirm-dialog"); // testid-scope-ok: portaled to <body>, one copy
}

test("the Must -> May guardrail's sheet arrives from inside the form action, and both answers land (#5336/#1505)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    const med = seedMustMed(db, GATED_MED_NAME);
    itemId = med;
    const obligationOf = () =>
      (
        db
          .prepare("SELECT obligation FROM intake_items WHERE id = ?")
          .get(med) as { obligation: string }
      ).obligation;

    await page.goto(`/medications/${med}?action=edit`);
    const importance = await openFact(page, "importance");
    await importance.getByTestId("intake-obligation").selectOption("may");
    await closeEditor(page);

    const save = saveButton(page);
    const sheet = confirmSheet(page);

    // hydratedClick, not settledClick: there is no POST to await yet. The action
    // starts, reaches the guardrail, and parks on it.
    await hydratedClick(page, save);
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(
      `Reduce reminders for ${GATED_MED_NAME}?`
    );
    // Still mid-action while the question is on screen — this is the pair that
    // could not both be true before.
    await expect(save).toHaveText(/Saving…/);

    // Cancelling settles the await with `false`: the handler returns before the
    // write, and the form is answerable again rather than stuck.
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(save).toHaveText(/^Save$/);
    await expect(save).toBeEnabled();
    // The edit is still open — no POST, so no onDone and no URL replace.
    await expect(page).toHaveURL(/\?action=edit$/);
    expect(obligationOf()).toBe("must");

    // Re-armed for real: the same tap asks the same question, and confirming lets
    // the action past the await it was parked on, all the way to the write.
    await hydratedClick(page, save);
    await expect(sheet).toBeVisible();
    await sheet
      .getByRole("button", { name: "Reduce reminders", exact: true })
      .click();
    await expect(page).toHaveURL(/\/medications\/\d+$/);
    await expect.poll(obligationOf).toBe("may");
  } finally {
    dropItem(db, itemId);
    db.close();
  }
});

test("the pause-link confirm arrives from the same form action, and linking lands (#5336/#1296)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    const med = seedMustMed(db, HELD_MED_NAME);
    itemId = med;
    const pauseOf = () =>
      (
        db
          .prepare("SELECT pause_situation_id FROM intake_items WHERE id = ?")
          .get(med) as { pause_situation_id: number | null }
      ).pause_situation_id;

    await page.goto(`/medications/${med}?action=edit`);
    const rules = await openFact(page, "rules");
    await rules.getByTestId("intake-rule-add-pause-while").click();
    const situation = rules.getByRole("combobox", {
      name: "Pause during situation",
      exact: true,
    });
    await settledFill(page, situation, PAUSE_SITUATION);
    // The portaled listbox is still open over the sheet's future seat; Escape
    // closes the list, not the editor.
    await situation.press("Escape");
    await closeEditor(page);

    const save = saveButton(page);
    const sheet = confirmSheet(page);

    await hydratedClick(page, save);
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Pause reminders?");
    await expect(sheet).toContainText(PAUSE_SITUATION);
    await expect(save).toHaveText(/Saving…/);

    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(save).toHaveText(/^Save$/);
    await expect(page).toHaveURL(/\?action=edit$/);
    expect(pauseOf()).toBeNull();

    await hydratedClick(page, save);
    await expect(sheet).toBeVisible();
    await sheet
      .getByRole("button", { name: "Link pause", exact: true })
      .click();
    await expect(page).toHaveURL(/\/medications\/\d+$/);
    await expect.poll(pauseOf).not.toBeNull();
  } finally {
    dropItem(db, itemId);
    // Linking a free-text situation MINTS it into the profile's vocabulary
    // (resolveSituationId), so the fixture owns that row too.
    db.prepare("DELETE FROM situations WHERE profile_id = 1 AND name = ?").run(
      PAUSE_SITUATION
    );
    db.close();
  }
});
