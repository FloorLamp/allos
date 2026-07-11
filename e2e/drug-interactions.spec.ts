import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

// Drug-/supplement-interaction checking (issue #144). The seed gives profile 1 a
// known-interacting pair — Warfarin (rxcui-keyed) + Ibuprofen (name-matched), a MAJOR
// bleeding-risk interaction. /medicine must show a severity-ranked warning row, and
// the SAME finding must appear on Upcoming and stay hidden once dismissed. Assertions
// are scoped to the page's main region; the Upcoming dismiss mutates seeded state, so
// this test owns that side effect for the run.

test("shows the seeded warfarin + ibuprofen interaction warning on /medicine", async ({
  page,
}) => {
  await page.goto("/medicine");
  const main = page.getByRole("main");

  const warnings = main.getByTestId("interaction-warnings");
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText("Warfarin");
  await expect(warnings).toContainText("Ibuprofen");
  // Severity + the informational, never-prescriptive framing + a source citation.
  await expect(warnings).toContainText("Major");
  await expect(warnings).toContainText("discuss with your");
  await expect(warnings).toContainText("Source:");
});

// Clears interaction dismissals so the warfarin finding is guaranteed visible at
// the start of the dismiss test, regardless of retries or prior runs against the
// shared seeded DB (a dismissal persists in upcoming_dismissals — the
// resetPreventiveFixture pattern from #206). Short-lived connection, busy timeout
// so it never contends with the running server (WAL).
function resetInteractionDismissals(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE signal_key LIKE 'interaction:%'"
    ).run();
  } finally {
    db.close();
  }
}

test("the interaction surfaces on Upcoming and stays hidden once dismissed", async ({
  page,
}) => {
  resetInteractionDismissals();
  await page.goto("/upcoming");
  const main = page.getByRole("main");

  // The finding is keyed on the item-id pair (`interaction:<lo>-<hi>`); the seed
  // yields several interacting pairs, so select the warfarin+ibuprofen one by text
  // rather than .first() (severity ordering puts other pairs first on Upcoming).
  const finding = main
    .locator('[data-testid^="upcoming-item-interaction:"]')
    .filter({ hasText: "Warfarin" })
    .filter({ hasText: "Ibuprofen" })
    .first();
  await expect(finding).toBeVisible();

  // The item's menu is a native <details> popover whose trigger is a SUMMARY
  // element (aria-label "Snooze or dismiss") — not a button role — with the
  // Dismiss server-action submit inside it. Open the popover, then dismiss.
  await finding.locator('summary[aria-label="Snooze or dismiss"]').click();
  await finding.getByRole("button", { name: "Dismiss" }).click();

  // After the server action + reload, THIS pair's finding is gone — the other
  // seeded interaction pairs legitimately remain.
  await expect(
    main
      .locator('[data-testid^="upcoming-item-interaction:"]')
      .filter({ hasText: "Warfarin" })
      .filter({ hasText: "Ibuprofen" })
  ).toHaveCount(0);
});
