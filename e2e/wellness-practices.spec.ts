import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  dismissToast,
  expectNoClippedContent,
  hydratedClick,
  settledBoxes,
  settledClick,
  settledFill,
} from "./helpers";
import { loginAs, openCommandPalette } from "./nav";
import {
  E2E_LOGIN_DAILY,
  E2E_LOGIN_PRACTICE_ZERO,
  E2E_MEMBER_PASSWORD,
  PRACTICE_ZERO_PROFILE,
} from "./fixture-logins";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { setFixtureTimezone } from "./fixture-timezones";
import { frozenNow, workerDbPath } from "./worker-env";
import { zonedDateParts, zonedWallTimeToUtc } from "@/lib/date";
import { practiceIdentity } from "@/lib/practice";

// THE PRACTICE CATALOG LIVES IN THE QUICK-LOG SHEET (#5668). The Wellness page
// retired: its practice list, create and edit moved into the sheet's practice rows,
// and its history and backfill moved to History's practice view and day view.

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// The sheet's practice list, opened the way the palette and a nudge link open it.
async function openPracticeSheet(page: Page, route = "/") {
  await page.goto(`${route}?quick=log-practice`);
  const list = page.getByTestId("quick-entry-practice-list");
  await expect(list).toBeVisible();
  return list;
}

function practiceRow(list: Locator, name: string): Locator {
  return list.getByRole("listitem").filter({ hasText: name });
}

// Open one row's ⋯ and choose an item (#2632). The toggle needs hydration, and the
// panel is portaled, so it is reached from the page rather than the row.
async function chooseRowAction(
  page: Page,
  row: Locator,
  name: string,
  item: string
) {
  await hydratedClick(
    page,
    row.getByRole("button", { name: `Actions for ${name}` })
  );
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: item }).click();
}

