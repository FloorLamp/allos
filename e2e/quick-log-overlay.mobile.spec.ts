import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  expectPhoneTapTargets,
  hydratedClick,
  openMeasurementGroup,
  openMobileDrawer,
  settledClick,
  settledFill,
  stageMediaFiles,
} from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { loginAs, openCommandPalette } from "./nav";
import type { QuickLogId } from "@/lib/quick-log";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_SHELL,
  SHELL_PROFILE,
  SHELL_WEIGHT_KG,
  SHELL_DOSE_ITEM,
  SHELL_PRACTICE,
  E2E_LOGIN_MULTI,
  MULTI_OWNER_PROFILE,
  MULTI_SHARED_PROFILE,
} from "./fixture-logins";
import { frozenNow, workerDbPath } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { zonedDateParts } from "@/lib/date";

// The run's rotating instance timezone: `practice_logs.start_time` is a profile-LOCAL wall
// clock, so the expected minute has to be read in the same zone the app writes it in.
const PINNED_TZ = pinnedTimezone(frozenNow().toISOString()).zone;

// Every quick-log item opens an IN-PLACE overlay (issues #1468, #1467).
//
// The regression class: the #1416 sheet shipped two-tier — activity opened its
// editor in place, but food / dose / weight were `router.push`es. So a sheet
// promising "log from anywhere" answered a mid-morning weigh-in by teleporting
// you to the Trends page. Returning you to where you were IS the feature, and
// that is what this spec pins: after a save you are still on the dashboard, the
// toast fired, the sheet is gone — and the write is REAL (asserted from
// server-rendered state after a reload, never from the toast alone, which proves
// only that a promise resolved).
//
// Fixture hygiene (#868): this spec OWNS the Mobile Shell fixture — a dedicated
// write-granted login on an otherwise-empty profile, in its own cookie context.
// Every assertion is by VALUE, never a count, and the one piece of mutable state
// it depends on (the seeded dose's log rows) is cleared at test start, so
// --repeat-each and re-runs start from the same place.

// A raw context from loginAs does NOT inherit the `mobile` project's `use` block,
// so the phone viewport has to be restated or this silently runs at desktop width
// where the mobile bar does not render at all (dashboard-now.mobile.spec.ts's
// documented gotcha).
const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

function openDb(): Database.Database {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  return db;
}

// The seeded dose's id on this spec's own profile.
function shellDoseId(): number {
  const db = openDb();
  try {
    return (
      db
        .prepare(
          `SELECT d.id AS id
             FROM intake_item_doses d
             JOIN intake_items i ON i.id = d.item_id
            WHERE i.profile_id = (SELECT id FROM profiles WHERE name = ?)
              AND i.name = ?`
        )
        .get(SHELL_PROFILE, SHELL_DOSE_ITEM) as { id: number }
    ).id;
  } finally {
    db.close();
  }
}

// This spec's own profile id — the scope for its practice/document cleanup.
function shellProfileId(): number {
  const db = openDb();
  try {
    return (
      db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(SHELL_PROFILE) as {
        id: number;
      }
    ).id;
  } finally {
    db.close();
  }
}

// The practice sessions and uploaded documents this spec writes. Cleared at test start
// AND after, so --repeat-each and a re-run after a failure both begin from "none" —
// every practice assertion below is then about the session the test itself logged.
// The single practice row this spec's tap wrote, for the #2204 assertions that are
// about the STORE rather than about the screen.
function readShellPracticeLog(): {
  start_time: string | null;
  duration_min: number | null;
} {
  const db = openDb();
  try {
    return db
      .prepare(
        `SELECT start_time, duration_min FROM practice_logs
          WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(shellProfileId()) as {
      start_time: string | null;
      duration_min: number | null;
    };
  } finally {
    db.close();
  }
}

function clearShellPracticeLogs(): void {
  const db = openDb();
  try {
    db.prepare("DELETE FROM practice_logs WHERE profile_id = ?").run(
      shellProfileId()
    );
  } finally {
    db.close();
  }
}

function clearShellDocuments(prefix: string): void {
  const db = openDb();
  try {
    db.prepare(
      "DELETE FROM medical_documents WHERE profile_id = ? AND filename LIKE ?"
    ).run(shellProfileId(), `${prefix}%`);
  } finally {
    db.close();
  }
}

function clearShellFoodGroup(groupKey: string): void {
  const db = openDb();
  try {
    const profileId = shellProfileId();
    const date = frozenNow().toISOString().slice(0, 10);
    const clear = db.transaction(() => {
      db.prepare(
        "DELETE FROM food_log_events WHERE profile_id = ? AND date = ? AND group_key = ?"
      ).run(profileId, date, groupKey);
      db.prepare(
        "DELETE FROM food_daily_totals WHERE profile_id = ? AND date = ? AND group_key = ?"
      ).run(profileId, date, groupKey);
    });
    clear();
  } finally {
    db.close();
  }
}

function profileIdByName(name: string): number {
  const db = openDb();
  try {
    return (
      db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
        id: number;
      }
    ).id;
  } finally {
    db.close();
  }
}

function clearProfileFoodGroup(profileId: number, groupKey: string): void {
  const db = openDb();
  try {
    const date = frozenNow().toISOString().slice(0, 10);
    db.transaction(() => {
      db.prepare(
        "DELETE FROM food_log_events WHERE profile_id = ? AND date = ? AND group_key = ?"
      ).run(profileId, date, groupKey);
      db.prepare(
        "DELETE FROM food_daily_totals WHERE profile_id = ? AND date = ? AND group_key = ?"
      ).run(profileId, date, groupKey);
    })();
  } finally {
    db.close();
  }
}

function profileFoodCount(profileId: number, groupKey: string): number {
  const db = openDb();
  try {
    const date = frozenNow().toISOString().slice(0, 10);
    const row = db
      .prepare(
        "SELECT servings FROM food_daily_totals WHERE profile_id = ? AND date = ? AND group_key = ?"
      )
      .get(profileId, date, groupKey) as { servings: number } | undefined;
    return row?.servings ?? 0;
  } finally {
    db.close();
  }
}

function addExternalShellFoodServing(groupKey: string, mealSlot: string): void {
  const db = openDb();
  try {
    const profileId = shellProfileId();
    const date = frozenNow().toISOString().slice(0, 10);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO food_daily_totals (profile_id, date, group_key, servings)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(profile_id, date, group_key)
         DO UPDATE SET servings = servings + 1`
      ).run(profileId, date, groupKey);
      db.prepare(
        `INSERT INTO food_log_events
           (profile_id, group_key, date, recorded_at, meal_slot, logged_via)
         VALUES (?, ?, ?, ?, ?, 'page')`
      ).run(
        profileId,
        groupKey,
        date,
        new Date(frozenNow().getTime() + 60_000).toISOString(),
        mealSlot
      );
    })();
  } finally {
    db.close();
  }
}

