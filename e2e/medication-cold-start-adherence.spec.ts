import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";
import { medicationRow } from "./med-card-helpers";
import { workerDbPath } from "./worker-env";

// #1442 — the cold-start adherence label, end to end. Quick-adding a medication used
// to render "0% adherence" on its brand-new Current-medications row: the worst
// possible number for "no history yet" (the #1433 cold-start mislabeling class). The
// 14-day strip scored the days BEFORE the item existed as outright misses, so the
// denominator was never empty and the card's null-guard never fired.
//
// The boundary the fix draws — "no applicable slot has elapsed" (no history, line
// hidden) vs "slots elapsed and none taken" (an honest 0%) — is pinned in the pure
// and action tiers. This spec proves the RENDERED surface: the fresh row shows no
// percentage at all, while the seeded med that really does have history still does
// (so the assertion can't pass vacuously against a broken selector).
//
// #868 fixture ownership: the spec MINTS a uniquely-named med each run and DB-cleans
// every med it minted in afterAll, so a --repeat-each run neither collides on the row
// nor leaves a med behind to skew the neighbouring medication specs. No shared-seed
// row is counted; the one shared row it READS is asserted only for presence.
const ADDED_MED_PREFIX = "Coldstart Med e2e";

// The seeded med with a deterministic run of all-taken logs (e2e/seed-events.ts, the
// #747 parity fixture) — real history, so its row keeps its percentage.
const SEEDED_MED_WITH_HISTORY = "Adherence Refill Med (e2e)";

function deleteAddedMeds(): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON"); // cascade the med's dose/log children
    db.prepare(
      `DELETE FROM intake_items
        WHERE profile_id = 1 AND kind = 'medication' AND name LIKE ?`
    ).run(`${ADDED_MED_PREFIX}%`);
  } finally {
    db.close();
  }
}

test.afterAll(() => {
  deleteAddedMeds();
});

test("a just-added medication shows no adherence percentage, not 0% (#1442)", async ({
  page,
}) => {
  test.slow();
  await page.goto("/medications");

  // A synthetic name that matches no OTC dataset entry, so nothing is prefilled and
  // the med stays SCHEDULED (a PRN med is never due, which would hide the line for
  // an unrelated reason and make the test prove nothing).
  const nameStamp = Date.now(); // clock-ok: unique medication-name suffix, never a stored timestamp
  const name = `${ADDED_MED_PREFIX} ${nameStamp}-${Math.floor(Math.random() * 1e6)}`;

  await page.getByTestId("medication-add-toggle").click();
  await page.getByTestId("medication-add-quick").click();
  const addCard = page.getByTestId("quick-add-medication");
  await expect(addCard).toBeVisible();
  await addCard.getByLabel("Medication").fill(name);
  await addCard.getByTestId("quick-add-amount").fill("200 mg");
  await expect(addCard.getByTestId("quick-add-prn")).not.toBeChecked();

  await settledClick(
    page,
    addCard.getByRole("button", { name: "Quick add", exact: true })
  );

  // The new med's row renders — and carries NO adherence percentage. Nothing has
  // come due yet, so there is no follow-through to report.
  const freshRow = medicationRow(page, name);
  await expect(freshRow).toBeVisible();
  // Copy-agnostic: no percentage of ANY phrasing (the summary copy changed in the
  // nutrition redesign — "N% adherence" became "… due days followed · N%").
  await expect(freshRow).not.toContainText(/\d+%/);

  // Control: the seeded med that DOES have logged history still reports its
  // percentage, so the assertion above is about this med's cold start and not a
  // selector that stopped matching or a line that vanished for everyone.
  await expect(medicationRow(page, SEEDED_MED_WITH_HISTORY)).toContainText(
    /\d+%/
  );

  // Still no percentage on a fresh server render (the strip is server-computed, so a
  // reload is the honest check that the gather — not just the first paint — is fixed).
  await page.reload();
  await expect(medicationRow(page, name)).not.toContainText(/\d+%/);
});