test("from the quick-log sheet a person adds a practice, edits it and logs it without leaving (#5668)", async ({
  page,
}) => {
  test.slow(); // three Server Action writes and a delete, all over one sheet
  const name = `E2E Catalog ${frozenNow().getTime()}`;
  const renamed = `${name} Renamed`;
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    const list = await openPracticeSheet(page);
    const sheet = page.getByTestId("quick-entry-sheet");

    // ADD opens over the sheet. Its picker must paint above both surfaces, and
    // Escape dismisses the nested picker first, then the dialog — never the sheet.
    await hydratedClick(
      page,
      sheet.getByRole("button", { name: "Add practice" })
    );
    const addDialog = page.getByRole("dialog", { name: "Add practice" });
    const create = addDialog.getByTestId("practice-create-form");
    await expect(create).toBeVisible();
    await create.getByLabel("Practice").focus();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    const [listboxBounds] = await settledBoxes([listbox]);
    const listboxIsTopmost = await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest('[role="listbox"]')
          ?.getAttribute("role") === "listbox",
      {
        x: listboxBounds.x + listboxBounds.width / 2,
        y: listboxBounds.y + listboxBounds.height - 4,
      }
    );
    expect(listboxIsTopmost).toBe(true);
    await page.keyboard.press("Escape");
    await expect(listbox).toBeHidden();
    await expect(create).toBeVisible();

    await settledFill(page, create.getByLabel("Practice"), name);
    await settledFill(page, create.getByLabel("Minimum days"), "3");
    await settledClick(page, create.getByRole("button", { name: "Save" }));
    await dismissToast(page, "Practice added");
    await expect(addDialog).toHaveCount(0);
    await expect(sheet).toBeVisible();
    const row = practiceRow(list, name);
    await expect(row.getByTestId("practice-row-facts")).toHaveText(
      "0 of 3 this week"
    );

    // EDIT, from the row's ⋯: the name and the weekly goal.
    await chooseRowAction(page, row, name, "Edit");
    const edit = page.getByTestId("practice-edit-form");
    await expect(edit).toBeVisible();
    await settledFill(page, edit.getByLabel("Practice"), renamed);
    await settledFill(page, edit.getByLabel("Minimum days"), "2");
    await settledClick(
      page,
      edit.getByRole("button", { name: "Save changes" })
    );
    await dismissToast(page, "Practice updated");
    await expect(edit).toHaveCount(0);
    const renamedRow = practiceRow(list, renamed);
    await expect(renamedRow.getByTestId("practice-row-facts")).toHaveText(
      "0 of 2 this week"
    );

    // LOG it, with a duration, from the same row.
    await hydratedClick(
      page,
      renamedRow.getByTestId("practice-duration-toggle")
    );
    for (let i = 0; i < 4; i++)
      await hydratedClick(page, renamedRow.getByTestId("practice-duration-up"));
    await expect(renamedRow.getByTestId("practice-duration-toggle")).toHaveText(
      "20 min"
    );
    await settledClick(page, renamedRow.getByTestId("practice-log-button"));
    await dismissToast(page, "Logged today's session");
    await expect(renamedRow.getByTestId("practice-row-facts")).toHaveText(
      "1 today · 1 of 2 this week"
    );
    // Still on the page the sheet was opened over: nothing navigated.
    await expect(sheet).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    const db = openDb();
    try {
      expect(
        db
          .prepare(
            "SELECT duration_min FROM practice_logs WHERE profile_id = 1 AND practice = ?"
          )
          .all(renamed)
      ).toEqual([{ duration_min: 20 }]);
    } finally {
      db.close();
    }

    // And DELETE takes the practice and its session, from the same ⋯.
    await chooseRowAction(page, renamedRow, renamed, "Delete practice");
    await settledClick(
      page,
      page
        .getByTestId("confirm-dialog")
        .getByRole("button", { name: "Delete practice" })
    );
    await expect(renamedRow).toHaveCount(0);

    // UNDO brings it back into the open sheet — the list holds its own rows, so the
    // restore has to re-read them just as the delete did.
    const toast = page.getByTestId("toast"); // testid-scope-ok: the toast region portals to <body>, outside every streamed boundary
    await settledClick(
      page,
      toast
        .filter({ hasText: `${renamed} deleted.` })
        .getByRole("button", { name: "Undo" })
    );
    await expect(renamedRow.getByTestId("practice-row-facts")).toHaveText(
      "1 today · 1 of 2 this week"
    );
  } finally {
    const db = openDb();
    try {
      db.prepare(
        "DELETE FROM practice_logs WHERE profile_id = 1 AND practice IN (?, ?)"
      ).run(name, renamed);
      db.prepare(
        `DELETE FROM frequency_targets
          WHERE profile_id = 1 AND scope_kind = 'practice' AND scope_value IN (?, ?)`
      ).run(name, renamed);
    } finally {
      db.close();
    }
  }
});

// THE ZERO STATE (#3066). Dedicated fixture (#868) whose whole content is an absence,
// and the test removes the practice it creates, so --repeat-each stays clean.
test("with nothing tracked, the always-visible quick-log row offers the first practice (#3066)", async ({
  browser,
}) => {
  test.slow(); // a sign-in, two palette opens and a Server-Action create
  const practiceName = `E2E First Practice ${frozenNow().getTime()}`;
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PRACTICE_ZERO,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // The door, at PHONE width — the width the quick-log sheet is designed for and
    // the one a first-capture offer has to survive.
    await page.goto("/");
    await page.setViewportSize({ width: 390, height: 844 });
    const input = await openCommandPalette(page);
    await input.fill("practice");
    await page.getByTestId("palette-action-wellness-practices").click();
    await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
      "data-form",
      "practice"
    );
    const offer = page.getByTestId("quick-entry-practice-empty");
    await expect(offer).toBeVisible();
    const create = offer.getByTestId("practice-create-form");
    await expect(create).toBeVisible();
    await expectNoClippedContent(page);

    await settledFill(page, create.getByLabel("Practice"), practiceName);
    await settledClick(page, create.getByRole("button", { name: "Save" }));
    // Declaring a practice is a transaction with an end, so the sheet closes.
    await expect(page.getByTestId("quick-entry-sheet")).toBeHidden();
    await dismissToast(page, "Practice added");

    // The sheet row has become the log list it always promised.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const reopened = await openCommandPalette(page);
    await reopened.fill("practice");
    await page.getByTestId("palette-action-wellness-practices").click();
    await expect(page.getByTestId("quick-entry-practice-list")).toBeVisible();
    await expect(page.getByTestId("quick-entry-practice-empty")).toHaveCount(0);
  } finally {
    const handle = openDb();
    try {
      handle
        .prepare(
          `DELETE FROM frequency_targets
            WHERE scope_kind = 'practice'
              AND profile_id IN (SELECT id FROM profiles WHERE name = ?)`
        )
        .run(PRACTICE_ZERO_PROFILE);
    } finally {
      handle.close();
    }
    await page.context().close();
  }
});