// Clear the shell profile's check-ins so the mood test owns its rows (#868).
function clearShellMoodLogs(): void {
  const db = openDb();
  try {
    db.prepare("DELETE FROM mood_logs WHERE profile_id = ?").run(
      shellProfileId()
    );
  } finally {
    db.close();
  }
}

// The symptom day and the illness situation this spec's Care-row test writes. Cleared
// before AND after, so --repeat-each and a re-run after a failure both start from
// "nothing logged, nothing tracked" — which is also the Mobile Shell fixture's own
// seeded state, so the reset restores it rather than inventing one.
function clearShellSymptomState(): void {
  const db = openDb();
  try {
    const id = shellProfileId();
    const clear = db.transaction(() => {
      db.prepare("DELETE FROM symptom_logs WHERE profile_id = ?").run(id);
      db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(id);
      db.prepare("DELETE FROM situations WHERE profile_id = ?").run(id);
      db.prepare(
        "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'situation_events'"
      ).run(id);
    });
    clear();
  } finally {
    db.close();
  }
}

// Today's logged severity for one symptom, from the store every symptom surface reads.
function shellSymptomSeverity(symptom: string): number | null {
  const db = openDb();
  try {
    const row = db
      .prepare(
        "SELECT severity FROM symptom_logs WHERE profile_id = ? AND symptom = ?"
      )
      .get(shellProfileId(), symptom) as { severity: number } | undefined;
    return row?.severity ?? null;
  } finally {
    db.close();
  }
}

