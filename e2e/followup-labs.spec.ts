import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_FLABS,
  E2E_MEMBER_PASSWORD,
  FLAGGED_LAB_PROFILE,
} from "./fixture-logins";

// The finding follow-up loop — FLAGGED LABS adapter (#700): a flagged biomarker →
// a tracked, LEGIBLE "Recheck …" follow-up on Upcoming → a resolution OFFER when a
// later same-family reading lands → close the loop. Drives the real UI end-to-end
// across /biomarkers/view + /upcoming, the labs sibling of e2e/followup.spec.ts.
//
// Fixture discipline (#868): the dedicated FLAGGED_LAB_PROFILE (seed-events) owns ONE
// flagged A1c; a raw-connection cleanup in beforeAll AND afterAll deletes the spec's
// follow-up care_plan_items (BEFORE any medical_records FK parent) and the later eAG
// reading it adds, so the spec only ever touches rows it created and is repeat-safe.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const A1C = "Hemoglobin A1c";
const EAG = "Estimated Average Glucose";
const WAIT = 15_000;

function profileId(handle: Database.Database): number {
  return (
    handle
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(FLAGGED_LAB_PROFILE) as { id: number }
  ).id;
}

// Reset to the clean "seeded flagged A1c, no follow-up, no repeat draw" state.
function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    const pid = profileId(handle);
    // Follow-up care_plan_items FIRST (they REFERENCE medical_records) — remove every
    // labs follow-up on this profile, tracked or already degraded/resolved.
    handle
      .prepare(
        "DELETE FROM care_plan_items WHERE profile_id = ? AND (source_kind = 'labs' OR category = 'follow-up')"
      )
      .run(pid);
    // The later eAG reading the spec lands (the source A1c is re-seeded each boot).
    handle
      .prepare(
        "DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?"
      )
      .run(pid, EAG);
  } finally {
    handle.close();
  }
}

// Land a later same-family (eAG) reading dated ~3 days ago, so the tracked follow-up
// gains a resolving candidate. Raw connection — the same fixture-owned pattern the
// imaging spec uses for its cleanup (no medical add-record UI dependency).
function addLaterReading() {
  const handle = new Database(DB_PATH);
  try {
    const pid = profileId(handle);
    const now = handle.prepare("SELECT date('now') AS d").get() as {
      d: string;
    };
    const later = handle
      .prepare("SELECT date(?, '-3 days') AS d")
      .get(now.d) as { d: string };
    handle
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit, canonical_name, flag, source)
         VALUES (?, ?, 'lab', ?, '126', 126, 'mg/dL', ?, 'normal', 'manual')`
      )
      .run(pid, later.d, EAG, EAG);
  } finally {
    handle.close();
  }
}

test.describe("Finding follow-up loop — flagged labs (#700)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("a flagged lab becomes a tracked, resolvable follow-up", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FLABS,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // 1) The flagged biomarker's detail page offers to track a follow-up.
      await page.goto(`/biomarkers/view?name=${encodeURIComponent(A1C)}`);
      const trackForm = page.getByTestId("track-lab-followup");
      await expect(trackForm).toBeVisible({ timeout: WAIT });

      // 2) Track a 3-month follow-up (source dated ~120d ago ⇒ planned date is OVERDUE).
      await trackForm.getByLabel("Follow-up interval").selectOption("91");
      await settledClick(
        page,
        trackForm.getByRole("button", { name: "Track follow-up" })
      );
      // The detail page now shows the tracked follow-up's state.
      await expect(page.getByTestId("lab-followup-state")).toContainText(
        /Follow-up:/,
        { timeout: WAIT }
      );

      // 3) It surfaces on Upcoming — LEGIBLE: named "Recheck …" for its flagged source.
      await page.goto("/upcoming");
      const item = page
        .locator('[data-testid^="upcoming-item-followup:"]')
        .filter({ hasText: `Recheck ${A1C}` });
      await expect(item).toBeVisible({ timeout: WAIT });
      await expect(item).toContainText("flagged 8.2%", { timeout: WAIT });
      // No resolution offer yet (no later reading on file).
      await expect(
        item.locator('[data-testid^="followup-resolve-"]')
      ).toHaveCount(0);

      // 4) A later same-family (eAG) reading lands ⇒ the follow-up now OFFERS the outcome.
      addLaterReading();
      await page.goto("/upcoming");
      const offering = page
        .locator('[data-testid^="upcoming-item-followup:"]')
        .filter({ hasText: `Recheck ${A1C}` });
      await expect(offering).toBeVisible({ timeout: WAIT });
      const stable = offering.getByRole("button", { name: "Stable" });
      await expect(stable).toBeVisible({ timeout: WAIT });

      // 5) Confirm-first resolve closes the loop — the item drops off Upcoming.
      await settledClick(page, stable);
      await expect(
        page
          .locator('[data-testid^="upcoming-item-followup:"]')
          .filter({ hasText: `Recheck ${A1C}` })
      ).toHaveCount(0, { timeout: WAIT });

      // 6) The biomarker detail page now shows the recorded resolution.
      await page.goto(`/biomarkers/view?name=${encodeURIComponent(A1C)}`);
      await expect(page.getByTestId("lab-followup-state")).toContainText(
        /Follow-up: resolved · stable/,
        { timeout: WAIT }
      );
    } finally {
      await page.context().close();
    }
  });
});