test("the command palette opens the practice overlay in place (#1620/#2184)", async ({
  page,
}) => {
  await page.goto("/");
  const dashboardUrl = page.url();
  const input = await openCommandPalette(page);
  // Findable by the domain word even though the label is now the sheet row's
  // ("Log practice") — the #2184 drift fix must not cost #1620's findability.
  await input.fill("wellness");
  const action = page.getByTestId("palette-action-wellness-practices");
  await expect(action).toBeVisible();
  await expect(action).toContainText("Log practice");
  await action.click();
  // The SAME overlay the quick-log sheet's row opens, IN PLACE: same form key,
  // same practice list, URL untouched — no more hard navigation mid-whatever.
  await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
  await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
    "data-form",
    "practice"
  );
  await expect(page.getByTestId("quick-entry-practice-list")).toBeVisible();
  expect(page.url()).toBe(dashboardUrl);
});

test("practice edits reject invalid cadence and logs-only name collisions (#1618/#1619)", async ({
  page,
}) => {
  // This test is about EDITS. Its two subjects — a tracked practice with a min/max
  // cadence and a logs-only practice to collide with — are seeded straight into the
  // worker DB (#868 spec-owned fixtures), not built through the UI.
  const suffix = frozenNow().getTime();
  const trackedName = `E2E Cadence ${suffix}`;
  const historyName = `E2E History ${suffix}`;
  const today = frozenNow().toISOString().slice(0, 10);

  const db = openDb();
  let trackedTargetId = 0;
  try {
    trackedTargetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week, per_week_max)
           VALUES (1, 'practice', ?, ?, 3, 5)`
        )
        .run(trackedName, practiceIdentity(trackedName)).lastInsertRowid
    );
    // A logs-only practice is exactly sessions with no frequency_targets row — the
    // collision check reads the union of both stores.
    const logSession = db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date) VALUES (1, ?, ?)`
    );
    logSession.run(historyName, today);
    logSession.run(historyName, today);

    await page.setViewportSize({ width: 390, height: 844 });
    const list = await openPracticeSheet(page);
    const row = practiceRow(list, trackedName);
    await expect(row).toBeVisible();

    await chooseRowAction(page, row, trackedName, "Edit");
    const edit = page.getByTestId("practice-edit-form");
    await settledFill(page, edit.getByLabel("Minimum days"), "5");
    await settledFill(page, edit.getByLabel("Maximum days (optional)"), "3");
    await settledClick(
      page,
      edit.getByRole("button", { name: "Save changes" })
    );
    await expect(edit.getByTestId("practice-save-error")).toHaveText(
      "The weekly maximum must be greater than the minimum."
    );

    // The Practice field is a Combobox; settledFill asserts the value STUCK, so a
    // swallowed name cannot quietly re-save the old one and report no collision.
    await settledFill(page, edit.getByLabel("Practice"), historyName);
    await settledFill(page, edit.getByLabel("Minimum days"), "3");
    await settledFill(page, edit.getByLabel("Maximum days (optional)"), "5");
    await settledClick(
      page,
      edit.getByRole("button", { name: "Save changes" })
    );
    await expect(edit.getByTestId("practice-save-error")).toHaveText(
      "A practice with that name already exists."
    );
    // A refused edit leaves BOTH definitions alone — the rejection is not a partial
    // write that renamed one of them on the way to failing.
    expect(
      db
        .prepare(
          "SELECT scope_value, per_week, per_week_max FROM frequency_targets WHERE id = ?"
        )
        .get(trackedTargetId)
    ).toEqual({ scope_value: trackedName, per_week: 3, per_week_max: 5 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM practice_logs WHERE profile_id = 1 AND practice = ?"
        )
        .get(historyName)
    ).toEqual({ n: 2 });
  } finally {
    db.prepare("DELETE FROM practice_logs WHERE practice IN (?, ?)").run(
      trackedName,
      historyName
    );
    if (trackedTargetId) {
      db.prepare("DELETE FROM frequency_targets WHERE id = ?").run(
        trackedTargetId
      );
    }
    db.close();
  }
});

