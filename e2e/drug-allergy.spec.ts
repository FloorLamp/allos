import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_DRUG_ALLERGY,
  DRUG_ALLERGY_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import {
  allergyWarnings,
  allergyWarningRows,
} from "./intake-warnings-helpers";

// Drug-allergy × medication-stack cross-check (issue #1029). The dedicated fixture
// profile records a "Penicillin — hives" allergy and tracks amoxicillin (same-class
// hit) + cephalexin (documented cross-reactivity hit). The Medications safety strip
// must render both cards — informational, cited, never prescriptive — and the same
// finding (same dedupeKey) must appear on Upcoming and stay hidden once dismissed.
// The fixture login is isolated (#868), and dismissals are reset before each test so
// the spec owns its suppression state under --repeat-each.

// Clear this fixture profile's allergy-med dismissals so the findings are visible at
// the start of EVERY test (the drug-interactions.spec reset pattern — a dismissal
// persists in upcoming_dismissals across repeats). Short-lived connection with a
// busy timeout so it never contends with the running server (WAL).
function resetAllergyDismissals(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(DRUG_ALLERGY_PROFILE) as { id: number } | undefined;
    if (profile) {
      db.prepare(
        "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'allergy-med:%'"
      ).run(profile.id);
    }
  } finally {
    db.close();
  }
}

test.beforeEach(() => {
  resetAllergyDismissals();
});

test("shows the recorded-allergy warnings on /medications (same-class + cross-reactivity)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DRUG_ALLERGY,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/medications");
  const main = page.getByRole("main");

  const warnings = allergyWarnings(main);
  await expect(warnings).toBeVisible();

  // Same-class hit: amoxicillin × the recorded penicillin allergy, with the
  // recorded reaction and the informational, cited framing.
  const classCard = allergyWarningRows(warnings)
    .filter({ hasText: "Amoxicillin" })
    .first();
  await expect(classCard).toBeVisible();
  await expect(classCard).toContainText("Penicillin");
  await expect(classCard).toContainText("recorded reaction: hives");
  await expect(classCard).toContainText("discuss with your prescriber");
  await expect(classCard).toContainText("Source:");

  // Cross-class hit: cephalexin carries the possible-cross-reactivity framing.
  const crossCard = allergyWarningRows(warnings)
    .filter({ hasText: "Cephalexin" })
    .first();
  await expect(crossCard).toBeVisible();
  await expect(crossCard).toContainText("cross-reactivity", {
    ignoreCase: true,
  });

  await page.context().close();
});

test("the allergy finding surfaces on Upcoming and stays hidden once dismissed", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DRUG_ALLERGY,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/upcoming");
  const main = page.getByRole("main");

  const finding = main
    .locator('[data-testid^="upcoming-item-allergy-med:"]')
    .filter({ hasText: "Amoxicillin" })
    .first();
  await expect(finding).toBeVisible();

  // Dismiss through the shared OverflowMenu (the portal-mounted menu panel).
  await finding.getByRole("button", { name: "Snooze or dismiss" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: "Dismiss" })
    .click();

  await expect(
    main
      .locator('[data-testid^="upcoming-item-allergy-med:"]')
      .filter({ hasText: "Amoxicillin" })
  ).toHaveCount(0);

  await page.context().close();
});
