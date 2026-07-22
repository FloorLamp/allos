import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_ROUTINE_BUILDER,
  E2E_MEMBER_PASSWORD,
  ROUTINE_BUILDER_PROFILE,
} from "./fixture-logins";

// Routine builder UI (#739): the Routines tab on /training over the #738 write
// cores/actions. Two flows — adopt a catalog template then activate it, and author a
// custom routine end to end (create → edit → activate → deactivate).
//
// Runs on a DEDICATED fixture profile (ROUTINE_BUILDER_PROFILE) via its own member
// login — NEVER profile 1, and NEVER the routine-recommendation fixture profile
// (whose routine must stay ACTIVE for the Today's-session card spec): activation DELETES the profile's training-scope frequency_targets, so this
// must not touch profile 1's seeded PPL targets that other specs depend on. The profile
// is seeded (seed-events.ts) with two training-scope frequency targets so the
// activate-confirm dialog (shown only when there ARE targets to replace) is exercised.
// beforeEach resets the profile's routines + targets to that clean slate, so each test
// starts from a known state regardless of order or retries.

function openDb(): Database.Database {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  return db;
}

function routineBuilderProfileId(db: Database.Database): number {
  return (
    db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(ROUTINE_BUILDER_PROFILE) as {
      id: number;
    }
  ).id;
}

// Reset the fixture profile to a clean slate: no routines, exactly the two seeded
// training-scope frequency targets (Upper/Lower). Keyed by profile so it never touches
// any other profile's rows.
function resetRoutineFixture(): void {
  const db = openDb();
  try {
    const pid = routineBuilderProfileId(db);
    db.prepare(
      `DELETE FROM routine_slots WHERE routine_day_id IN (
         SELECT rd.id FROM routine_days rd
           JOIN routines r ON r.id = rd.routine_id WHERE r.profile_id = ?)`
    ).run(pid);
    db.prepare(
      `DELETE FROM routine_days WHERE routine_id IN (
         SELECT id FROM routines WHERE profile_id = ?)`
    ).run(pid);
    db.prepare(`DELETE FROM routines WHERE profile_id = ?`).run(pid);
    db.prepare(
      `DELETE FROM frequency_targets WHERE profile_id = ? AND scope_kind IN ('region','group','type')`
    ).run(pid);
    const ins = db.prepare(
      `INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id)
         VALUES (?, ?, ?, ?)`
    );
    ins.run("group", "Upper", 2, pid);
    ins.run("group", "Lower", 2, pid);
  } finally {
    db.close();
  }
}

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await loginAs(browser, {
    username: E2E_LOGIN_ROUTINE_BUILDER,
    password: E2E_MEMBER_PASSWORD,
  });
});

test.beforeEach(() => {
  resetRoutineFixture();
});

test.afterAll(async () => {
  resetRoutineFixture();
  await page.context().close();
});

// A routine card in the list, located by its name (never a positional first-match on the shared list).
function cardByName(name: string) {
  return page
    .getByRole("main")
    .getByTestId("routine-card")
    .filter({ hasText: name });
}

async function gotoRoutines() {
  await page.goto("/training?tab=routines");
  await expect(page.getByTestId("routines-section")).toBeVisible();
}

test("adopt a template, then activate it (#739)", async () => {
  await gotoRoutines();

  // Open the adopt picker and adopt the Full Body 3× beginner template.
  await page.getByTestId("routine-adopt-open").click();
  const picker = page.getByTestId("template-picker");
  await expect(picker).toBeVisible();
  const fullBody = picker
    .getByTestId("template-card")
    .filter({ hasText: "Full Body 3×/week" });
  await expect(fullBody).toContainText("beginner");
  await expect(fullBody).toContainText("3 days");
  await fullBody.getByTestId("template-adopt").click();

  // It appears in the list, inactive.
  const card = cardByName("Full Body 3×/week");
  await expect(card).toBeVisible();
  await expect(card).toContainText("From template");
  await expect(card.getByTestId("routine-active-badge")).toHaveCount(0);

  // Activate → the confirm lists the training-scope targets that will be replaced.
  await card.getByTestId("routine-activate").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const replaced = dialog.getByTestId("replace-targets");
  await expect(replaced).toContainText("Upper");
  await expect(replaced).toContainText("Lower");
  await dialog.getByRole("button", { name: "Activate" }).click();

  // Now active.
  await expect(card.getByTestId("routine-active-badge")).toBeVisible();
});

test("build a custom routine, edit it, activate and deactivate (#739)", async () => {
  await gotoRoutines();

  // Open the builder and author a two-day routine.
  await page.getByTestId("routine-new").click();
  const builder = page.getByTestId("routine-builder");
  await expect(builder).toBeVisible();
  await builder.getByTestId("routine-name").fill("My Custom Split");

  const days = builder.getByTestId("builder-day");
  // Day 1: one catalog exercise + one custom (free-text) exercise in a second slot.
  const day1 = days.nth(0);
  await day1.getByTestId("day-label").fill("Lower");
  const slot1 = day1.getByTestId("builder-slot").nth(0);
  const combo1 = slot1.getByRole("combobox");
  await combo1.fill("Back Squat");
  await combo1.press("Enter");
  await expect(slot1.getByTestId("slot-candidate")).toContainText("Back Squat");

  // Add a second slot with a custom free-text lift (guides/anatomy degrade gracefully).
  await day1.getByTestId("add-slot").click();
  const slot2 = day1.getByTestId("builder-slot").nth(1);
  const combo2 = slot2.getByRole("combobox");
  await combo2.fill("My Secret Hip Lift");
  await slot2.getByRole("button", { name: /custom lift/ }).click();
  await expect(slot2.getByTestId("slot-candidate")).toContainText(
    "My Secret Hip Lift"
  );

  // Add a second day with one exercise.
  await builder.getByTestId("add-day").click();
  const day2 = builder.getByTestId("builder-day").nth(1);
  await day2.getByTestId("day-label").fill("Upper");
  const d2slot = day2.getByTestId("builder-slot").nth(0);
  const combo3 = d2slot.getByRole("combobox");
  await combo3.fill("Bench Press");
  await combo3.press("Enter");
  await expect(d2slot.getByTestId("slot-candidate")).toContainText(
    "Bench Press"
  );

  await builder.getByTestId("routine-save").click();

  // Appears in the list as a custom routine with 2 days.
  const card = cardByName("My Custom Split");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Custom");
  await expect(card).toContainText("2 days");

  // Edit: rename it.
  await card.getByTestId("routine-edit").click();
  const editor = page.getByTestId("routine-builder");
  await expect(editor).toBeVisible();
  await editor.getByTestId("routine-name").fill("My Renamed Split");
  await editor.getByTestId("routine-save").click();

  const renamed = cardByName("My Renamed Split");
  await expect(renamed).toBeVisible();

  // Activate → confirm (targets present) → active.
  await renamed.getByTestId("routine-activate").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Activate" }).click();
  await expect(renamed.getByTestId("routine-active-badge")).toBeVisible();

  // Deactivate → badge gone (the derived targets stay behind as ordinary targets).
  await renamed.getByTestId("routine-deactivate").click();
  await expect(renamed.getByTestId("routine-active-badge")).toHaveCount(0);
});