test("one-tap practice logging: a double-tap logs once, the label states today, and a deliberate repeat asks (#2007)", async ({
  page,
}) => {
  test.slow();
  const unique = `E2E One Tap ${frozenNow().getTime()}`;
  const db = openDb();
  const sessions = () =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM practice_logs WHERE profile_id = 1 AND practice = ?"
        )
        .get(unique) as { n: number }
    ).n;
  try {
    db.prepare(
      `INSERT INTO frequency_targets
         (profile_id, scope_kind, scope_value, scope_identity, per_week)
       VALUES (1, 'practice', ?, ?, 3)`
    ).run(unique, practiceIdentity(unique));

    await page.setViewportSize({ width: 390, height: 844 });
    let row = practiceRow(await openPracticeSheet(page), unique);
    const button = row.getByTestId("practice-log-button");
    await expect(button).toHaveAccessibleName(/^Just finished a /);
    await expect(row.getByTestId("practice-today-count")).toHaveCount(0);

    // Layer 1 — the fat-finger double. The second tap lands inside the post-success
    // cooldown and is absorbed: no dialog, and no second session.
    await button.evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
    await expect(row.getByTestId("practice-today-count")).toHaveText("1 today");
    // The cooldown is a rendered state, not a silent onClick return.
    await expect(button).toBeDisabled();
    await expect(button).toBeEnabled();

    // Layer 2 — the affordance now renders today's state, so the next tap is visibly
    // a SECOND one before it is taken.
    await expect(button).toHaveAccessibleName(/1 already logged today/);
    expect(sessions()).toBe(1);

    // Layer 3 — a deliberate second session of the same day ASKS, naming the practice.
    // A fresh load clears the client cooldown; hydratedClick taps exactly once after
    // hydration, since a retry could cancel the very confirm it waits for (#2729).
    row = practiceRow(await openPracticeSheet(page), unique);
    await hydratedClick(page, row.getByTestId("practice-log-button"));
    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`You logged ${unique} today`);
    await hydratedClick(page, dialog.getByRole("button", { name: "Cancel" }));
    await expect(dialog).toHaveCount(0);
    expect(sessions()).toBe(1);

    // …and confirming logs the genuine second session (#798: informational, never
    // permissive — a second sauna is legitimate).
    await hydratedClick(page, row.getByTestId("practice-log-button"));
    await expect(dialog).toBeVisible();
    await settledClick(
      page,
      dialog.getByRole("button", { name: "Log session" })
    );
    await expect(row.getByTestId("practice-today-count")).toHaveText("2 today");
    expect(sessions()).toBe(2);
  } finally {
    db.prepare(
      "DELETE FROM practice_logs WHERE profile_id = 1 AND practice = ?"
    ).run(unique);
    db.prepare(
      `DELETE FROM frequency_targets
        WHERE profile_id = 1 AND scope_kind = 'practice' AND scope_value = ?`
    ).run(unique);
    db.close();
  }
});

