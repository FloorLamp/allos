import { test, expect, type Page, type Locator } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { followLink } from "./nav";
import { createProfileViaFamily, switchToProfile } from "./family-helpers";
import {
  medicationRow,
  medicationList,
  pastMedications,
  prnTodayItem,
} from "./med-card-helpers";

// Episode-end medication reconciliation + the dormant-PRN sweep (issue #880).
//   1. The full arc: on a FRESH sick profile, quick-add ibuprofen during the illness, log
//      a dose, end the episode from its page → the suggest-only checklist offers the
//      ibuprofen pre-checked → confirm moves it to Past (course closed, illness_resolved).
//   2. The dormant-PRN sweep: a PRN med with no dose in 90+ days is offered "move to past"
//      on /medications; one tap retires it.
// Fixture-owned + repeat-safe: each test acts on a profile it creates (an admin can act as
// any profile), and afterEach restores the shared session to the default admin profile so
// the switch never leaks into a later spec (CI runs one worker sharing the session).

let profileSeq = 0;
const ADMIN_PROFILE = "admin";

function e2eDbPath(): string {
  return (
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db")
  );
}

// Pick a medication from the quick-add combobox (click the option so the resolver
// prefill fires), mirroring the illness-front-door helper.
async function pickMedication(
  scope: Page | Locator,
  value: string
): Promise<void> {
  const input = scope.getByRole("combobox", { name: "Medication" });
  await input.click();
  await input.fill(value);
  const option = scope
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: value })
    .first(); // first-ok: transient combobox list this spec just opened by typing `value`; the first filtered match is the intended option
  await expect(option).toBeVisible();
  await option.click();
}

test.afterEach(async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByTestId("user-menu-trigger");
  if ((await trigger.textContent())?.includes(ADMIN_PROFILE)) return;
  await switchToProfile(page, ADMIN_PROFILE);
});

