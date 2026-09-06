import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  expectPhoneTapTargets,
  hydratedClick,
  openMeasurementGroup,
  openMobileDrawer,
  settledClick,
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
import { VITAL_CANONICAL } from "@/lib/vitals-input";

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
  date: string;
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
  live: number;
} {
  const db = openDb();
  try {
    return db
      .prepare(
        `SELECT date, start_time, end_time, duration_min, live FROM practice_logs
          WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(shellProfileId()) as {
      date: string;
      start_time: string | null;
      end_time: string | null;
      duration_min: number | null;
      live: number;
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

function setShellDoseAsNeeded(asNeeded: boolean): void {
  const db = openDb();
  try {
    db.prepare(
      "UPDATE intake_items SET kind = ?, obligation = ? WHERE id = (SELECT item_id FROM intake_item_doses WHERE id = ?)"
    ).run(
      asNeeded ? "medication" : "supplement",
      asNeeded ? "may" : "should",
      shellDoseId()
    );
    db.prepare(
      "DELETE FROM intake_item_logs WHERE item_id = (SELECT item_id FROM intake_item_doses WHERE id = ?)"
    ).run(shellDoseId());
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
    // THE TODAY ROW IS THE CHIP NOW (#4753): its name is the slot it writes
    // plus the verb, so the row's control is addressed by its testid rather than
    // by a copy string that moved.
    await settledClick(page, row.getByTestId("dose-take"));

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
      fresh.getByTestId(`quick-entry-dose-${doseId}`).getByTestId("dose-take")
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

test("a PRN-only profile logs an as-needed dose from the dose sheet", async ({
  browser,
}) => {
  const page = await signIn(browser);
  try {
    setShellDoseAsNeeded(true);
    await page.goto("/");
    const overlay = await openQuickEntry(page, "log-dose");
    const prn = overlay.getByTestId("quick-log-prn-item");
    await expect(prn).toContainText(SHELL_DOSE_ITEM);
    await expect(overlay.getByTestId("quick-entry-dose-list")).toHaveCount(0);
    await expect(overlay.getByTestId("quick-entry-dose-empty")).toHaveCount(0);

    // ── THE CLOCK DOOR IN ITS SEAT (#4753) ─────────────────────────────────
    // The labeled-verb chip reserves a seat immediately right of the pill and the
    // wrapper pays the reach gap; this is the shipped mount of it, measured on a
    // phone where the reach floor is what the gap is FOR (#3938). The door is the
    // row's own control, so what is asserted is the distance between two
    // rectangles, never a class.
    const pillBox = (await prn.getByTestId("prn-log-now").boundingBox())!;
    const doorBox = (await prn
      .getByTestId("prn-log-when-toggle")
      .boundingBox())!;
    expect(doorBox.x - (pillBox.x + pillBox.width)).toBeGreaterThanOrEqual(11);
    expect(doorBox.x - (pillBox.x + pillBox.width)).toBeLessThanOrEqual(13);
    // One word, and it never says "now".
    await expect(prn.getByTestId("prn-log-now")).toContainText("Take");
    await expect(prn.getByTestId("prn-log-now")).not.toContainText("now");

    await settledClick(page, prn.getByTestId("prn-log-now"));
    const db = openDb();
    try {
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM intake_item_logs WHERE item_id = (SELECT item_id FROM intake_item_doses WHERE id = ?) AND status = 'taken'"
          )
          .get(shellDoseId())
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  } finally {
    await page.context().close();
    setShellDoseAsNeeded(false);
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

// #3276. THE SHEET'S DOSE ROW NO LONGER OWNS ITS OFFLINE HALF — the shared client write
// pipeline does, and the enrollment gate makes the branch impossible to omit rather than
// merely present today (which is all #3272 could buy). Driven in airplane mode because
// the type-level claim is worth nothing if the capture does not actually replay: the tap
// queues, the row leaves the list because a kept capture IS a landing, and the reconnect
// writes ONE taken row through the same core every other confirm path uses.
//
// The dead spot starts AFTER the sheet is open on purpose. Opening still rides
// `loadQuickEntry`, a Server Action, for every body except measurements (#4091) — the
// separate interim fix the #3276 amendment names — so an offline OPEN would be testing
// that gap rather than this write.
test("a dose confirmed from the sheet with no signal queues, then replays", async ({
  browser,
}) => {
  const doseId = shellDoseId();
  clearDoseLogs(doseId);
  setDoseRetired(doseId, false);

  const page = await signIn(browser);
  const context = page.context();
  try {
    await page.goto("/");
    const overlay = await openQuickEntry(page, "log-dose");
    const row = overlay.getByTestId(`quick-entry-dose-${doseId}`);
    await expect(row).toBeVisible();

    await context.setOffline(true);
    // A plain click, not settledClick: this tap deliberately posts NOTHING, so there is
    // no Server Action response to settle on.
    await row.getByTestId("dose-take").click();
    await expect(
      page.getByText("Dose saved offline — will sync when you reconnect.")
    ).toBeVisible();
    await expect(page.getByTestId("offline-queue-badge")).toHaveText(
      /1 queued offline/
    );
    // Kept, so the row is resolved for this session — the same thing an online confirm
    // does, which is the parity the pipeline exists to hold.
    await expect(row).toHaveCount(0);

    await context.setOffline(false);
    // The badge emptying is the flush's own signal, and the phone shell shows one toast
    // at a time (#3611) — the offline sentence above is still holding the slot when the
    // sync lands — so this waits on the queue rather than on a snackbar, exactly as the
    // measurements offline test in this file does.
    await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0, {
      timeout: 20_000,
    });

    // DURABLE, from the ledger rather than from any toast: exactly one taken row, and
    // no second one from a replay that ran twice.
    expect(doseLogRows(doseId).map((r) => r.status)).toEqual(["taken"]);
  } finally {
    clearDoseLogs(doseId);
    await page.context().close();
  }
});

// #4453. THE PAST-DAY ROW'S OFFLINE HALF, which nothing in this suite has ever driven —
// every offline dose test above taps TODAY's row. That gap is not academic: it is how the
// #3276 conversion silently dropped this row's strike. A dose captured for yesterday
// queued and toasted correctly and then SAT IN THE LIST as though nothing had happened,
// inviting a second tap that queues the same dose again, while today's row — one function
// away, same file — kept settling on the pipeline's `captured` answer. Two rows over one
// choreography drifting apart is the whole defect #3276 exists to make unrepresentable,
// so the past-day row gets the same airplane-mode drive today's has.
//
// The dead spot starts AFTER the day is switched to, for the reason the test above gives:
// opening and switching still ride `loadQuickEntry`, so an offline switch would be testing
// the #4091 gap rather than this write.
test("a past day's dose captured with no signal leaves that day, then replays onto it", async ({
  browser,
}) => {
  const doseId = shellDoseId();
  clearDoseLogs(doseId);
  setDoseRetired(doseId, false);

  const page = await signIn(browser);
  const context = page.context();
  try {
    await page.goto("/");
    const overlay = await openQuickEntry(page, "log-dose");
    await overlay.getByTestId("quick-entry-dose-day-1").click();
    // The day the sheet says it is writing, read off the sheet rather than computed here
    // — the durable assertion at the bottom is that the replay agreed with this string.
    const named = await overlay
      .getByTestId("quick-entry-dose-day")
      .getAttribute("data-date");
    expect(named).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(named).not.toBe(frozenNow().toISOString().slice(0, 10));

    // Scoped to the OVERLAY, not to the day container: the container unmounts when the
    // day empties, and a locator that can no longer resolve anything would satisfy the
    // absence check below for a reason that has nothing to do with the row.
    const row = overlay.getByTestId(`quick-entry-dose-${doseId}`);
    await expect(row).toBeVisible();

    await context.setOffline(true);
    // A plain click, not settledClick: this tap deliberately posts NOTHING, so there is
    // no Server Action response to settle on.
    await row.getByTestId("dose-take").click();
    await expect(
      page.getByText("Dose saved offline — will sync when you reconnect.")
    ).toBeVisible();
    await expect(page.getByTestId("offline-queue-badge")).toHaveText(
      /1 queued offline/
    );

    // THE ASSERTION THIS TEST EXISTS FOR, stated POSITIVELY first so a closed overlay
    // cannot satisfy it: a kept capture IS a landing, so the day is empty and says so
    // while still mounted, and the row is gone from the same locator that just tapped it.
    await expect(
      overlay.getByTestId("quick-entry-dose-day-empty")
    ).toBeVisible();
    await expect(row).toHaveCount(0);

    await context.setOffline(false);
    // The badge emptying is the flush's own signal — the offline sentence still holds the
    // single toast slot (#3611) — so this waits on the queue rather than on a snackbar.
    // It is also what frees the day toggle: the badge is a fixed bottom-left element and
    // intercepts the pointer for the segment beneath it while it is up.
    await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0, {
      timeout: 20_000,
    });

    // DURABLE, from the ledger: one taken row, on the day the sheet named.
    expect(doseLogRows(doseId)).toEqual([{ date: named, status: "taken" }]);

    // …so it struck the DAY, not the dose. One occurrence is one (day, dose) pair, and
    // today is still owed. This is also this locator's POSITIVE CONTROL: the same object
    // the absence above was asserted through finds a row before the tap, none after, and
    // one again here — so that absence cannot have come from a locator that went blind.
    await overlay.getByTestId("quick-entry-dose-day-0").click();
    await expect(row).toBeVisible();
  } finally {
    clearDoseLogs(doseId);
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
    // The overlay mounts the Nutrition page's FoodLogBar rather than a second form.
    // Protein is ranked in only for profiles that track it; this fixture does not.
    const foodBody = page.getByTestId("quick-entry-body");
    await expect(foodBody).toHaveAttribute("data-form", "food");
    await expect(foodBody.getByTestId("food-log-bar")).toBeVisible();
    await expect(foodBody.getByTestId("protein-quickadd")).toHaveCount(0);
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

// Both quick intents live in the same sheet row. The running half is server-rendered
// again after navigation, and the day chart distinguishes the live block from the
// finished minute-rounded window.
test("the sheet starts and ends a live practice, then draws its exact tap window (#3143)", async ({
  browser,
}) => {
  clearShellPracticeLogs();

  const page = await signIn(browser);
  try {
    await page.goto("/");
    let opened = await openQuickEntry(page, "log-practice");
    const rowIn = (sheet: Locator) =>
      sheet
        .getByTestId("quick-entry-practice-list")
        .getByRole("listitem")
        .filter({ hasText: SHELL_PRACTICE });
    let row = rowIn(opened);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("practice-start-button")).toBeVisible();
    await expect(row.getByTestId("practice-log-button")).toContainText(
      "Just finished"
    );

    const tapMinute = zonedDateParts(PINNED_TZ, frozenNow()).hhmm;
    await settledClick(page, row.getByTestId("practice-start-button"));
    await expect(page.getByTestId("toast")).toContainText("Session started");
    // #5431: the row re-reads the SERVER's session, so both columns turn over
    // together — the facts state the running session and the only control left is the
    // exit. It used to print "No sessions yet" beside a brand-filled End.
    await expect(row.getByTestId("practice-end-button")).toBeVisible();
    await expect(row.getByTestId("practice-row-facts")).toContainText(
      `Running since ${tapMinute}`
    );
    await expect(row.getByTestId("practice-start-button")).toHaveCount(0);
    expect(readShellPracticeLog()).toMatchObject({
      start_time: tapMinute,
      end_time: null,
      duration_min: null,
      live: 1,
    });

    const day = readShellPracticeLog().date;
    await page.goto(`/history?day=${day}`);
    let chart = page
      .getByTestId("intraday-panel")
      .locator('[data-variant="compact"]');
    await expect(chart.getByTestId("intraday-block")).toHaveAttribute(
      "data-running",
      "true"
    );

    await page.goto("/");
    opened = await openQuickEntry(page, "log-practice");
    row = rowIn(opened);
    await expect(row.getByTestId("practice-end-button")).toBeVisible();
    await settledClick(page, row.getByTestId("practice-end-button"));
    await expect(page.getByTestId("toast")).toContainText("Session finished");
    expect(readShellPracticeLog()).toMatchObject({
      start_time: tapMinute,
      end_time: tapMinute,
      duration_min: 1,
      live: 0,
    });

    await page.goto(`/history?day=${day}`);
    chart = page
      .getByTestId("intraday-panel")
      .locator('[data-variant="compact"]');
    const finished = chart.getByTestId("intraday-block");
    await expect(finished).toHaveAttribute("data-title", SHELL_PRACTICE);
    await expect(finished).not.toHaveAttribute("data-running", "true");
  } finally {
    clearShellPracticeLogs();
    await page.close();
  }
});

test("the sheet keeps its collapsed earlier-time statement for Just finished (#3273/#3143)", async ({
  browser,
}) => {
  clearShellPracticeLogs();
  const page = await signIn(browser);
  try {
    await page.goto("/");
    const sheet = await openQuickEntry(page, "log-practice");
    const row = sheet
      .getByTestId("quick-entry-practice-list")
      .getByRole("listitem")
      .filter({ hasText: SHELL_PRACTICE });
    const toggle = row.getByTestId("practice-when-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(row.getByTestId("practice-when-time")).toHaveCount(0);

    await hydratedClick(page, toggle);
    await expect(row.getByTestId("practice-when-date")).toHaveText("Today");
    // #4384 fix 3: what opens is a LABELLED statement, not a bare box. The label is
    // asserted VISIBLE and ASSOCIATED — an `aria-label` is what this replaced, and an
    // `sr-only` span would satisfy every DOM check while looking exactly like the
    // defect. The dress is asserted as BORDER PLUS RADIUS, which is the app's `.input`
    // and not a browser default: since #4218 this is `TimeField`'s text input rather
    // than a native `<input type="time">`, and an undressed text input in this row
    // would render with neither.
    const time = row.getByTestId("practice-when-time");
    await expect(row.getByText("End time", { exact: true })).toBeVisible();
    await expect(time).toHaveAttribute("id", "practice-when-time");
    await expect(row.locator('label[for="practice-when-time"]')).toBeVisible();
    const dress = await time.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        border: parseFloat(style.borderTopWidth),
        radius: parseFloat(style.borderTopLeftRadius),
      };
    });
    expect(dress.border).toBeGreaterThan(0);
    expect(dress.radius).toBeGreaterThan(0);
    await row.getByTestId("practice-when-time").fill("07:05");
    await settledClick(page, row.getByTestId("practice-log-button"));
    expect(readShellPracticeLog()).toMatchObject({
      start_time: null,
      end_time: "07:05",
      duration_min: null,
      live: 0,
    });
    await expect(row.getByTestId("practice-when-time")).toHaveValue("");
    await expect(page.getByTestId("practice-log-details")).toHaveCount(0);
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
    // #5431's facts column: the week standing as a QUANTITY, from the same computation
    // the Wellness card reads, and no verdict badge over it. Today's count is a fact
    // only when it is not zero, so nothing here says "no sessions" at all.
    await expect(row.getByTestId("practice-row-facts")).toHaveText(
      "0 of 3 this week"
    );
    await expect(row.getByTestId("practice-today-count")).toHaveCount(0);

    // #2204: the row carries an INLINE duration control. The standing objection was
    // to stacking the expanded date/time/duration MODAL over a one-tap sheet, and it
    // still holds — nothing here opens one, and there is no trigger to open one with.
    // Since #5431 it opens from the chip's LABEL, which is where the value it holds is
    // shown; the label names its unit while the value is blank.
    const label = row.getByTestId("practice-duration-toggle");
    await expect(label).toHaveText("min");
    await expect(label).toHaveAttribute("aria-expanded", "false");
    await expect(row.getByTestId("practice-inline-duration")).toHaveCount(0);
    await hydratedClick(page, label);
    await expect(label).toHaveAttribute("aria-expanded", "true");
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
    // #4384 fix 4: the unit is on screen WHILE the field holds a value. It used to be
    // the placeholder, so the stepper read "20" here and named its unit only when it
    // had nothing to name it about.
    await expect(row.getByTestId("practice-inline-duration")).toContainText(
      "min"
    );
    // ...and stepping down is the way back, including off the bottom to blank.
    await hydratedClick(page, row.getByTestId("practice-duration-down"));
    await expect(duration).toHaveValue("15");
    for (let i = 0; i < 3; i++)
      await hydratedClick(page, row.getByTestId("practice-duration-down"));
    await expect(duration).toHaveValue("");
    for (let i = 0; i < 4; i++)
      await hydratedClick(page, row.getByTestId("practice-duration-up"));
    await expect(duration).toHaveValue("20");
    // The chip's label FOLLOWS the editor, which is what makes the nub's tap a value
    // the person saw (#2204 constraint 2) whether or not the editor is still open.
    await expect(label).toHaveText("20 min");

    await settledClick(page, row.getByTestId("practice-log-button"));

    // Answered from the typed outcome, and you are STILL on the dashboard: the sheet
    // deliberately stays open (a morning check may log a second practice), with the
    // row's own count updated in place.
    await expect(page.getByTestId("toast")).toContainText(
      "Logged today's session"
    );
    await expect(row.getByTestId("practice-today-count")).toHaveText("1 today");
    await expect(row.getByTestId("practice-row-facts")).toHaveText(
      "1 today · 1 of 3 this week"
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
    // time costs zero taps — read off the chip's LABEL, which is where the collapsed
    // row now states it.
    await page.goto("/");
    const again = await openQuickEntry(page, "log-practice");
    await expect(
      again
        .getByTestId("quick-entry-practice-list")
        .getByRole("listitem")
        .filter({ hasText: SHELL_PRACTICE })
        .getByTestId("practice-duration-toggle")
    ).toHaveText("20 min");
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
    const checkin = overlay.getByTestId("mood-form");
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

    // The tap and the full statement are one form. Fill details before choosing the
    // valence and prove the one-tap submission carries every visible answer with it.
    await checkin.getByText("Details").click();
    await checkin.getByRole("button", { name: "Energy: 3" }).click();
    await checkin.getByRole("button", { name: "Work" }).click();
    await checkin.getByLabel("Note").fill("clear afternoon");

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
          `SELECT date, valence, energy, factors, notes
             FROM mood_logs WHERE profile_id = ? ORDER BY date`
        )
        .all(shellProfileId()) as {
        date: string;
        valence: number;
        energy: number | null;
        factors: string | null;
        notes: string | null;
      }[];
      expect(rows).toEqual([
        {
          date: yesterdayDate,
          valence: 4,
          energy: 3,
          factors: '["work"]',
          notes: "clear afternoon",
        },
      ]);
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

// ONE ILLNESS PANEL, AND THE TAP CENSUS THAT ARGUED FOR IT (#4712 item 2).
//
// The issue's whole case is a count: logging a feverish child's temperature at 2 AM
// was "profile switch → puck → Body segment → Log measurements → type → save", about
// seven taps, and the profile switch is not optional — the sheet's measurements form
// renders `unavailable` for a non-acting subject (#4932 invariant 2), so the Body path
// cannot cross the household boundary at all. So this asserts the PATH, not that a
// field renders: the taps are counted, the acting profile is read at the end, and the
// row is read out of the store the app writes.
//
// WHAT THE COUNT ACTUALLY IS, measured here rather than claimed: SEVEN taps, of which
// two are the subject chip. #4932's "Default" clause — an opener inside a
// subject-scoped container passing that subject — is deferred, so nothing opens this
// sheet already naming the child; when it does, the same journey is five. Either way
// the switch is gone: the caregiver never leaves their own profile, which is the part
// that cost a page load and the app's whole context.
const FEVER_READING_F = "101.4";

function clearProfileTemperatures(profileId: number): void {
  const db = openDb();
  try {
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?"
    ).run(profileId, VITAL_CANONICAL.temperature.canonical);
  } finally {
    db.close();
  }
}

function profileTemperatures(
  profileId: number
): { value_num: number; logged_via: string | null }[] {
  const db = openDb();
  try {
    return db
      .prepare(
        `SELECT value_num, logged_via FROM medical_records
          WHERE profile_id = ? AND canonical_name = ?`
      )
      .all(profileId, VITAL_CANONICAL.temperature.canonical) as {
      value_num: number;
      logged_via: string | null;
    }[];
  } finally {
    db.close();
  }
}

test("the sheet's Care segment takes a household member's fever, with no profile switch (#4712 item 2)", async ({
  browser,
}) => {
  const ownerId = profileIdByName(MULTI_OWNER_PROFILE);
  const sharedId = profileIdByName(MULTI_SHARED_PROFILE);
  clearProfileTemperatures(ownerId);
  clearProfileTemperatures(sharedId);
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_MULTI, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
  try {
    await page.goto("/");

    let taps = 0;
    // The count is the point, so every tap goes through one counter. `client` names
    // the pure toggles (the chip, the fold) that post nothing and must be waited on
    // by what they reveal, not by a POST.
    const tap = async (
      target: Locator,
      kind: "client" | "posts" = "posts"
    ): Promise<void> => {
      taps += 1;
      if (kind === "client") await hydratedClick(page, target);
      else await settledClick(page, target);
    };

    // Three: the dock puck, the Care segment, the "Log symptom" row. Counted as the
    // helper's own three rather than re-spelled, so this census cannot drift from the
    // path every other test in this file walks. The count is of the CANONICAL path —
    // `openLogSheet` re-taps the puck past a pre-hydration swallow, and a retry is
    // not a tap a person makes.
    const overlay = await openQuickEntry(page, "log-symptom");
    taps += 3;
    const panel = overlay.getByTestId("quick-symptom-panel");
    await expect(panel).toBeVisible();

    // Two: name the child in the title-row chip (#4932). The Body segment's
    // measurements form cannot do this at all — it refuses a non-acting subject —
    // which is why the pre-#4712 path had to switch profiles first.
    await tap(overlay.getByTestId("quick-entry-subject-chip"), "client");
    await tap(
      overlay
        .getByTestId("quick-entry-subject-picker")
        .getByTestId(`quick-entry-subject-option-${sharedId}`)
    );
    await expect(overlay.getByTestId("quick-entry-subject-chip")).toContainText(
      MULTI_SHARED_PROFILE
    );

    // Two: open the fold and save. The value is typed, which is not a tap.
    await tap(panel.getByTestId("temp-quick-toggle"), "client");
    await panel.getByTestId("temp-quick-input").fill(FEVER_READING_F);
    await tap(panel.getByTestId("temp-quick-save"));

    // EXACT ON PURPOSE, AND IT WILL GO RED BY DESIGN. When #4932's Default clause
    // lands — an opener inside a subject-scoped container passing that subject —
    // nothing has to name the child here and this journey becomes five taps. That
    // red is that issue succeeding, not this path breaking. The fix then is to
    // re-count the journey and re-pin the number, never to loosen this to a bound:
    // a `<=` would stop noticing a regression in either direction, which is the
    // whole reason the census is written as a count.
    expect(taps).toBe(7);

    // THE READING LANDED ON THE CHILD, from the store rather than from the toast —
    // and none landed on the caregiver, which is the failure this path used to take
    // when a bar posted no subject.
    await expect(async () => {
      expect(profileTemperatures(sharedId)).toEqual([
        { value_num: Number(FEVER_READING_F), logged_via: "quick-log" },
      ]);
    }).toPass({ timeout: 15_000 }); // topass-ok: the write is a Server Action the click does not resolve for us; the row is the settle signal
    expect(profileTemperatures(ownerId)).toEqual([]);

    // THE FEVER OFFER HAS A PRE-EPISODE SURFACE AT LAST (#4712 judgement 1, which
    // shipped in #4961 and until now rendered only on episode-gated mounts). Not
    // accepted here — this test is about the reading's path — but its presence is
    // what makes the panel carry the illness statement whole.
    await expect(panel.getByTestId("fever-offer")).toBeVisible();
    await expect(panel.getByTestId("fever-offer-open-episode")).toBeVisible();

    // AND THE CAREGIVER NEVER LEFT THEIR OWN PROFILE. The acting profile reads from
    // the drawer's identity bar (#4102) — the whole saving of this journey is that
    // this still says the caregiver.
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    const drawer = await openMobileDrawer(page);
    await expect(drawer.getByTestId("profile-identity-bar")).toContainText(
      MULTI_OWNER_PROFILE
    );
  } finally {
    clearProfileTemperatures(ownerId);
    clearProfileTemperatures(sharedId);
    await page.context().close();
  }
});
