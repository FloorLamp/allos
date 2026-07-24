import {
  test,
  expect,
  type Page,
  type Locator,
  type Browser,
} from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { followLink, loginAs } from "./nav";
import { settledClick } from "./helpers";
import { hashPasswordSync } from "../lib/password";
import { E2E_MEMBER_PASSWORD } from "./fixture-logins";
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
// Member-isolated + repeat-safe: each test signs in as a DEDICATED write-granted member
// whose SOLE (therefore active) profile is a fresh, spec-owned profile it seeds — so it
// drives its OWN cookie context and never switches (or has to restore) the shared admin
// session's active profile. That shared-session switch — and the afterEach that walked it
// back to admin via switchProfileAction — was the residual #1323 switchProfile-class flake:
// a switch POST that false-settled on a bystander toaster poll left the header trigger on
// the wrong profile, failing the next assertion. Removing the switch removes the flake.

let seq = 0;

function e2eDbPath(): string {
  return (
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db")
  );
}

interface MemberProfile {
  page: Page;
  profileName: string;
  profileId: number;
}

// Sign in as a dedicated, write-granted member whose SOLE (therefore active — createSession
// picks accessibleProfiles[0]) profile is a fresh profile this test owns. A DB-seeded profile
// carries NO onboarding row, so the member lands straight on the dashboard (no /onboarding
// gate). The optional `seed` runs inside the SAME connection, after the profile INSERT and
// before the grant, so the member's first render already sees the planted fixtures. The
// caller drives the returned member page and closes its context at the end.
async function signInAsFreshMember(
  browser: Browser,
  label: string,
  seed?: (db: Database.Database, profileId: number) => void
): Promise<MemberProfile> {
  const n = ++seq;
  const profileName = `${label}-${Date.now()}-${n}`;
  const username = `e2e_recon_${Date.now()}_${n}`;
  const db = new Database(e2eDbPath());
  let profileId: number;
  try {
    db.pragma("busy_timeout = 5000");
    profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(profileName)
        .lastInsertRowid
    );
    if (seed) seed(db, profileId);
    const loginId = Number(
      db
        .prepare(
          "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
        )
        .run(username, hashPasswordSync(E2E_MEMBER_PASSWORD)).lastInsertRowid
    );
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(loginId, profileId);
  } finally {
    db.close();
  }
  const page = await loginAs(browser, {
    username,
    password: E2E_MEMBER_PASSWORD,
  });
  return { page, profileName, profileId };
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

test.describe("Episode-end medication reconciliation (#880)", () => {
  test("quick-add ibuprofen during the illness → end episode → accept → med moves to Past", async ({
    browser,
  }) => {
    test.slow();
    const { page } = await signInAsFreshMember(browser, "recon");

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
    await settledClick(page, page.getByTestId("episode-med-reconcile-confirm"));

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

    await page.context().close();
  });

  test("reopen restores the med the end stopped (#1140 Part B)", async ({
    browser,
  }) => {
    test.slow();
    const { page } = await signInAsFreshMember(browser, "reopen");

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
    await settledClick(page, page.getByTestId("episode-med-reconcile-confirm"));

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
    // Wait for the reopen+restart to complete before navigating (the toast confirms the
    // server action returned).
    await expect(page.getByText(/Episode reopened\. Restarted/i)).toBeVisible();

    // Ibuprofen is a Current medication again — the reopen inverted the stop.
    await page.goto("/medications");
    await expect(
      medicationList(page).getByTestId("medication-row").filter({
        hasText: "Ibuprofen",
      })
    ).toBeVisible();

    await page.context().close();
  });

  test("edit-form End date moves a med to Past and the row Restart brings it back (#1140 Parts C/D)", async ({
    browser,
  }) => {
    test.slow();
    // Seed a fresh profile with one ACTIVE medication directly (member isolation seeds it
    // in the same connection as the profile) — deterministic, no add-form combobox.
    const medName = "Endstopil";
    const { page } = await signInAsFreshMember(
      browser,
      "medlife",
      (db, pid) => {
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
      }
    );

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
    // settledClick awaits the save POST — but NOT the client nav its success handler
    // fires: the edit form opened via `?action=edit` runs onDone → closeInitialAction →
    // router.replace(/medications/{id}) (stripping the query) right after the POST that
    // settledClick returns on. That soft replace is still in flight when the next
    // goto("/medications") runs, and the App Router resolves the hard-goto-vs-soft-replace
    // collision onto "/" — stranding the test off /medications (the #1323 "navigated to /"
    // signature). Await the replace LANDING (query gone, URL back to the bare detail)
    // before navigating away, so no client nav races the goto.
    await settledClick(
      page,
      page.getByRole("main").getByRole("button", { name: "Save", exact: true })
    );
    await expect(page).toHaveURL(/\/medications\/\d+$/);

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

    await page.context().close();
  });

  test("dormant-PRN sweep: a PRN med unused for 90+ days can be moved to Past", async ({
    browser,
  }) => {
    test.slow();

    // Seed a fresh profile with a long-dormant OTC PRN med directly (a med created 90+
    // days ago with no dose can't be produced through today's quick-add). Seeded in the
    // same connection as the profile, so the member's first render already sees it.
    const medName = "Dormancitol";
    const { page } = await signInAsFreshMember(
      browser,
      "dormant",
      (db, pid) => {
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
      }
    );

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

    await page.context().close();
  });
});