// The situations currently flagged illness-type AND active — what the panel's resolved
// verb is read from.
function shellActiveIllnessSituations(): string[] {
  const db = openDb();
  try {
    return (
      db
        .prepare(
          `SELECT name FROM situations
            WHERE profile_id = ? AND active = 1 AND illness_type = 1
            ORDER BY name`
        )
        .all(shellProfileId()) as { name: string }[]
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

// Clear the dose's logs so it is DUE again — the one mutable precondition.
function clearDoseLogs(doseId: number): void {
  const db = openDb();
  try {
    db.prepare("DELETE FROM intake_item_logs WHERE dose_id = ?").run(doseId);
  } finally {
    db.close();
  }
}

// Flip the seeded dose's `retired` flag behind the app's back — "the schedule was
// edited on another device while your sheet was open". Deliberately chosen over
// writing an intake_item_logs row for a computed date: the suite runs on a FROZEN
// clock that can legitimately sit on the other side of midnight from SQL's
// `date('now')` (#1464), so a hand-computed date is a latent flake. `retired` is
// date-free, and it exercises the same rule — markDoseTaken writes nothing, so
// the confirm must not claim it did.
function setDoseRetired(doseId: number, retired: boolean): void {
  const db = openDb();
  try {
    db.prepare("UPDATE intake_item_doses SET retired = ? WHERE id = ?").run(
      retired ? 1 : 0,
      doseId
    );
  } finally {
    db.close();
  }
}

// A SECOND dose row on the seeded item, so one time-of-day bucket holds two and the
// #3936 whole-stack row has something to promise. Backdated like its sibling in the
// seed: the lifetime clamp scores a day only against the doses that existed on it, so
// a row created now would be correctly absent from every past day. Added and removed inside the test
// that needs it — the shared seed keeps its one-dose shape for every other test here.
function addShellDose(timeOfDay: string): number {
  const db = openDb();
  try {
    const itemId = (
      db
        .prepare("SELECT item_id AS id FROM intake_item_doses WHERE id = ?")
        .get(shellDoseId()) as { id: number }
    ).id;
    return Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
           VALUES (?, '1 tablet', ?, 'any', 1, '2026-01-01 08:00:00')`
        )
        .run(itemId, timeOfDay).lastInsertRowid
    );
  } finally {
    db.close();
  }
}

function removeShellDose(doseId: number): void {
  const db = openDb();
  try {
    db.prepare("DELETE FROM intake_item_doses WHERE id = ?").run(doseId);
  } finally {
    db.close();
  }
}

// The dose's whole ledger, as (date, status) pairs — asserted BY VALUE against the day
// the sheet itself named, never against a date this file computed.
function doseLogRows(doseId: number): { date: string; status: string }[] {
  const db = openDb();
  try {
    return db
      .prepare(
        "SELECT date, status FROM intake_item_logs WHERE dose_id = ? ORDER BY date"
      )
      .all(doseId) as { date: string; status: string }[];
  } finally {
    db.close();
  }
}

async function signIn(browser: Parameters<typeof loginAs>[0]): Promise<Page> {
  return loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
}

// Open the quick-log sheet, reveal the segment holding `itemId`, and tap the row.
//
// The extra step is #2651's segmented long tail: a row lives in the DOM only
// while its own segment is selected. `showLogRow` asserts that precondition
// rather than tolerating it (e2e/log-sheet-helpers.ts), so these tests still
// fail if the sheet ever stops segmenting. What each test below is ABOUT — that
// the row opens a real form in place and the write lands — is unchanged by it.
async function openQuickEntry(page: Page, itemId: QuickLogId) {
  const sheet = await openLogSheet(page);
  const row = await showLogRow(sheet, itemId);
  await row.click();
  await expect(sheet).toHaveCount(0);
  const overlay = page.getByTestId("quick-entry-sheet");
  await expect(overlay).toBeVisible();
  return overlay;
}

test("a weight logged from the dashboard sheet stays put, toasts, and persists", async ({
  browser,
}) => {
  const page = await signIn(browser);
  try {
    await page.goto("/");
    const dashboardUrl = page.url();

    const overlay = await openQuickEntry(page, "log-measurements");
    // The overlay mounts the EXISTING MeasurementsQuickAdd — same element ids the
    // Trends page's mount carries, because it is the same component, not a copy.
    // The sheet row carries no context, so the form opens Vitals (#2014): a weight
    // is in Body, one tap away.
    const form = overlay.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    await openMeasurementGroup(page, form, "body");
    const weight = overlay.locator("#m-weight");
    await expect(weight).toBeVisible();
    await weight.fill(SHELL_WEIGHT_KG);

    await settledClick(
      page,
      overlay.getByRole("button", { name: "Save measurements" })
    );

    // After save: overlay closed, toast shown, STAY PUT. All three matter — the
    // last one is the issue.
    await expect(page.getByText("Measurements saved")).toBeVisible();
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    expect(page.url()).toBe(dashboardUrl);

    // Durable, and asserted from SERVER-rendered state rather than the toast: a
    // resolved promise is not a committed row. The reload proves the dashboard
    // survives it too (we are still where we started, freshly rendered).
    await page.reload();
    expect(page.url()).toBe(dashboardUrl);

    // AND THE SHEET REMEMBERS (#2068). Same context-free row, no deep link and no
    // prefill — but this profile last wrote a Body reading, so the form now opens
    // Body instead of the Vitals default it opened above. This is the half of the
    // #2014 disclosure that had no browser test: every existing spec covered the
    // fallback or an explicit `defaultGroup`.
    const remembered = await openQuickEntry(page, "log-measurements");
    const rememberedForm = remembered.getByTestId("measurements-quick-add");
    await expect(rememberedForm).toBeVisible();
    await expect(
      rememberedForm.getByTestId("measurements-group-body-toggle")
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      rememberedForm.getByTestId("measurements-group-vitals-toggle")
    ).toHaveAttribute("aria-expanded", "false");
    await expect(remembered.locator("#m-weight")).toBeVisible();

    await page.goto("/trends?view=all");
    await expect(page.getByTestId("body-history-table")).toContainText(
      SHELL_WEIGHT_KG
    );
  } finally {
    await page.context().close();
  }
});

// #2068: the SAME memory, on the offline path. `rememberGroup` was called only on
// the online success branch, so a reading queued with no signal taught the form
// nothing — the sheet kept reopening on Vitals for someone whose every entry was a
// weight. Queueing is saving from where the person is standing, so it remembers too.
// (The replay itself is offline-queue.spec.ts's subject; here it is only the wait
// that lets the sheet — which loads through a Server Action — be reopened.)
test("a measurement QUEUED offline is remembered by the next sheet too", async ({
  browser,
}) => {
  const OFFLINE_WEIGHT_KG = "78.2";
  const page = await signIn(browser);
  const context = page.context();
  try {
    await page.goto("/");

    const overlay = await openQuickEntry(page, "log-measurements");
    const form = overlay.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    await openMeasurementGroup(page, form, "body");

    // Offline BEFORE the submit — the dead-reception moment, from the sheet rather
    // than from the Trends page mount.
    await context.setOffline(true);
    await overlay.locator("#m-weight").fill(OFFLINE_WEIGHT_KG);
    // A plain click, not settledClick: this submit deliberately posts NOTHING —
    // the queue is the whole point — so there is no Server Action response to
    // settle on. The toast is the honest signal, and it is the same one
    // offline-queue.spec.ts waits for.
    await overlay.getByRole("button", { name: "Save measurements" }).click();
    await expect(
      page.getByText("Saved offline — will sync when you reconnect.")
    ).toBeVisible();
    // The offline branch leaves the sheet open (there is no server round trip to
    // close on), so it is dismissed here rather than closing itself.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);

    await context.setOffline(false);
    await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0, {
      timeout: 20_000,
    });

    const reopened = await openQuickEntry(page, "log-measurements");
    await expect(
      reopened
        .getByTestId("measurements-quick-add")
        .getByTestId("measurements-group-body-toggle")
    ).toHaveAttribute("aria-expanded", "true");
  } finally {
    await page.context().close();
  }
});

test("the dose overlay answers from the outcome — it never just confirms", async ({
  browser,
}) => {
  const doseId = shellDoseId();
  clearDoseLogs(doseId);
  setDoseRetired(doseId, false);

  const page = await signIn(browser);
  try {
    await page.goto("/");
    const dashboardUrl = page.url();

    // #2744: the context chip answers "which dose?" from the SAME due item the
    // overlay will render; it no longer withholds the name behind a count.
    const sheet = await openLogSheet(page);
    const chip = sheet.getByTestId("log-sheet-chip-doses");
    await expect(chip).toHaveText(`Due: ${SHELL_DOSE_ITEM}`);
    await chip.click();
    await expect(sheet).toHaveCount(0);
    const overlay = page.getByTestId("quick-entry-sheet");
    await expect(overlay).toBeVisible();
    const row = overlay.getByTestId(`quick-entry-dose-${doseId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(SHELL_DOSE_ITEM);
    // The schedule changes elsewhere while this sheet still shows the dose as
    // due. The open sheet is a frozen snapshot; its button is about to describe a
    // world that no longer holds.
    setDoseRetired(doseId, true);
    await settledClick(page, row.getByRole("button", { name: "Mark taken" }));

    // THE assertion: it says what actually happened. markDoseTaken wrote nothing,
    // and claiming "Dose logged" here would be a false confirmation of a
    // possibly-critical medication — the #280 defect the DoseTakenOutcome union
    // exists to prevent.
    // Scoped to the toast: the same sentence also renders as the row's inline
    // note below, and an unscoped match would be two elements.
    await expect(page.getByTestId("toast")).toContainText("Not logged");
    await expect(page.getByText("Dose logged")).toHaveCount(0);
    // Nothing was logged, so the dose has NOT been resolved: the row stays, with
    // the reason beside it. Silently dropping it would be the same lie told
    // quietly.
    await expect(row).toBeVisible();
    await expect(
      overlay.getByTestId(`quick-entry-dose-note-${doseId}`)
    ).toBeVisible();
    expect(page.url()).toBe(dashboardUrl);

    // Restore the schedule and confirm for real. This time a log IS written, so the
    // row resolves and today's list empties.
    setDoseRetired(doseId, false);
    await page.reload();
    const fresh = await openQuickEntry(page, "log-dose");
    await settledClick(
      page,
      fresh
        .getByTestId(`quick-entry-dose-${doseId}`)
        .getByRole("button", { name: "Mark taken" })
    );
    await expect(page.getByText("Dose logged")).toBeVisible();
    // AND THE SHEET STAYS OPEN (#3936). It used to close here, and that was only ever
    // right while the window behind today was empty: this is a DAILY dose, so the two
    // days before today owe it too. Closing on today's emptiness would take the missed
    // days away with it — which is the whole thing the switcher exists to reach.
    await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
    await expect(fresh.getByTestId("quick-entry-dose-empty")).toBeVisible();
    await expect(
      fresh.getByTestId("quick-entry-dose-day-toggle").getByRole("button")
    ).toHaveCount(3);
    // No navigation, which is the #1468 rule this test is named for.
    expect(page.url()).toBe(dashboardUrl);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);

    // Durable, from SERVER-gathered state: reopening asks the due-dose computation
    // again, and TODAY no longer offers a dose that is taken.
    const reopened = await openQuickEntry(page, "log-dose");
    await expect(reopened.getByTestId("quick-entry-dose-empty")).toBeVisible();
    await expect(reopened.getByTestId("quick-entry-dose-list")).toHaveCount(0);
  } finally {
    clearDoseLogs(doseId);
    setDoseRetired(doseId, false);
    await page.context().close();
  }
});

// #3936. THE STACK ASYMMETRY IS THE COST THIS TEST IS ABOUT. For today the morning is
// one tap; for yesterday the same physical event used to decompose into N item
// traversals with N date/time forms, so a forgotten day simply stayed unlogged and the
// adherence record lied. What is asserted here is the whole claim in one run: the sheet
// offers exactly three days, a switched day's rows carry BOTH verbs, and the write lands
// on THE DAY THE SHEET NAMED rather than on today.
test("the dose sheet logs a missed day, on the day it names", async ({
  browser,
}) => {
  const doseId = shellDoseId();
  clearDoseLogs(doseId);
  // A second dose in the same bucket, so the bucket earns its whole-stack row. Removed
  // in `finally`, so --repeat-each starts from the seeded one-dose state every time.
  const secondDoseId = addShellDose("08:05");

  const page = await signIn(browser);
  try {
    await page.goto("/");
    const overlay = await openQuickEntry(page, "log-dose");

    // EXACTLY the accepted window — three days, today first. A fourth segment would be
    // a wider window than the write cores accept, and two would hide a day they do.
    const toggle = overlay.getByTestId("quick-entry-dose-day-toggle");
    await expect(toggle.getByRole("button")).toHaveCount(3);
    await expect(overlay.getByTestId("quick-entry-dose-day-0")).toHaveText(
      "Today"
    );
    await expect(overlay.getByTestId("quick-entry-dose-day-1")).toHaveText(
      "Yesterday"
    );

    await overlay.getByTestId("quick-entry-dose-day-1").click();
    const day = overlay.getByTestId("quick-entry-dose-day");
    await expect(day).toBeVisible();
    // The day the sheet says it is writing, taken from the sheet rather than computed
    // here — the whole assertion below is that the write agrees with this string.
    const named = await day.getAttribute("data-date");
    expect(named).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The bucket's whole-stack row names both doses and writes exactly them.
    const stack = day.getByTestId("quick-entry-dose-stack-Anytime");
    await expect(stack).toContainText("Anytime stack (2)");
    await expect(stack).toHaveAttribute(
      "data-doses",
      `${doseId},${secondDoseId}`
    );
    await settledClick(page, stack);
    await expect(page.getByTestId("toast")).toContainText("2 doses logged");

    // THE assertion, from the ledger: both rows landed on the day the sheet named, and
    // nothing at all was written for today.
    expect(doseLogRows(doseId)).toEqual([{ date: named, status: "taken" }]);
    expect(doseLogRows(secondDoseId)).toEqual([
      { date: named, status: "taken" },
    ]);
    const todayStr = frozenNow().toISOString().slice(0, 10);
    expect(named).not.toBe(todayStr);

    // Durable and server-derived: the day is settled now, and reopening says so
    // instead of re-offering doses that are already resolved.
    await page.reload();
    const again = await openQuickEntry(page, "log-dose");
    await again.getByTestId("quick-entry-dose-day-1").click();
    await expect(again.getByTestId("quick-entry-dose-day-empty")).toBeVisible();
  } finally {
    clearDoseLogs(doseId);
    clearDoseLogs(secondDoseId);
    removeShellDose(secondDoseId);
    await page.context().close();
  }
});

test("the food and vitals overlays mount the same forms their pages carry", async ({
  browser,
}) => {
  const page = await signIn(browser);
  try {
    await page.goto("/");

    // Food: the Nutrition tab's own FoodLogBar, scoped to the overlay body so
    // this can never accidentally assert the page's copy.
    const food = await openQuickEntry(page, "log-food");
    const foodBody = page.getByTestId("quick-entry-body");
    await expect(foodBody).toHaveAttribute("data-form", "food");
    await expect(foodBody.getByTestId("food-log-bar")).toBeVisible();
    // The protein entry is ranked in only for a profile that tracks protein (#1980),
    // and this fixture profile logs none — so the compact sheet offers no gram box. The
    // Food tab stays the complete surface where those grams are first entered.
    await expect(foodBody.getByTestId("protein-quickadd")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(food).toHaveCount(0);

    // Measurements — the ONE row (#1486/#1506) that replaced the former weight +
    // vitals pair, opening the SAME MeasurementsQuickAdd the Trends surfaces mount
    // (no second form was written for the sheet).
    const vitals = await openQuickEntry(page, "log-measurements");
    const vitalsBody = page.getByTestId("quick-entry-body");
    await expect(vitalsBody).toHaveAttribute("data-form", "measurements");
    await expect(
      vitalsBody.getByTestId("measurements-quick-add")
    ).toBeVisible();

    // And a reading submitted from here lands: the toast fires only after
    // addMeasurements returned, so the write reached the same server action the
    // page mount uses. (That action's persistence is already pinned by the action
    // tier and manual-vitals.spec.ts — a mount, not a new write path.)
    await openMeasurementGroup(
      page,
      vitalsBody.getByTestId("measurements-quick-add"),
      "vitals"
    );
    await vitals.locator("#m-systolic").fill("118");
    await vitals.locator("#m-diastolic").fill("76");
    await settledClick(
      page,
      vitals.getByRole("button", { name: "Save measurements" })
    );
    await expect(page.getByText("Measurements saved")).toBeVisible();
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await page.context().close();
  }
});

test("food serving taps settle, roll one cumulative Undo toast, and undo only the latest tap (#3611)", async ({
  browser,
}) => {
  const group = "cruciferous";
  clearShellFoodGroup(group);
  const page = await signIn(browser);
  try {
    await page.goto("/");
    const food = await openQuickEntry(page, "log-food");
    const row = food.getByTestId(`food-group-${group}`);
    if (!(await row.isVisible())) {
      await food.getByTestId("food-more-groups-summary").click();
    }
    await expect(row).toBeVisible();

    const add = row.getByTestId(`log-${group}`);
    const settle = row.getByTestId(`food-settle-${group}`);
    const count = row.getByTestId(`count-${group}`);
    const rolling = row.getByTestId(`rolling-count-${group}`);
    await expect(count).toHaveText("0");

    // Additive means additive even inside the former cooldown window. The one
    // quiet slot is the TOAST: each authoritative result upgrades it in place.
    // Arm the transient checks before tapping: these prove the normal-motion
    // implementation actually enters both one-shot bands, not merely that the
    // components publish static declarations.
    const sawSettle = expect(settle).toHaveAttribute("data-settling", "true");
    const sawRoll = expect(rolling).toHaveAttribute("data-rolling", "true");
    await add.click();
    await add.click();
    await add.click();
    await Promise.all([sawSettle, sawRoll]);
    await expect(count).toHaveText("3");
    await expect(settle).toHaveAttribute("data-motion", "settle");
    await expect(rolling).toHaveAttribute("data-motion", "count");

    const toast = page.locator(
      `[data-toast-key^="food-serving:"][data-toast-key$=":${frozenNow().toISOString().slice(0, 10)}:${group}"]`
    );
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText(
      "3 servings of Cruciferous vegetables today"
    );
    await settledClick(page, toast.getByRole("button", { name: "Undo" }));
    await expect(count).toHaveText("2");

    // Reduced motion changes only the path to the end state. The same write,
    // cumulative toast, and guarded Undo remain; both motion tenants publish the
    // branch the browser took.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await add.click();
    await expect(count).toHaveText("3");
    await expect(settle).toHaveAttribute("data-reduced-motion", "true");
    await expect(settle).not.toHaveClass(/motion-settle/);
    await expect(rolling).toHaveAttribute("data-reduced-motion", "true");
    await expect(rolling).toHaveAttribute("data-rolling", "false");
    await expect(toast).toContainText(
      "3 servings of Cruciferous vegetables today"
    );
    await settledClick(page, toast.getByRole("button", { name: "Undo" }));
    await expect(count).toHaveText("2");

    // A different client advances the same coordinate after this receipt is
    // offered. The guarded inverse refuses, and one fresh day + meal truth read
    // repairs this stale tab instead of keeping the add render's old 2.
    await add.click();
    await expect(toast).toContainText(
      "3 servings of Cruciferous vegetables today"
    );
    const mealSlot =
      (await food.getByTestId("food-slot-chip").getAttribute("data-slot")) ??
      "Morning";
    addExternalShellFoodServing(group, mealSlot);
    await settledClick(page, toast.getByRole("button", { name: "Undo" }));
    await expect(count).toHaveText("4");
    await expect(toast).toContainText(
      "Couldn’t undo — this has changed since."
    );
  } finally {
    clearShellFoodGroup(group);
    await page.context().close();
  }
});

test("switching profiles clears the originating food receipt and cannot target its peer (#3611)", async ({
  browser,
}) => {
  const group = "nuts_seeds";
  const ownerId = profileIdByName(MULTI_OWNER_PROFILE);
  const sharedId = profileIdByName(MULTI_SHARED_PROFILE);
  clearProfileFoodGroup(ownerId, group);
  clearProfileFoodGroup(sharedId, group);
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_MULTI, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
  try {
    await page.goto("/");
    // The acting profile reads from the DRAWER's identity bar since #4102 — the
    // phone top bar that used to carry it retired — so it is opened, read, and shut
    // again before the food entry, leaving the receipt to be raised from a clean
    // screen exactly as before.
    const opening = await openMobileDrawer(page);
    await expect(opening.getByTestId("profile-identity-bar")).toContainText(
      MULTI_OWNER_PROFILE
    );
    await page.keyboard.press("Escape");
    await expect(opening).toHaveCount(0);
    const food = await openQuickEntry(page, "log-food");
    const row = food.getByTestId(`food-group-${group}`);
    if (!(await row.isVisible())) {
      await food.getByTestId("food-more-groups-summary").click();
    }
    await settledClick(page, row.getByTestId(`log-${group}`));
    await expect(
      page.locator('[data-toast-key^="food-serving:"]')
    ).toContainText("1 serving of Nuts & seeds today");
    await page.keyboard.press("Escape");
    await expect(food).toHaveCount(0);

    // THE SWITCH ITSELF, through the drawer — the switcher moved there with the
    // identity bar when the phone top bar retired (#4102).
    //
    // A CONTROL WAS TRIED HERE AND DELIBERATELY REMOVED. The switcher used to be one
    // tap away on the bar; it is now behind a drawer open, so the natural worry is
    // that the toast could be cleared by the DRAWER rather than by the switch, and
    // the obvious guard is to re-assert the toast once the drawer is up. Measured:
    // that assertion fails, because the snackbar's own TTL expires across the extra
    // step. It was therefore reading toast LIFETIME, not drawer behaviour — a race
    // dressed as a control, and the kind that gets re-run until it is green.
    // The real claim is already pinned below and is not time-dependent: the write
    // landed on the ORIGINATING profile and none landed on its peer, read from the
    // database. That is what #3611 is about; the toast's disappearance is a symptom.
    const drawer = await openMobileDrawer(page);
    const switcher = drawer.getByTestId("profile-identity-bar");
    await expect(switcher).toBeEnabled();
    await switcher.click();
    await settledClick(
      page,
      drawer
        .getByTestId("profile-switcher-panel")
        .getByTestId(`switch-to-${sharedId}`)
    );
    await expect(page.locator('[data-toast-key^="food-serving:"]')).toHaveCount(
      0
    );
    const after = await openMobileDrawer(page);
    await expect(after.getByTestId("profile-identity-bar")).toContainText(
      MULTI_SHARED_PROFILE
    );
    expect(profileFoodCount(ownerId, group)).toBe(1);
    expect(profileFoodCount(sharedId, group)).toBe(0);
  } finally {
    clearProfileFoodGroup(ownerId, group);
    clearProfileFoodGroup(sharedId, group);
    await page.context().close();
  }
});

// Tap "Log another" through the same-day re-log confirm the sheet asks on every tap
// after the first (#2007 layer 3 / #798: informational, never permissive).
async function logAnother(page: Page, row: Locator): Promise<void> {
  await hydratedClick(page, row.getByTestId("practice-log-button"));
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await settledClick(page, dialog.getByRole("button", { name: "Log session" }));
}

// #3273 — the sheet can now STATE when a session happened.
//
// The gap this closes: the sheet mounts LogPracticeButton without `showDetails` (a
// modal over a one-tap sheet is not what that surface is for), and the time lived only
// in that modal — so a 07:00 sauna logged at 09:00 wore 09:00 forever and #4009's
// correction had to repair it. The property that matters is the PAIR: a stated minute
// is what the row carries, and an untouched sheet still writes the tap instant.
test("the sheet states an earlier session time, and an untouched tap still writes the tap instant (#3273)", async ({
  browser,
}) => {
  clearShellPracticeLogs();

  const page = await signIn(browser);
  try {
    await page.goto("/");
    const overlay = await openQuickEntry(page, "log-practice");
    const row = overlay
      .getByTestId("quick-entry-practice-list")
      .getByRole("listitem")
      .filter({ hasText: SHELL_PRACTICE });
    await expect(row).toBeVisible();

    // COLLAPSED and empty: the fast path is one tap and nothing is stated until the
    // affordance is opened, so the control is not even in the DOM.
    const toggle = row.getByTestId("practice-when-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(row.getByTestId("practice-when-time")).toHaveCount(0);

    // Leg 1 — the untouched tap. It must write what it wrote before this control
    // existed: the tap instant's profile-local wall minute, off the app's clock seam.
    await settledClick(page, row.getByTestId("practice-log-button"));
    await expect(row.getByTestId("practice-today-count")).toContainText(
      "1 session logged"
    );
    expect(readShellPracticeLog().start_time).toBe(
      zonedDateParts(PINNED_TZ, frozenNow()).hhmm
    );

    // Leg 2 — the statement. Absolute local time, on the day the sheet is filing to;
    // the day half is fixed, so a statement can only move the minute.
    await hydratedClick(page, toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByTestId("practice-when-date")).toHaveText("Today");
    await settledFill(page, row.getByTestId("practice-when-time"), "07:05");
    // A second same-day tap ASKS (#2007 layer 3) — a genuine second session is
    // legitimate, so the dialog's default is to proceed.
    await logAnother(page, row);
    await expect(row.getByTestId("practice-today-count")).toContainText(
      "2 sessions logged"
    );
    expect(readShellPracticeLog().start_time).toBe("07:05");

    // THE STATEMENT IS SPENT BY THE TAP IT ANSWERS. Multi-session days are the point
    // of this surface, so a surviving 07:05 would stamp the evening's session with the
    // morning's time — the field empties in front of the user.
    await expect(row.getByTestId("practice-when-time")).toHaveValue("");
    await logAnother(page, row);
    await expect(row.getByTestId("practice-today-count")).toContainText(
      "3 sessions logged"
    );
    expect(readShellPracticeLog().start_time).toBe(
      zonedDateParts(PINNED_TZ, frozenNow()).hhmm
    );
  } finally {
    clearShellPracticeLogs();
    await page.close();
  }
});

test("a practice logs in one tap from the sheet and the week count moves", async ({
  browser,
}) => {
  // #1633: the Telegram bot has had one-tap practice logging since #1259 while the web
  // app made you find /wellness first. This is the web catching up — and the assertion
  // that matters is the LAST one: the session reached the same store the Wellness card
  // counts, not merely a toast that resolved.
  clearShellPracticeLogs();

  const page = await signIn(browser);
  try {
    await page.goto("/");
    const dashboardUrl = page.url();

    const overlay = await openQuickEntry(page, "log-practice");
    const row = overlay
      .getByTestId("quick-entry-practice-list")
      .getByRole("listitem")
      .filter({ hasText: SHELL_PRACTICE });
    await expect(row).toBeVisible();
    // The week standing the Wellness card shows, from the same computation.
    await expect(row).toContainText("No days this week");
    await expect(row).toContainText("Target 3×/week");
    await expect(row.getByTestId("practice-today-count")).toContainText(
      "No sessions yet"
    );

    // #2204: the row carries an INLINE duration control. The standing objection was
    // to stacking the expanded date/time/duration MODAL over a one-tap sheet, and it
    // still holds — nothing here opens one, and there is no trigger to open one with.
    const duration = row.getByTestId("practice-duration-input");
    await expect(row.getByTestId("practice-inline-duration")).toBeVisible();
    await expect(page.getByTestId("practice-log-details")).toHaveCount(0);
    await expect(page.getByTestId("practice-log-details-trigger")).toHaveCount(
      0
    );
    // Nothing logged yet, so nothing is prefilled: the app does not invent a duration
    // for a practice with no history and no declared default.
    await expect(duration).toHaveValue("");
    // Four taps of + reach 20 minutes without a keyboard.
    for (let i = 0; i < 4; i++)
      await hydratedClick(page, row.getByTestId("practice-duration-up"));
    await expect(duration).toHaveValue("20");
    // ...and stepping down is the way back, including off the bottom to blank.
    await hydratedClick(page, row.getByTestId("practice-duration-down"));
    await expect(duration).toHaveValue("15");
    for (let i = 0; i < 3; i++)
      await hydratedClick(page, row.getByTestId("practice-duration-down"));
    await expect(duration).toHaveValue("");
    for (let i = 0; i < 4; i++)
      await hydratedClick(page, row.getByTestId("practice-duration-up"));
    await expect(duration).toHaveValue("20");

    await settledClick(page, row.getByTestId("practice-log-button"));

    // Answered from the typed outcome, and you are STILL on the dashboard: the sheet
    // deliberately stays open (a morning check may log a second practice), with the
    // row's own count updated in place.
    await expect(page.getByTestId("toast")).toContainText(
      "Logged today's session"
    );
    await expect(row.getByTestId("practice-today-count")).toContainText(
      "1 session logged"
    );
    expect(page.url()).toBe(dashboardUrl);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);

    // The ONE tap wrote what the row was showing (#2204). Read from the store, not
    // from the toast: the duration the stepper held, and a non-null time — the quick
    // path used to write null there, starving the very rhythm inference (#2202) that
    // reschedules this practice's own nudge.
    const logged = readShellPracticeLog();
    expect(logged.duration_min).toBe(20);
    expect(logged.start_time).toMatch(/^\d{2}:\d{2}$/);

    // Durable, and from SERVER-rendered state: the Wellness card's week count moved,
    // which is only true if the tap wrote through the shared practice store.
    await page.goto("/wellness");
    const card = page
      .getByTestId("wellness-practice-card")
      .filter({ hasText: SHELL_PRACTICE });
    await expect(card).toContainText("1 day this week");

    // And the NEXT prefill is the value that was LOGGED, so accepting it a second
    // time costs zero taps.
    await page.goto("/");
    const again = await openQuickEntry(page, "log-practice");
    await expect(
      again
        .getByTestId("quick-entry-practice-list")
        .getByRole("listitem")
        .filter({ hasText: SHELL_PRACTICE })
        .getByTestId("practice-duration-input")
    ).toHaveValue("20");
  } finally {
    clearShellPracticeLogs();
    await page.context().close();
  }
});

test("the mood row logs a check-in in place — and 'Yesterday' backfills the missed day (#2130/#2128)", async ({
  browser,
}) => {
  // #2130 made mood a sheet member (the last daily-loop one-tap log without a
  // row), and #2128 gave the entry path a day: the overlay mounts the SAME
  // MoodValencePicker over the SAME logMood upsert the dashboard card runs, with
  // the backfill chips choosing the day. The assertion that matters is the last
  // one: the row landed in mood_logs ON the chip's own date.
  clearShellMoodLogs();

  const page = await signIn(browser);
  try {
    await page.goto("/");
    const dashboardUrl = page.url();

    const overlay = await openQuickEntry(page, "log-mood");
    const checkin = overlay.getByTestId("quick-mood-checkin");
    await expect(checkin).toBeVisible();
    const moodChoices = Array.from({ length: 5 }, (_, index) =>
      checkin.getByTestId(`quick-mood-tap-${index + 1}`)
    );
    for (const choice of moodChoices) {
      await expect(choice).toHaveAttribute("data-icon-button", "");
    }
    await expectPhoneTapTargets(page, "mood choices", moodChoices, {
      disjoint: true,
    });

    // The overlay renders only after its on-open gather resolved, so the chips
    // are hydrated client state by the time they are visible.
    const yesterdayChip = checkin.getByTestId("quick-mood-day-1");
    await expect(yesterdayChip).toHaveText("Yesterday");
    const yesterdayDate = await yesterdayChip.getAttribute("data-date");
    expect(yesterdayDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await yesterdayChip.click();
    await expect(yesterdayChip).toHaveAttribute("aria-pressed", "true");

    // One tap writes and closes the sheet (a check-in is a transaction with an
    // end); you are still on the dashboard.
    await settledClick(page, checkin.getByTestId("quick-mood-tap-4"));
    await expect(page.getByTestId("toast")).toContainText("Logged Good");
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    expect(page.url()).toBe(dashboardUrl);

    // Durable, from the store every mood surface reads: one row, on the chip's
    // own date — the day the user meant, not the day they remembered.
    const db = openDb();
    try {
      const rows = db
        .prepare(
          "SELECT date, valence FROM mood_logs WHERE profile_id = ? ORDER BY date"
        )
        .all(shellProfileId()) as { date: string; valence: number }[];
      expect(rows).toEqual([{ date: yesterdayDate, valence: 4 }]);
    } finally {
      db.close();
    }
  } finally {
    clearShellMoodLogs();
    await page.context().close();
  }
});

test("the symptom row logs a well day in place, and its illness verb resolves on open (#4064)", async ({
  browser,
}) => {
  // #4064, the precondition #3366 depends on: the dashboard tail's well-day card is
  // today the ONLY door to three writes — a symptom tap, the well-day capture (that
  // same tap with no illness required), and the mark-as-illness bridge. They may only
  // leave the tail once the sheet reaches them, so this is the coverage assertion.
  //
  // The overlay mounts the SAME SymptomLogBar the card mounts, over the same actions;
  // that the two POST identically is held at the action layer by
  // components/__tests__/quick-symptom-parity.test.tsx. What only a browser can say is
  // that the row is reachable from the puck, that the write is real, and that the
  // illness verb is resolved from server state ON OPEN rather than baked into the row.
  clearShellSymptomState();

  const page = await signIn(browser);
  try {
    await page.goto("/");
    const dashboardUrl = page.url();

    const overlay = await openQuickEntry(page, "log-symptom");
    const panel = overlay.getByTestId("quick-symptom-panel");
    await expect(panel).toBeVisible();
    // Nothing tracked, so the bar offers its bridge and the panel says nothing.
    await expect(panel.getByTestId("symptom-illness-bridge")).toBeVisible();
    await expect(panel.getByTestId("quick-symptom-tracking")).toHaveCount(0);

    // The well-day capture: a symptom logged with NO illness required (#1300).
    const bar = panel.getByTestId("symptom-log-bar");
    // The picker toggle is a pure client disclosure — it posts nothing, so the wait
    // is for the revealed control rather than for a Server Action.
    await hydratedClick(page, bar.getByTestId("symptom-add-picker-toggle"));
    await settledClick(page, bar.getByTestId("symptom-pick-headache"));
    await settledClick(page, bar.getByTestId("symptom-headache-sev-3"));
    await expect(bar.getByTestId("symptom-headache-sev-3")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    // Durable, by VALUE, from the store rather than from the pressed chip — and still
    // no episode, which is what "well day" means.
    await expect.poll(() => shellSymptomSeverity("headache")).toBe(3);
    expect(shellActiveIllnessSituations()).toEqual([]);
    // #1468: you are exactly where you started.
    expect(page.url()).toBe(dashboardUrl);

    // Mark as illness, the third write, through the bar's own bridge.
    await settledClick(
      page,
      bar.getByTestId("symptom-illness-bridge-activate")
    );
    await expect.poll(shellActiveIllnessSituations).toEqual(["Illness"]);

    // …and the verb has RESOLVED. Re-opening gathers again (#1892), so the sheet now
    // names what is tracked instead of offering to start it a second time. A row whose
    // label was decided at layout time could not do this.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    const reopened = await openQuickEntry(page, "log-symptom");
    await expect(reopened.getByTestId("quick-symptom-tracking")).toHaveText(
      "Tracking: Illness"
    );
    await expect(reopened.getByTestId("symptom-illness-bridge")).toHaveCount(0);
  } finally {
    clearShellSymptomState();
    await page.context().close();
  }
});

test("the Add document row files an upload in place, camera input included", async ({
  browser,
}) => {
  // #1525: the in-app twin of the #1423 share target. The overlay mounts the SAME
  // UploadForm the Data page renders — so this proves the real ingest path from a
  // sheet row, and that a save lands you back where you were.
  const prefix = "e2e-quicklog-doc-";
  // The run's FROZEN clock, never wall time (#1464) — deterministic across
  // --repeat-each, and the cleanup either side means a repeat starts from no rows.
  const filename = `${prefix}${frozenNow().getTime()}.csv`;
  clearShellDocuments(prefix);

  const page = await signIn(browser);
  try {
    await page.goto("/");
    const dashboardUrl = page.url();

    const overlay = await openQuickEntry(page, "add-document");
    const body = page.getByTestId("quick-entry-body");
    await expect(body).toHaveAttribute("data-form", "document");
    // The camera capture comes free with the shared add-media surface
    // (#1423/#1993/#3286) — "photograph the after-visit summary" works from the
    // sheet with no camera UI of its own, behind the same door as the picker. The
    // capture flow itself is document-capture.mobile.spec.ts'.
    await expect(overlay.getByTestId("medical-upload-choose")).toBeVisible();

    await stageMediaFiles(page, "medical-upload-input", {
      name: filename,
      mimeType: "text/csv",
      buffer: Buffer.from(
        "metric,value,unit,date\nGlucose,94,mg/dL,2026-01-04\n"
      ),
    });
    await expect(overlay.getByTestId("medical-upload-selected")).toContainText(
      filename
    );

    await settledClick(page, overlay.getByTestId("medical-upload-submit"));

    // Filing a document has a real end, so the overlay closes — and leaves you on the
    // page you were reading, which is the whole point of filing it from here.
    await expect(page.getByText("Upload received")).toBeVisible();
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    expect(page.url()).toBe(dashboardUrl);

    // Real, and on THIS profile: the row is in the Review import feed, gathered
    // server-side.
    await page.goto("/data?section=review");
    await expect(page.getByTestId("import-feed")).toContainText(filename);
  } finally {
    clearShellDocuments(prefix);
    await page.context().close();
  }
});

test("the palette reaches the same two surfaces the sheet does", async ({
  browser,
}) => {
  // Browse vs. search over ONE set of forms (#1506). The sheet is the browse
  // surface — one row per destination; the palette is the search surface, where a
  // typed practice name commits a session (#1633, the web catching up to Telegram's
  // one-tap) and any of the words for "document" opens the very same overlay (#1525).
  // Neither surface gets a form, or a write path, of its own.
  clearShellPracticeLogs();

  const page = await signIn(browser);
  try {
    await page.goto("/");
    const dashboardUrl = page.url();

    const input = await openCommandPalette(page);

    // A bare practice name is a SEARCH: no quick-log row, so Enter can never log a
    // session someone was only looking up.
    await input.fill(SHELL_PRACTICE);
    await expect(page.getByTestId("palette-quicklog")).toHaveCount(0);

    // Behind the verb it is a command, previewed before it is committed.
    await input.fill(`log ${SHELL_PRACTICE}`);
    const preview = page.getByTestId("palette-quicklog");
    await expect(preview).toContainText(SHELL_PRACTICE);
    await input.press("Enter");
    // The Server Action's response carries a revalidated render, which can outlast
    // the default on a loaded runner; a named ceiling, not a sleep — and the
    // Wellness assertion below re-proves the write either way.
    await expect(page.getByTestId("toast")).toContainText(
      "Logged today's session",
      { timeout: 20_000 }
    );
    expect(page.url()).toBe(dashboardUrl);

    // "lab report" — one of the words people reach for — opens the SAME overlay the
    // sheet's Add document row opens, in place.
    const reopened = await openCommandPalette(page);
    await reopened.fill("lab report");
    await page.getByTestId("palette-action-add-document").click();
    await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
    await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
      "data-form",
      "document"
    );
    await expect(page.getByTestId("medical-upload-choose")).toBeVisible();
    expect(page.url()).toBe(dashboardUrl);

    await page.keyboard.press("Escape");

    // The palette's write went to the same store the card counts — not a parallel one.
    await page.goto("/wellness");
    await expect(
      page
        .getByTestId("wellness-practice-card")
        .filter({ hasText: SHELL_PRACTICE })
    ).toContainText("1 day this week");
  } finally {
    clearShellPracticeLogs();
    await page.context().close();
  }
});