test.describe("Episode-end medication reconciliation (#880)", () => {
  test("quick-add ibuprofen during the illness → end episode → accept → med moves to Past", async ({
    page,
  }) => {
    test.slow();
    await createProfileViaFamily(page, "recon");

    // 1) Feeling sick — one tap opens the illness (and the full cockpit).
    await page.goto("/");
    await page.getByTestId("feeling-sick-activate").click();
    await expect(page.getByTestId("symptom-log-bar")).toBeVisible();

    // 2) Quick-add ibuprofen from the cockpit's Meds section (created DURING the episode).
    await page.getByTestId("illness-add-medication").click();
    const inline = page.getByTestId("illness-medication-quick-add");
    await expect(inline).toBeVisible();
    await pickMedication(inline, "Ibuprofen");
    await inline.getByRole("button", { name: "Quick add" }).click();
    await expect(page.getByTestId("illness-add-medication")).toBeVisible();

    // 3) Log a dose from the dashboard PRN quick-log widget.
    await page.goto("/");
    const prnItem = prnTodayItem(
      page.getByTestId("quick-log-prn"),
      "Ibuprofen"
    );
    await expect(prnItem).toBeVisible();
    await prnItem.getByTestId("prn-log-now").click();
    await expect(page.getByText(/Logged Ibuprofen/i)).toBeVisible();

    // 4) Open the full episode page from the hero cockpit's "More details" link (the
    // active profile's cockpit is at hero position, expanded by default).
    const episodeLink = page
      .getByRole("link", { name: /^More details about / })
      .first(); // first-ok: the active (fresh) profile's hero-cockpit episode link (this spec owns the profile)
    await followLink(page, episodeLink, /\/medical\/episodes\/\d+/);

    // 5) "Feeling better" opens the reconciliation checklist — ibuprofen is listed and
    // pre-checked (OTC PRN created during the illness). Confirm ends + closes it.
    await page.getByTestId("episode-end").click();
    const list = page.getByTestId("episode-med-reconcile-list");
    await expect(list).toBeVisible();
    await expect(list).toContainText("Ibuprofen");
    await page.getByTestId("episode-med-reconcile-confirm").click();

    // 6) The ibuprofen has left Current for Past — the med list that IS the doctor-visit
    // artifact no longer misrepresents it as a standing med.
    await page.goto("/medications");
    const past = pastMedications(page);
    await expect(past).toBeVisible();
    await past.locator("summary").click();
    await expect(medicationRow(page, "Ibuprofen")).toBeVisible();
    // It is no longer a Current med (a fresh profile has only this med).
    await expect(
      medicationList(page).getByTestId("medication-row")
    ).toHaveCount(0);
  });

  test("reopen restores the med the end stopped (#1140 Part B)", async ({
    page,
  }) => {
    test.slow();
    await createProfileViaFamily(page, "reopen");

    // Get sick, quick-add ibuprofen during the illness, log a dose.
    await page.goto("/");
    await page.getByTestId("feeling-sick-activate").click();
    await expect(page.getByTestId("symptom-log-bar")).toBeVisible();
    await page.getByTestId("illness-add-medication").click();
    const inline = page.getByTestId("illness-medication-quick-add");
    await expect(inline).toBeVisible();
    await pickMedication(inline, "Ibuprofen");
    await inline.getByRole("button", { name: "Quick add" }).click();
    await expect(page.getByTestId("illness-add-medication")).toBeVisible();
    await page.goto("/");
    const prnItem = prnTodayItem(
      page.getByTestId("quick-log-prn"),
      "Ibuprofen"
    );
    await prnItem.getByTestId("prn-log-now").click();
    await expect(page.getByText(/Logged Ibuprofen/i)).toBeVisible();

    // End the episode, stopping ibuprofen (pre-checked in the reconcile checklist).
    const episodeLink = page
      .getByRole("link", { name: /^More details about / })
      .first(); // first-ok: the active (fresh) profile's hero-cockpit episode link (this spec owns the profile)
    await followLink(page, episodeLink, /\/medical\/episodes\/\d+/);
    const episodeUrl = page.url();
    await page.getByTestId("episode-end").click();
    await expect(page.getByTestId("episode-med-reconcile-list")).toContainText(
      "Ibuprofen"
    );
    await page.getByTestId("episode-med-reconcile-confirm").click();

    // Part A (#1140): the just-resolved illness surfaces on the dashboard as a calm,
    // dismissible "Recently resolved — reopen?" line (within its 7-day window).
    await page.goto("/");
    const resolvedLine = page.getByTestId("recently-resolved-reopen");
    await expect(resolvedLine).toBeVisible();
    await expect(resolvedLine).toContainText(/Recently resolved/i);

    // The episode is now closed + reopen-eligible: reopening from its page offers to
    // restart exactly the meds it stopped (the symmetric inverse). Confirm restores it.
    await page.goto(episodeUrl);
    const reopen = page.getByTestId("episode-reopen-action");
    await expect(reopen).toBeVisible();
    await reopen.click();
    const restoreList = page.getByTestId("episode-reopen-med-list");
    await expect(restoreList).toBeVisible();
    await expect(restoreList).toContainText("Ibuprofen");
    await page.getByTestId("episode-reopen-confirm").click();

    // Ibuprofen is a Current medication again — the reopen inverted the stop.
    await page.goto("/medications");
    await expect(
      medicationList(page).getByTestId("medication-row").filter({
        hasText: "Ibuprofen",
      })
    ).toBeVisible();
  });

  test("edit-form End date moves a med to Past and the row Restart brings it back (#1140 Parts C/D)", async ({
    page,
  }) => {
    test.slow();
    // Seed a fresh profile with one ACTIVE medication directly (an admin acts as any
    // profile) — deterministic, no add-form combobox in the way.
    const profileName = `medlife-${Date.now()}-${++profileSeq}`;
    const medName = "Endstopil";
    const db = new Database(e2eDbPath());
    try {
      db.pragma("busy_timeout = 5000");
      const pid = Number(
        db.prepare("INSERT INTO profiles (name) VALUES (?)").run(profileName)
          .lastInsertRowid
      );
      const itemId = Number(
        db
          .prepare(
            `INSERT INTO intake_items
               (profile_id, name, active, kind, condition, priority, as_needed, rx,
                quantity_on_hand, qty_per_dose, created_at)
             VALUES (?, ?, 1, 'medication', 'daily', 'high', 0, 1, 30, 1, '2025-06-01 12:00:00')`
          )
          .run(pid, medName).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '10 mg', 'morning', 'any', 0)`
      ).run(itemId);
      db.prepare(
        `INSERT INTO medication_courses (item_id, started_on, stopped_on)
         VALUES (?, '2025-06-01', NULL)`
      ).run(itemId);
    } finally {
      db.close();
    }
    await page.goto("/");
    await switchToProfile(page, profileName);

    // Part D: the edit form carries an End date field. Set it → the med moves to Past.
    await page.goto("/medications");
    const detailHref = await medicationRow(page, medName)
      .getByTestId("medication-row-link")
      .getAttribute("href");
    expect(detailHref).toMatch(/\/medications\/\d+/);
    await page.goto(`${detailHref}?action=edit`);
    const endField = page.getByTestId("med-end-date");
    await expect(endField).toBeVisible();
    await endField.fill("2025-08-15");
    await page
      .getByRole("main")
      .getByRole("button", { name: "Save", exact: true })
      .click();

    await page.goto("/medications");
    await pastMedications(page).locator("summary").click();
    const pastRow = medicationRow(pastMedications(page), medName);
    await expect(pastRow).toBeVisible();

    // Part C: the Past row's one-tap Restart brings it back to Current.
    await pastRow.getByRole("button", { name: "Medication actions" }).click();
    await page.getByTestId("medication-row-restart").click();
    await expect(page.getByText(`${medName} restarted.`)).toBeVisible();
    await expect(
      medicationList(page).getByTestId("medication-row").filter({
        hasText: medName,
      })
    ).toBeVisible();
  });

  test("dormant-PRN sweep: a PRN med unused for 90+ days can be moved to Past", async ({
    page,
  }) => {
    test.slow();

    // Seed a fresh profile with a long-dormant OTC PRN med directly in the e2e DB (a med
    // created 90+ days ago with no dose can't be produced through today's quick-add). An
    // admin can act as any profile, so we switch to it via the UI. Short-lived connection
    // + busy timeout so it never contends with the running server on the WAL DB.
    const profileName = `dormant-${Date.now()}-${++profileSeq}`;
    const medName = "Dormancitol";
    const db = new Database(e2eDbPath());
    try {
      db.pragma("busy_timeout = 5000");
      const pid = Number(
        db.prepare("INSERT INTO profiles (name) VALUES (?)").run(profileName)
          .lastInsertRowid
      );
      const itemId = Number(
        db
          .prepare(
            `INSERT INTO intake_items
               (profile_id, name, active, kind, condition, priority, as_needed, rx,
                quantity_on_hand, qty_per_dose, created_at)
             VALUES (?, ?, 1, 'medication', 'daily', 'high', 1, 0, 10, 1, '2025-01-01 12:00:00')`
          )
          .run(pid, medName).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '400 mg', 'any', 'any', 0)`
      ).run(itemId);
      db.prepare(
        `INSERT INTO medication_courses (item_id, started_on, stopped_on)
         VALUES (?, '2025-01-01', NULL)`
      ).run(itemId);
    } finally {
      db.close();
    }

    await page.goto("/");
    await switchToProfile(page, profileName);

    // The sweep card offers the dormant med.
    await page.goto("/medications");
    const sweep = page.getByTestId("dormant-prn-sweep");
    await expect(sweep).toBeVisible();
    const item = sweep
      .getByTestId("dormant-prn-item")
      .filter({ hasText: medName });
    await expect(item).toBeVisible();

    // One tap moves it to Past — it leaves the sweep and lands in the Past list.
    await item.getByTestId("dormant-prn-move").click();
    await expect(page.getByText(`Moved ${medName} to Past.`)).toBeVisible();
    await expect(
      sweep.getByTestId("dormant-prn-item").filter({ hasText: medName })
    ).toHaveCount(0);
    await pastMedications(page).locator("summary").click();
    await expect(medicationRow(page, medName)).toBeVisible();
  });
});
