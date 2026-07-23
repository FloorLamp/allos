import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_DRUG_ALLERGY,
  DRUG_ALLERGY_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { allergyWarnings, allergyWarningRows } from "./intake-warnings-helpers";

// Drug-allergy × medication-stack cross-check (issues #1029, #1092). The dedicated
// fixture profile records a "Penicillin — hives" allergy and tracks amoxicillin
// (same-class hit) + cephalexin (documented cross-reactivity hit). The Medications
// safety strip must render both cards — informational, cited, never prescriptive —
// and the same finding (same dedupeKey) must reach the care-tier Needs-attention hero.
// As a SAFETY signal it is CARE-PERSISTENT (#1092, the #942/#553 stance): a page
// dismissal must NOT permanently silence a live contraindication — the finding
// re-surfaces while both the med is active AND the allergy stands, and only a
// time-boxed snooze defers it (so the hero menu is snooze-only). The fixture login is
// isolated (#868), and dismissals are reset before each test so the spec owns its
// suppression state under --repeat-each.

const DB_PATH =
  process.env.ALLOS_DB_PATH ??
  path.join(process.cwd(), "e2e", ".data", "e2e.db");

// Clear this fixture profile's allergy-med dismissals so the findings are visible at
// the start of EVERY test (the drug-interactions.spec reset pattern — a dismissal
// persists in upcoming_dismissals across repeats). Short-lived connection with a
// busy timeout so it never contends with the running server (WAL).
function resetAllergyDismissals(): void {
  const db = new Database(DB_PATH);
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

// Write a page-dismissal row straight to the shared bus for the amoxicillin allergy
// finding — the same row a "Dismiss" click on any surface would create — so the test
// can prove the care-tier hero RESISTS it (a page dismissal must never permanently
// silence a live contraindication, #1092). Resolves the id-keyed dedupeKey
// (`allergy-med:<allergyId>-<amoxicillinItemId>`) from the seeded rows.
function dismissAmoxicillinAllergyViaBus(): void {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(DRUG_ALLERGY_PROFILE) as { id: number } | undefined;
    if (!profile) throw new Error("drug-allergy fixture profile missing");
    const allergy = db
      .prepare(
        "SELECT id FROM allergies WHERE profile_id = ? AND substance = 'Penicillin'"
      )
      .get(profile.id) as { id: number } | undefined;
    const med = db
      .prepare(
        "SELECT id FROM intake_items WHERE profile_id = ? AND name LIKE 'Amoxicillin%'"
      )
      .get(profile.id) as { id: number } | undefined;
    if (!allergy || !med) throw new Error("drug-allergy fixture rows missing");
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
         VALUES (?, ?, NULL, datetime('now'))
       ON CONFLICT(profile_id, signal_key)
         DO UPDATE SET dismissed_at = datetime('now'), snooze_until = NULL`
    ).run(profile.id, `allergy-med:${allergy.id}-${med.id}`);
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
    .first(); // first-ok: filtered to the Amoxicillin warning — one match for the drug this test set up
  await expect(classCard).toBeVisible();
  await expect(classCard).toContainText("Penicillin");
  await expect(classCard).toContainText("recorded reaction: hives");
  await expect(classCard).toContainText("discuss with your prescriber");
  await expect(classCard).toContainText("Source:");

  // Cross-class hit: cephalexin carries the possible-cross-reactivity framing.
  const crossCard = allergyWarningRows(warnings)
    .filter({ hasText: "Cephalexin" })
    .first(); // first-ok: filtered to the Cephalexin cross-reactivity warning — one match for the drug this test set up
  await expect(crossCard).toBeVisible();
  await expect(crossCard).toContainText("cross-reactivity", {
    ignoreCase: true,
  });

  await page.context().close();
});

test("the allergy finding is a care-persistent Needs-attention item: a page dismissal is resisted, a snooze defers it (#1092)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DRUG_ALLERGY,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");
  const hero = page.getByRole("main").getByTestId("needs-attention");
  await expect(hero).toBeVisible();

  // The care-tier finding lands on the dashboard Needs-attention hero.
  const heroFinding = () =>
    hero
      .locator('[data-testid^="attention-item-allergy-med:"]')
      .filter({ hasText: "Amoxicillin" });
  await expect(heroFinding()).toBeVisible();

  // Its menu is SNOOZE-ONLY: a live contraindication offers time-boxed snoozes but
  // no permanent Dismiss (the #942/#553 safety stance — a dismiss can't silence it).
  await heroFinding()
    .getByRole("button", { name: "Snooze or dismiss" })
    .click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "1 day" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Dismiss" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // A page dismissal written to the shared bus (as any surface's dismiss would) is
  // RESISTED: the live contraindication re-surfaces on the hero while both stand.
  dismissAmoxicillinAllergyViaBus();
  await page.reload();
  await expect(
    page.getByRole("main").getByTestId("needs-attention")
  ).toBeVisible();
  await expect(heroFinding()).toBeVisible();

  // But a deliberate time-boxed SNOOZE still defers it (the honored affordance).
  try {
    await heroFinding()
      .getByRole("button", { name: "Snooze or dismiss" })
      .click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "1 week" })
      .click();
    await expect(page.getByText("Snoozed for 1 week")).toBeVisible();
    await expect(heroFinding()).toHaveCount(0);
  } finally {
    resetAllergyDismissals();
  }

  await page.context().close();
});