test("History's cross-practice day-history aligns its frozen labels at first paint (#3243)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Spec-owned logs (#868): two uniquely named practices with sessions inside
  // the trailing-quarter window, deleted in finally. The section may also carry
  // seed practices — assert about OUR rows, never exact counts.
  const A = "History Sauna (e2e)";
  const B = "History Breathwork (e2e)";
  const keyA = practiceIdentity(A)!;
  const keyB = practiceIdentity(B)!;
  const day = (back: number) => {
    const d = frozenNow();
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  };
  const db = openDb();
  try {
    const insert = db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, duration_min)
       VALUES (1, ?, ?, ?)`
    );
    insert.run(A, day(2), 20);
    insert.run(A, day(9), 25);
    insert.run(B, day(3), null);

    const history = page.getByTestId("practice-history");
    const rowA = history.locator(
      `[data-testid="day-history-row"][data-group="${keyA}"]`
    );
    const rowB = history.locator(
      `[data-testid="day-history-row"][data-group="${keyB}"]`
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto("/history?kind=practice");
      await expect(rowA).toHaveCount(1);
      await expect(rowB).toHaveCount(1);
      await expect(
        history.getByTestId("day-history-visible-range")
      ).toBeVisible();
      const geometry = await rowA.evaluate((row) => {
        const label = row.querySelector<HTMLElement>("[data-matrix-label]")!;
        const text = label.querySelector<HTMLElement>("button > span")!;
        const labelBox = label.getBoundingClientRect();
        const partialCells = [
          ...row.querySelectorAll<HTMLElement>("[data-matrix-col] > span"),
        ].filter((cell) => {
          const box = cell.getBoundingClientRect();
          const overlap = Math.min(labelBox.right, box.right) - box.left;
          return overlap > 0.5 && overlap < box.width - 0.5;
        });
        return {
          label: text.textContent,
          labelClipped:
            text.scrollWidth > text.clientWidth + 0.5 ||
            text.scrollHeight > text.clientHeight + 0.5,
          partialCells: partialCells.length,
        };
      });
      expect(geometry).toEqual({
        label: A,
        labelClipped: false,
        partialCells: 0,
      });
    }
    // Rows share ONE day axis: the calendar half renders beside them.
    await expect(history.getByTestId("day-history-calendar")).toBeVisible();
    await expect(history).toContainText(
      "Calendar: days you practiced. Matrix: each day by practice."
    );
    // A client toggle whose effect is only awaited by a non-retrying `boundingBox()`.
    await hydratedClick(
      page,
      rowA.getByRole("button", { name: /View occurrences for/ })
    );
    const [calendarBox, rowBox] = await settledBoxes([
      history.getByTestId("day-history-calendar-panel"),
      history.getByTestId("day-history-rowpanel"),
    ]);
    expect(rowBox.y).toBeGreaterThanOrEqual(calendarBox.y + calendarBox.height);
    await expectNoClippedContent(page);
  } finally {
    db.prepare(
      `DELETE FROM practice_logs WHERE profile_id = 1 AND practice IN (?, ?)`
    ).run(A, B);
    db.close();
  }
});

// The zero-practice profile, given one tracked practice and one old session so
// History's add row offers its Practice chip (a chip is earned by the kind's rows).
function seedZeroProfilePractice(name: string): void {
  const handle = openDb();
  try {
    const profileId = (
      handle
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(PRACTICE_ZERO_PROFILE) as { id: number }
    ).id;
    handle
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week)
         VALUES (?, 'practice', ?, ?, 3)`
      )
      .run(profileId, name, practiceIdentity(name));
    const old = frozenNow();
    old.setUTCDate(old.getUTCDate() - 20);
    handle
      .prepare(
        "INSERT INTO practice_logs (profile_id, practice, date) VALUES (?, ?, ?)"
      )
      .run(profileId, name, old.toISOString().slice(0, 10));
  } finally {
    handle.close();
  }
}

function clearZeroProfilePractices(): void {
  const handle = openDb();
  try {
    const ids = `SELECT id FROM profiles WHERE name = ?`;
    handle
      .prepare(`DELETE FROM practice_logs WHERE profile_id IN (${ids})`)
      .run(PRACTICE_ZERO_PROFILE);
    handle
      .prepare(
        `DELETE FROM frequency_targets
          WHERE scope_kind = 'practice' AND profile_id IN (${ids})`
      )
      .run(PRACTICE_ZERO_PROFILE);
  } finally {
    handle.close();
  }
}

