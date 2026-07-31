import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";
import {
  expandUpcomingAggregates,
  settledClick,
  settledSelect,
} from "./helpers";

// Issue #1602, the rendered halves of non-daily intake cadence:
//   • a WEEKLY medication is off the due list on its off-days — while staying listed
//     on its own page and staying `must`, so it keeps its reminders and escalation.
//     That is the whole point: the old workaround was to demote it, which silenced
//     exactly the drugs that most need the safety net.
//   • an ALTERNATING pair (one item, two dose rows) shows exactly one amount today and
//     the other tomorrow, each row named by the days it belongs to.
//   • the cadence CONTROL round-trips through the real edit form.
//
// Each test owns its fixture rows (unique names, deleted in `finally`) and asserts only
// on those, so nothing depends on the shared seed's counts. Dates derive from
// frozenNow() — never wall-clock.

const WEEKLY_NAME = "Weekly Cadence Med (e2e)";
const DAILY_NAME = "Daily Cadence Comparison (e2e)";
const ALT_NAME = "Alternating Cadence (e2e)";
const FORM_NAME = "Form Cadence Round Trip (e2e)";

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

function dayBack(back: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// The frozen run clock's weekday (0=Sun … 6=Sat) — the repo's numbering, so a fixture
// can be anchored on "today" or "tomorrow" without depending on which day the suite
// happens to run.
function todayWeekday(): number {
  return frozenNow().getUTCDay();
}

interface SeedOpts {
  cadenceKind?: "daily" | "weekly";
  cadenceWeekdays?: string | null;
}

function seedItem(
  db: Database.Database,
  name: string,
  opts: SeedOpts = {}
): number {
  const createdAt = `${dayBack(90)} 08:00:00`;
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, obligation, condition, source, created_at,
            cadence_kind, cadence_weekdays)
         VALUES (1, ?, 1, 'medication', 'must', 'daily', 'manual', ?, ?, ?)`
      )
      .run(
        name,
        createdAt,
        opts.cadenceKind ?? "daily",
        opts.cadenceWeekdays ?? null
      ).lastInsertRowid
  );
}

// A supplement fixture for the form round-trip: the shared intake form renders on the
// supplements tab, and kind is clinical identity — it has no bearing on the calendar.
function seedSupplement(db: Database.Database, name: string): number {
  const createdAt = `${dayBack(90)} 08:00:00`;
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, obligation, condition, source, created_at,
            cadence_kind)
         VALUES (1, ?, 1, 'supplement', 'should', 'daily', 'manual', ?, 'daily')`
      )
      .run(name, createdAt).lastInsertRowid
  );
}

