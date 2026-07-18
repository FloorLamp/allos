import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_IOP,
  E2E_MEMBER_PASSWORD,
  FLAGGED_IOP_PROFILE,
} from "./fixture-logins";

// The finding follow-up loop — IOP glaucoma adapter (#698 §6 / Part of #700): a flagged
// intraocular pressure → a tracked, LEGIBLE "Recheck IOP / glaucoma workup" on Upcoming
// → a resolution OFFER when a later pressure (either eye) lands → close the loop. Drives
// the real UI end-to-end across /biomarkers/view + /upcoming, the eye-care sibling of
// e2e/followup-labs.spec.ts.
//
// Fixture discipline (#868): the dedicated FLAGGED_IOP_PROFILE (seed-events) owns ONE
// flagged right-eye IOP; a raw-connection cleanup in beforeAll AND afterAll deletes the
// spec's follow-up care_plan_items (BEFORE any medical_records FK parent) and the later
// left-eye reading it adds, so the spec only touches rows it created and is repeat-safe.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const IOP_OD = "Intraocular Pressure, Right Eye";
const IOP_OS = "Intraocular Pressure, Left Eye";
const WAIT = 15_000;

function profileId(handle: Database.Database): number {
  return (
    handle
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(FLAGGED_IOP_PROFILE) as { id: number }
  ).id;
}

// Reset to the clean "seeded flagged IOP, no follow-up, no repeat pressure" state.
function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    const pid = profileId(handle);
    // Follow-up care_plan_items FIRST (they REFERENCE medical_records) — remove every
    // IOP follow-up on this profile, tracked or already degraded/resolved.
    handle
      .prepare(
        "DELETE FROM care_plan_items WHERE profile_id = ? AND (source_kind = 'iop' OR category = 'follow-up')"
      )
      .run(pid);
    // The later left-eye reading the spec lands (the source right-eye IOP is re-seeded
    // each boot).
    handle
      .prepare(
        "DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?"
      )
      .run(pid, IOP_OS);
  } finally {
    handle.close();
  }
}

// Land a later LEFT-eye pressure dated ~3 days ago, so the tracked follow-up gains a
// resolving candidate (bilateral — a workup covers both eyes).
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
         VALUES (?, ?, 'vitals', ?, '17', 17, 'mmHg', ?, 'normal', 'manual')`
      )
      .run(pid, later.d, IOP_OS, IOP_OS);
  } finally {
    handle.close();
  }
}

test.describe("Finding follow-up loop — flagged IOP (#698 §6)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("a flagged IOP becomes a tracked, resolvable glaucoma follow-up", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_IOP,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // 1) The flagged IOP's detail page offers to track a glaucoma follow-up.
      await page.goto(`/biomarkers/view?name=${encodeURIComponent(IOP_OD)}`);
      const trackForm = page.getByTestId("track-iop-followup");
      await expect(trackForm).toBeVisible({ timeout: WAIT });

      // 2) Track a 3-month follow-up (source dated ~120d ago ⇒ planned date is OVERDUE).
      await trackForm.getByLabel("Follow-up interval").selectOption("91");
      await settledClick(
        page,
        trackForm.getByRole("button", { name: "Track glaucoma follow-up" })
      );
      // The detail page now shows the tracked follow-up's state.
      await expect(page.getByTestId("iop-followup-state")).toContainText(
        /Follow-up:/,
        { timeout: WAIT }
      );

      // 3) It surfaces on Upcoming — LEGIBLE: the glaucoma workup, named for its source.
      await page.goto("/upcoming");
      const item = page
        .locator('[data-testid^="upcoming-item-followup:"]')
        .filter({ hasText: "Recheck IOP / glaucoma workup" });
      await expect(item).toBeVisible({ timeout: WAIT });
      await expect(item).toContainText("flagged 28 mmHg", { timeout: WAIT });
      // No resolution offer yet (no later reading on file).
      await expect(
        item.locator('[data-testid^="followup-resolve-"]')
      ).toHaveCount(0);

      // 4) A later LEFT-eye pressure lands ⇒ the follow-up now OFFERS the outcome.
      addLaterReading();
      await page.goto("/upcoming");
      const offering = page
        .locator('[data-testid^="upcoming-item-followup:"]')
        .filter({ hasText: "Recheck IOP / glaucoma workup" });
      await expect(offering).toBeVisible({ timeout: WAIT });
      const stable = offering.getByRole("button", { name: "Stable" });
      await expect(stable).toBeVisible({ timeout: WAIT });

      // 5) Confirm-first resolve closes the loop — the item drops off Upcoming.
      await settledClick(page, stable);
      await expect(
        page
          .locator('[data-testid^="upcoming-item-followup:"]')
          .filter({ hasText: "Recheck IOP / glaucoma workup" })
      ).toHaveCount(0, { timeout: WAIT });

      // 6) The biomarker detail page now shows the recorded resolution.
      await page.goto(`/biomarkers/view?name=${encodeURIComponent(IOP_OD)}`);
      await expect(page.getByTestId("iop-followup-state")).toContainText(
        /Follow-up: resolved · stable/,
        { timeout: WAIT }
      );
    } finally {
      await page.context().close();
    }
  });
});
