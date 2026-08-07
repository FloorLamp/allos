import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { hydratedClick, openMeasurementGroup, settledClick } from "./helpers";
import { loginAs, openCommandPalette } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_SHELL,
  SHELL_PROFILE,
  SHELL_WEIGHT_KG,
  SHELL_DOSE_ITEM,
  SHELL_PRACTICE,
} from "./fixture-logins";
import { frozenNow, workerDbPath } from "./worker-env";

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
  time: string | null;
  duration_min: number | null;
} {
  const db = openDb();
  try {
    return db
      .prepare(
        `SELECT time, duration_min FROM practice_logs
          WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(shellProfileId()) as {
      time: string | null;
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

async function signIn(browser: Parameters<typeof loginAs>[0]): Promise<Page> {
  return loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
}

// Open the quick-log sheet and tap one of its rows. The caret is a pure CLIENT
// toggle, so a pre-hydration tap is swallowed with no POST to settle on and no
// other awaitable open signal — the visibility-guarded retry is the only honest
// wait here (#500/#830).
async function openQuickEntry(page: Page, itemId: string) {
  const sheet = page.getByTestId("quick-log-sheet");
  await expect(async () => {
    if (!(await sheet.isVisible())) {
      await page.getByTestId("quick-log-more").click();
    }
    await expect(sheet).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the caret past the pre-hydration swallow — a client toggle with no POST, visibility-guarded so a late tap can't re-close it

  await sheet.getByTestId(`quick-log-${itemId}`).click();
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

    const overlay = await openQuickEntry(page, "log-dose");
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

    // Restore the schedule and confirm for real. This time a log IS written, so
    // the row resolves, and with nothing left to confirm the overlay closes
    // itself instead of sitting there empty.
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
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    expect(page.url()).toBe(dashboardUrl);

    // Durable, from SERVER-gathered state: reopening asks the due-dose
    // computation again, and it no longer offers a dose that is taken.
    const reopened = await openQuickEntry(page, "log-dose");
    await expect(reopened.getByTestId("quick-entry-unavailable")).toBeVisible();
    await expect(
      reopened.getByTestId(`quick-entry-dose-${doseId}`)
    ).toHaveCount(0);
  } finally {
    clearDoseLogs(doseId);
    setDoseRetired(doseId, false);
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
    expect(logged.time).toMatch(/^\d{2}:\d{2}$/);

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
    // The camera capture comes free with the shared form (#1423/#1993) —
    // "photograph the after-visit summary" works from the sheet with no camera UI
    // of its own, as one of the phone's two equal actions. The capture flow itself
    // is document-capture.mobile.spec.ts'.
    await expect(overlay.getByTestId("medical-upload-camera")).toBeVisible();

    await overlay.getByTestId("medical-upload-input").setInputFiles({
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
    await expect(page.getByTestId("medical-upload-camera")).toBeVisible();
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
