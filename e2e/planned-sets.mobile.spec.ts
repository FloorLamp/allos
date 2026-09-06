import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { comboboxRows, deleteActivityFromForm } from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { E2E_LOGIN_FORM_PLATEAU, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Issue #5373 — every set arrives as a PLAN, and only a confirmed set is a record.
//
// The owner's constraint: "I intend to do those exact reps, but often I fail, so in
// practice I fulfil one or two of the three-plus rows." So the editor opens the whole
// prescription as ghost rows, and the day it goes badly ends with the two sets that
// happened — not with three rows to edit back down.
//
// THE ONE BROWSER CASE, and it is the whole journey: a three-set plan driven to a
// two-set finish, asserted against what was STORED. The rest of the model (the confirm
// gesture, the check-off, the payload filter, the recap's "2 of 3") is pinned at the
// component tier, where a wrong answer is one assertion.
//
// Runs on the phone project (#1420) by filename: the grid is the surface used mid-set,
// standing up, and the confirm control has to be reachable there.
//
// Fixture hygiene (#868): FORM_PLATEAU is a dedicated profile whose Skullcrusher has
// five sessions of 30 kg × 8 × 3 — the three-set history the plan is built from. This
// spec creates its own draft and deletes it.
const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

// Pick an activity in the editor's exercise combobox (an exact typed match collapses
// the dropdown to a single 'Use "…"' button, a partial filter lists name + badge, so
// match by substring).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await comboboxRows(page)
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

test("a three-set plan finishes as the two sets that happened (#5373)", async ({
  browser,
}) => {
  const marker = `Planned sets probe ${Date.now()}`; // clock-ok: unique-name suffix for this spec's own session title, never a stored timestamp
  const storedSets = () => {
    const db = new Database(workerDbPath());
    try {
      db.pragma("busy_timeout = 5000");
      return db
        .prepare(
          `SELECT s.set_number, s.weight_kg, s.reps
             FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
            WHERE a.title = ? ORDER BY s.set_number`
        )
        .all(marker);
    } finally {
      db.close();
    }
  };
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_FORM_PLATEAU, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
  try {
    // The phone's own entry to a fresh draft: the dock's Train segment. "Add activity"
    // is a desktop header control and does not render at 390px.
    await page.goto("/training?tab=log");
    const sheet = await openLogSheet(page);
    await (await showLogRow(sheet, "log-activity")).click();
    await pickActivity(page, "Skullcrusher");
    const form = page.getByTestId("activity-form"); // testid-scope-ok: ActivityOverlay portals the workspace to <body>, one copy
    await form.getByLabel("Activity name").fill(marker);

    // THE PRESCRIPTION, AS ROWS. Three of them, from the three-set history — and every
    // one still an offer: each carries a confirm control, and the load above them is a
    // ghost too (#5371's band is not a record until a set is).
    await expect(form.getByTestId(/^set-row-\d+$/)).toHaveCount(3);
    await expect(form.getByTestId(/^set-confirm-\d+$/)).toHaveCount(3);
    const load = form.getByTestId("exercise-weight").getByTestId("set1-weight");
    await expect(load).toHaveValue("");
    // The plan's own numbers, read off the ghost paint rather than restated here — the
    // coached progression is pinned where it is computed, not in a browser.
    const plannedLoad = Number(await load.getAttribute("placeholder"));
    expect(plannedLoad).toBeGreaterThan(0);
    // Nothing has been done, so there is nothing to add a set to and nothing to save.
    await expect(
      page.getByRole("button", { name: "+ Add set" })
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeHidden();

    // Set 1 went as planned: one tap.
    await form.getByTestId("set-confirm-1").click();
    await expect(form.getByTestId("set-confirm-1")).toHaveCount(0);
    const plannedReps = await form.getByTestId("set1-reps").inputValue();

    // Set 2 came up short — correcting IS confirming, so two taps on reps `−` records
    // it and no confirm follows.
    const row2 = form.getByTestId("set-row-2");
    await row2.getByLabel("Decrease reps").click();
    await expect(form.getByTestId("set-confirm-2")).toHaveCount(0);
    await expect(form.getByTestId("set2-reps")).toHaveValue(
      String(Number(plannedReps) - 1)
    );

    // Set 3 never happened. It is still the plan, and finishing leaves it behind: the
    // stored session is the two sets, at the load the plan stated.
    await expect(form.getByTestId("set-confirm-3")).toHaveCount(1);
    await expect(form.getByTestId("set3-reps")).toHaveValue("");
    await expect.poll(storedSets, { timeout: 15_000 }).toEqual([
      { set_number: 1, weight_kg: plannedLoad, reps: Number(plannedReps) },
      {
        set_number: 2,
        weight_kg: plannedLoad,
        reps: Number(plannedReps) - 1,
      },
    ]);

    await deleteActivityFromForm(page);
  } finally {
    await page.close();
  }
});