// A STATED WINDOW REACHES THE DAY'S CHART (#3142): the practice form's Start and End,
// through `start_time` / `end_time`, out onto the day view's intraday panel as a
// BLOCK — the shape a session with no stated end cannot draw. The form opens from
// History's Practice chip (#5668).
test("a practice logged with Start and End draws a block on the day chart (#3142)", async ({
  browser,
}) => {
  test.slow(); // a sign-in, a detailed log and two page loads
  const practiceName = `E2E Interval Sauna ${frozenNow().getTime()}`;
  seedZeroProfilePractice(practiceName);
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PRACTICE_ZERO,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/history");
    await hydratedClick(page, page.getByTestId("history-add-open-practice"));
    const form = page.getByTestId("practice-log-details");
    await expect(form).toBeVisible();

    // THE PROFILE'S OWN TODAY, read off the form rather than recomputed here: the
    // run pins a ROTATING instance timezone (e2e/pinned-timezone.ts), so a date
    // derived from the host clock is the wrong day for most of the day.
    const day = await form.locator('input[name="date"]').inputValue();
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Both are PROFILE-LOCAL wall clocks, so they need no zone conversion — which is
    // exactly why the block's minutes below can be asserted as literals. TimeField
    // (#4976) posts through a hidden input; the visible fields are these.
    await settledFill(page, form.locator("#practice-start-time"), "19:00");
    await settledFill(page, form.getByTestId("end-time-input"), "19:25");
    await settledClick(page, page.getByTestId("practice-log-detailed-submit"));
    await dismissToast(page, "Logged today's session");

    await page.goto(`/history?day=${day}`);
    const panel = page.getByTestId("intraday-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-intraday-date", day);
    // One variant is displayed at a time; scope to the one this project's viewport
    // shows rather than letting a locator reach into the hidden twin.
    const chart = panel.locator('[data-variant="wide"]');
    const block = chart.getByTestId("intraday-block");
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute("data-title", practiceName);
    // A BLOCK AND NOT A TICK is the assertion: a session with a start alone still
    // renders, as a tick, so "the session is on the chart" would pass without the
    // end ever having been stored.
    await expect(chart.getByTestId("intraday-tick")).toHaveCount(0);
  } finally {
    clearZeroProfilePractices();
    await page.context().close();
  }
});

// TimeRangeFields' hidden input is a NAMED field the dirty-form registry has to see
// (#4976). START ONLY, nothing else touched — the visible field a person types into
// carries no `name`, so a fix that only reached the visible input would leave this red.
test("typing only the practice form's Start time makes it dirty (#4976)", async ({
  browser,
}) => {
  test.slow(); // a sign-in and a detailed log open
  const practiceName = `E2E Dirty Start ${frozenNow().getTime()}`;
  seedZeroProfilePractice(practiceName);
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PRACTICE_ZERO,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/history");
    const registry = page.getByTestId("dirty-form-registry");
    await expect(registry).toHaveAttribute("data-dirty", "0");

    await hydratedClick(page, page.getByTestId("history-add-open-practice"));
    const form = page.getByTestId("practice-log-details");
    await expect(form).toBeVisible();
    await expect(registry).toHaveAttribute("data-dirty", "0");

    await settledFill(page, form.locator("#practice-start-time"), "19:00");
    await expect(registry).toHaveAttribute("data-dirty", "1");
    await expect(form.locator("#practice-start-time")).toHaveValue("19:00");
  } finally {
    clearZeroProfilePractices();
    await page.context().close();
  }
});

