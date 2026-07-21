import { test, expect, type Page, type Locator } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { followLink } from "./nav";

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

// Switch the shared session's active profile via the sidebar UserMenu, retry-clicking
// through the hydration window (#730), as the household/front-door specs do.
async function switchToProfile(page: Page, name: string): Promise<void> {
  const target = page
    .getByTestId("user-menu-popover")
    .getByRole("button", { name });
  await expect(async () => {
    await page.getByTestId("user-menu-trigger").click();
    await expect(target).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await target.click();
  await expect(page.getByTestId("user-menu-trigger")).toContainText(name);
}

// A fresh healthy (adult) profile via Settings → Family; switch to it. Mirrors the
// illness-front-door helper (defers onboarding through the product's own affordance).
async function freshProfile(page: Page, label: string): Promise<string> {
  const name = `${label}-${Date.now()}-${++profileSeq}`;
  await page.goto("/settings/family");
  const profilesCard = page
    .locator("div.card")
    .filter({ hasText: "Add a profile" });
  await profilesCard.getByPlaceholder("Name", { exact: true }).fill(name);
  await profilesCard.getByRole("button", { name: "Add", exact: true }).click();
  await expect(profilesCard.getByText(name)).toBeVisible();
  await switchToProfile(page, name);
  await page.goto("/");
  if (page.url().includes("/onboarding")) {
    await page
      .getByRole("button", { name: "Set up later, take me to my dashboard" })
      .click();
    await expect(page).toHaveURL(/\/$|\/\?/);
  }
  return name;
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
    .first();
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
    await freshProfile(page, "recon");

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
    const prnItem = page
      .getByTestId("quick-log-prn")
      .getByTestId("quick-log-prn-item")
      .filter({ hasText: "Ibuprofen" });
    await expect(prnItem).toBeVisible();
    await prnItem.getByTestId("prn-log-now").click();
    await expect(page.getByText(/Logged Ibuprofen/i)).toBeVisible();

    // 4) Open the full episode page from the hero cockpit's "More details" link (the
    // active profile's cockpit is at hero position, expanded by default).
    const episodeLink = page
      .getByRole("link", { name: /^More details about / })
      .first();
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
    const past = page.getByTestId("past-medications");
    await expect(past).toBeVisible();
    await past.locator("summary").click();
    await expect(
      page.getByTestId("medication-row").filter({ hasText: "Ibuprofen" })
    ).toBeVisible();
    // It is no longer a Current med (a fresh profile has only this med).
    await expect(
      page.getByTestId("medication-list").getByTestId("medication-row")
    ).toHaveCount(0);
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
    await page.getByTestId("past-medications").locator("summary").click();
    await expect(
      page.getByTestId("medication-row").filter({ hasText: medName })
    ).toBeVisible();
  });
});