function seedDose(
  db: Database.Database,
  itemId: number,
  amount: string,
  weekdays: string | null,
  sort = 0
): number {
  const createdAt = `${dayBack(90)} 08:00:00`;
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, created_at, weekdays)
         VALUES (?, ?, 'Morning', 'any', ?, ?, ?)`
      )
      .run(itemId, amount, sort, createdAt, weekdays).lastInsertRowid
  );
}

function dropItem(db: Database.Database, itemId: number | null): void {
  if (itemId == null) return;
  db.prepare(
    `DELETE FROM intake_item_logs
      WHERE dose_id IN (SELECT id FROM intake_item_doses WHERE item_id = ?)`
  ).run(itemId);
  db.prepare("DELETE FROM intake_item_doses WHERE item_id = ?").run(itemId);
  db.prepare("DELETE FROM medication_courses WHERE item_id = ?").run(itemId);
  db.prepare("DELETE FROM intake_items WHERE id = ?").run(itemId);
}

// The due-today dose card for a fixture item, scoped to its time-bucket section the way
// the sibling dose-history spec does — the page also lists the item in its full-schedule
// card, so an unscoped name filter matches two elements.
function doseCard(page: import("@playwright/test").Page, name: string) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Morning" }) })
    .locator("div.card")
    .filter({ hasText: name });
}

test("a weekly medication is off the due list on its off-days without being demoted (#1602)", async ({
  page,
}) => {
  const db = openDb();
  let weeklyId: number | null = null;
  let dailyId: number | null = null;
  try {
    // Scheduled for TOMORROW's weekday, so the frozen "today" is one of its off-days.
    const offDay = (todayWeekday() + 1) % 7;
    weeklyId = seedItem(db, WEEKLY_NAME, {
      cadenceKind: "weekly",
      cadenceWeekdays: String(offDay),
    });
    const weeklyDoseId = seedDose(db, weeklyId, "10 mg", null);
    dailyId = seedItem(db, DAILY_NAME);
    const dailyDoseId = seedDose(db, dailyId, "5 mg", null);

    // NOT DUE today: no Upcoming row for the weekly med, while its daily twin has one.
    // Under the old model the only way to get this silence was to demote the item.
    await page.goto("/upcoming");
    // Scheduled doses fold per band (#1504) — open the fold so this asserts on the
    // real rows: cadence decides what is IN the fold, not whether it is folded.
    await expandUpcomingAggregates(page.getByRole("main"), "dose");
    await expect(
      page.getByTestId(`upcoming-item-dose:${dailyDoseId}`)
    ).toBeVisible();
    await expect(
      page.getByTestId(`upcoming-item-dose:${weeklyDoseId}`)
    ).toHaveCount(0);

    // STILL `must`: the item was not silenced by lowering what is owed, so its
    // reminders and missed-dose escalation are intact for the day it IS due.
    const obligation = db
      .prepare("SELECT obligation FROM intake_items WHERE id = ?")
      .get(weeklyId) as { obligation: string };
    expect(obligation.obligation).toBe("must");

    // VISIBLE, not vanished: the med is still fully listed on its own page. Off-cadence
    // means "not due today", never "gone" — the discoverability contract that keeps an
    // absence explicable instead of looking like a deletion.
    await page.goto("/medications");
    await expect(
      page.getByTestId("medication-list").filter({ hasText: WEEKLY_NAME })
    ).toBeVisible();
  } finally {
    dropItem(db, weeklyId);
    dropItem(db, dailyId);
    db.close();
  }
});

test("an alternating pair shows one amount today and the other tomorrow (#1602)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    const dow = todayWeekday();
    const otherDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== dow).join(",");
    itemId = seedItem(db, ALT_NAME);
    // ONE item, two rows: today's weekday gets the full amount, every other day the half.
    const todayDoseId = seedDose(db, itemId, "5 mg", String(dow), 0);
    const otherDoseId = seedDose(db, itemId, "2.5 mg", otherDays, 1);

    await page.goto("/upcoming");
    await expandUpcomingAggregates(page.getByRole("main"), "dose");
    // Exactly one of the two rows is due — the whole reason alternating amounts are two
    // rows rather than one row whose amount the user has to reinterpret each morning.
    await expect(
      page.getByTestId(`upcoming-item-dose:${todayDoseId}`)
    ).toBeVisible();
    await expect(
      page.getByTestId(`upcoming-item-dose:${otherDoseId}`)
    ).toHaveCount(0);
    // The visible row names the amount that actually applies today.
    await expect(
      page.getByTestId(`upcoming-item-dose:${todayDoseId}`)
    ).toContainText("5 mg");
  } finally {
    dropItem(db, itemId);
    db.close();
  }
});

test("the cadence control round-trips through the real edit form (#1602)", async ({
  page,
}) => {
  const db = openDb();
  let itemId: number | null = null;
  try {
    itemId = seedSupplement(db, FORM_NAME);
    seedDose(db, itemId, "1 cap", null);

    await page.goto("/nutrition?tab=supplements");
    const row = doseCard(page, FORM_NAME);
    await expect(row).toHaveCount(1);
    await settledClick(
      page,
      row.getByRole("button", { name: "Supplement actions" })
    );
    await settledClick(page, page.getByRole("menuitem", { name: "Edit" }));
    const editForm = page.getByRole("dialog", { name: `Edit ${FORM_NAME}` });

    const editor = editForm.getByTestId("cadence-editor");
    await expect(editor).toBeVisible();
    // It starts on the stored value — a daily item reads as daily rather than blank.
    await expect(editor.getByLabel("How often")).toHaveValue("daily");

    // Choose weekly, then pick TODAY's weekday. The chips are toggles, so the picked
    // state is readable from aria-pressed rather than from styling. Today's day is
    // chosen deliberately: any other would make the item off-cadence the moment it
    // saved, and it would correctly leave the due bucket — right behavior, but it would
    // turn this round-trip check into a test of where the row moves to.
    const dow = todayWeekday();
    await settledSelect(page, editor.getByLabel("How often"), "weekly");
    const chip = editor.getByTestId(`cadence-weekday-${dow}`);
    await expect(chip).toBeVisible();
    await settledClick(page, chip);
    await expect(chip).toHaveAttribute("aria-pressed", "true");

    // Save. The submit rides a Server Action's full-page re-render, which on a loaded
    // runner is the slow path — a NAMED ceiling, never a sleep.
    await settledClick(
      page,
      editForm.getByRole("button", { name: "Save", exact: true })
    );
    await expect(editForm).toHaveCount(0, { timeout: 20_000 });

    // Stored, and stored canonically. Read straight from SQLite: the dialog only
    // closes after the Server Action has returned, so the write has already committed
    // by the time the assertion above passed — no polling needed.
    const stored = db
      .prepare(
        "SELECT cadence_kind, cadence_weekdays FROM intake_items WHERE id = ?"
      )
      .get(itemId) as {
      cadence_kind: string;
      cadence_weekdays: string | null;
    };
    expect(stored.cadence_kind).toBe("weekly");
    expect(stored.cadence_weekdays).toBe(String(dow));

    // And it round-trips back INTO the form rather than resetting to daily.
    await page.goto("/nutrition?tab=supplements");
    const again = doseCard(page, FORM_NAME);
    await expect(again).toHaveCount(1);
    await settledClick(
      page,
      again.getByRole("button", { name: "Supplement actions" })
    );
    await settledClick(page, page.getByRole("menuitem", { name: "Edit" }));
    const reopened = page.getByRole("dialog", { name: `Edit ${FORM_NAME}` });
    await expect(
      reopened.getByTestId("cadence-editor").getByLabel("How often")
    ).toHaveValue("weekly");
    await expect(
      reopened
        .getByTestId("cadence-editor")
        .getByTestId(`cadence-weekday-${dow}`)
    ).toHaveAttribute("aria-pressed", "true");
  } finally {
    dropItem(db, itemId);
    db.close();
  }
});
