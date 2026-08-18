import { test, expect } from "./fixtures";
import { type Page, type Locator, type Browser } from "@playwright/test";
import Database from "better-sqlite3";
import { followLink, loginAs } from "./nav";
import { settledClick } from "./helpers";
import { hashPasswordSync } from "../lib/password";
import { E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { createFixtureProfile } from "./fixture-profile";
import {
  medicationRow,
  medicationList,
  pastMedications,
  prnTodayItem,
} from "./med-card-helpers";
import { workerDbPath } from "./worker-env";

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
  return workerDbPath();
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
  const profileName = `${label}-${Date.now()}-${n}`; // clock-ok: unique fixture-name suffix, never a stored timestamp
  const username = `e2e_recon_${Date.now()}_${n}`; // clock-ok: unique login-name suffix, never a stored timestamp
  const db = new Database(e2eDbPath());
  let profileId: number;
  try {
    db.pragma("busy_timeout = 5000");
    profileId = createFixtureProfile(db, profileName);
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
               (profile_id, name, active, kind, condition, obligation, rx,
                quantity_on_hand, qty_per_dose, created_at)
             VALUES (?, ?, 1, 'medication', 'daily', 'must', 1, 30, 1, '2025-06-01 12:00:00')`
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
                 (profile_id, name, active, kind, condition, obligation, rx,
                  quantity_on_hand, qty_per_dose, created_at)
               VALUES (?, ?, 1, 'medication', 'daily', 'may', 0, 10, 1, '2025-01-01 12:00:00')`
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