// THE END BUTTON SURVIVES LOCAL MIDNIGHT (#3143 review, defect 1's user-visible half).
//
// A session started at 23:xx and still running at 00:xx is the ordinary evening
// practice, and the first cut of the lifecycle hid its End button: the gathers asked
// for a live row whose `date` equalled the profile's today. A session you cannot end
// is the whole bug — the DB tier proves the query answers, only a browser proves the
// button is there and can be tapped.
//
// WHY THIS PROFILE HAS ITS OWN CALENDAR. The run pins local time to 13:mm at every UTC
// start hour (e2e/pinned-timezone.ts), and at 13:00 every live row dated on another day
// is genuinely abandoned — so the crossing is UNREACHABLE on a pin-following profile.
// This one sits in the zone where the frozen instant reads 00:mm, declared as
// `practice-midnight` in e2e/fixture-timezones.ts, and it asserts only on the sheet.
function midnightZone(frozen: Date): string {
  // The inverse of pinnedTimezone's arithmetic, aimed at 00:mm instead of 13:mm. The
  // POSIX sign is inverted in the Etc names: Etc/GMT-11 is UTC+11.
  const utcHour = frozen.getUTCHours();
  const offset = utcHour === 0 ? 0 : utcHour <= 12 ? -utcHour : 24 - utcHour;
  if (offset === 0) return "UTC";
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

const LIVE_SESSION_HOURS_AGO = 3;

test("a live session that crossed local midnight can still be ended (#3143)", async ({
  browser,
}, testInfo) => {
  test.slow(); // a fixture profile, a sign-in, a page load and a write
  const suffix = `${process.pid}-${testInfo.repeatEachIndex}`;
  const practiceName = `E2E Midnight Sauna ${suffix}`;
  const zone = midnightZone(frozenNow());
  const startedAt = new Date(
    frozenNow().getTime() - LIVE_SESSION_HOURS_AGO * 3_600_000
  );
  const local = zonedDateParts(zone, startedAt);
  const localToday = zonedDateParts(zone, frozenNow()).date;
  // The premise this whole case rests on, asserted rather than assumed: the running
  // session's day is NOT the profile's today, which is what used to hide the button.
  expect(local.date).not.toBe(localToday);

  const handle = openDb();
  const username = `e2e_practice_midnight_${suffix}`;
  let profileId = 0;
  let logId = 0;
  try {
    handle.transaction(() => {
      const passwordHash = (
        handle
          .prepare("SELECT password_hash FROM logins WHERE username = ?")
          .get(E2E_LOGIN_DAILY) as { password_hash: string }
      ).password_hash;
      profileId = createFixtureProfile(handle, `Midnight practice ${suffix}`);
      const loginId = Number(
        handle
          .prepare(
            "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
          )
          .run(username, passwordHash).lastInsertRowid
      );
      handle
        .prepare(
          `INSERT INTO login_profiles (login_id, profile_id, access)
           VALUES (?, ?, 'write')`
        )
        .run(loginId, profileId);
      setFixtureTimezone(handle, profileId, "practice-midnight", zone);
      // Tracked, so the quick-log sheet lists it.
      handle
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week)
           VALUES (?, 'practice', ?, ?, 3)`
        )
        .run(profileId, practiceName, practiceIdentity(practiceName));
      logId = Number(
        handle
          .prepare(
            `INSERT INTO practice_logs
               (profile_id, practice, date, start_time, live, logged_via, created_at)
             VALUES (?, ?, ?, ?, 1, 'page', ?)`
          )
          .run(
            profileId,
            practiceName,
            local.date,
            local.hhmm,
            startedAt.toISOString().slice(0, 19).replace("T", " ")
          ).lastInsertRowid
      );
    })();

    const page = await loginAs(browser, {
      username,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      const row = practiceRow(
        await openPracticeSheet(page, "/history"),
        practiceName
      );
      await expect(row).toBeVisible();
      // The assertion the day comparison used to fail: the row offers END, not Start.
      const end = row.getByTestId("practice-end-button");
      await expect(end).toBeVisible();
      await expect(row.getByTestId("practice-start-button")).toHaveCount(0);

      await settledClick(page, end);
      await dismissToast(page, "Session finished");

      const stored = handle
        .prepare(
          `SELECT date, start_time, end_time, duration_min, live
             FROM practice_logs WHERE id = ?`
        )
        .get(logId) as {
        date: string;
        start_time: string;
        end_time: string | null;
        duration_min: number | null;
        live: number;
      };
      // THE ROW KEEPS THE DAY IT STARTED ON, and its window and its duration are one
      // statement: the end is earlier than the start because the session crossed
      // midnight. The expectation is composed from the STORED start through the same
      // inverse the write core reads it with, which is the quantity the row claims.
      const statedStart = zonedWallTimeToUtc(zone, local.date, local.hhmm)!;
      expect(stored).toEqual({
        date: local.date,
        start_time: local.hhmm,
        end_time: zonedDateParts(zone, frozenNow()).hhmm,
        duration_min: Math.round(
          (frozenNow().getTime() - statedStart.getTime()) / 60_000
        ),
        live: 0,
      });
      expect(stored.end_time! < stored.start_time).toBe(true);
    } finally {
      await page.context().close();
    }
  } finally {
    try {
      handle
        .prepare("DELETE FROM practice_logs WHERE profile_id = ?")
        .run(profileId);
      handle
        .prepare(
          "DELETE FROM frequency_targets WHERE profile_id = ? AND scope_kind = 'practice'"
        )
        .run(profileId);
      handle
        .prepare("DELETE FROM profile_settings WHERE profile_id = ?")
        .run(profileId);
      if (profileId) destroyFixtureProfile(handle, profileId);
      handle.prepare("DELETE FROM logins WHERE username = ?").run(username);
    } finally {
      handle.close();
    }
  }
});
