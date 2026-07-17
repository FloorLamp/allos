import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { followLink } from "./helpers";

// #817 Medications page redesign: the Today panel (scheduled dose check-off + PRN
// administration row), the /medications/[id] clinical-record detail page, and the
// "From your records" suggest-only bridge (Track this / dismiss). Fixtures come from
// e2e/seed-events.ts: "Adherence Refill Med (e2e)" (current daily, scheduled),
// "PRN Quicklog Med (e2e)" (PRN with administrations), and two untracked prescription
// records ("E2E Bridge Track Med" / "E2E Bridge Dismiss Med").
//
// #868 fixture ownership: the last two tests MUTATE shared-seed bridge state that
// persists — "Track this" materializes a tracked med from the imported record, and
// "Dismiss" writes a med-bridge suppression to upcoming_dismissals. Both leak into a
// second --repeat-each run (the suggestion is gone → the "suggestion visible" assertion
// fails). resetBridgeState() restores the seeded UNTRACKED state before each test:
// delete any tracked med minted from the bridge record (children cascade) and clear the
// med-bridge dismissals. Short-lived connection + busy timeout so it never contends with
// the running server on the WAL DB. The bridge records sit on the admin's active profile 1.
const BRIDGE_PROFILE_ID = 1;
function resetBridgeState(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON"); // so deleting the tracked med cascades its children
    db.prepare(
      `DELETE FROM intake_items
        WHERE profile_id = ? AND kind = 'medication' AND source = 'extracted'
          AND name LIKE 'E2E Bridge Track%'`
    ).run(BRIDGE_PROFILE_ID);
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'med-bridge:%'"
    ).run(BRIDGE_PROFILE_ID);
  } finally {
    db.close();
  }
}

test.beforeEach(() => {
  resetBridgeState();
});

test("Today panel leads with a due scheduled dose and a PRN administration row", async ({
  page,
}) => {
  await page.goto("/medications");

  const today = page.getByTestId("medications-today");
  await expect(today).toBeVisible();

  // A scheduled, currently-due med shows its tri-state dose check-off inline.
  const scheduled = today
    .getByTestId("today-scheduled-med")
    .filter({ hasText: "Adherence Refill Med (e2e)" });
  await expect(scheduled).toBeVisible();
  await expect(scheduled.getByTestId("dose-status").first()).toBeVisible();

  // A PRN med shows a one-tap administration row (not a scheduled pill).
  await expect(
    today
      .getByTestId("quick-log-prn-item")
      .filter({ hasText: "PRN Quicklog Med (e2e)" })
  ).toBeVisible();
});

test("a medication row links to its clinical-record detail page", async ({
  page,
}) => {
  await page.goto("/medications");

  const link = page
    .getByTestId("medication-row")
    .filter({ hasText: "Adherence Refill Med (e2e)" })
    .getByTestId("medication-row-link");
  await expect(link).toBeVisible();
  const detail = page.getByTestId("medication-detail");
  // Navigate past the pre-hydration swallow (#730/#500) with the blessed followLink (#868).
  await followLink(page, link, /\/medications\/\d+/);
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Adherence Refill Med (e2e)");
  // The detail page is the clinical-record home: its History disclosure (courses +
  // side effects) is open by default.
  await expect(detail).toContainText(/Courses/);
});

test("records bridge tracks an imported prescription that has no tracked med", async ({
  page,
}) => {
  await page.goto("/medications");

  const bridge = page.getByTestId("records-bridge");
  await expect(bridge).toBeVisible();
  const item = bridge
    .getByTestId("records-bridge-item")
    .filter({ hasText: "E2E Bridge Track Med" });
  await expect(item).toBeVisible();

  // "Track this" is a client onClick — retry the tap to ride out the hydration
  // window (#730), asserting the suggestion clears once it lands.
  await expect(async () => {
    await item.getByTestId("records-bridge-track").click();
    await expect(
      page
        .getByTestId("records-bridge-item")
        .filter({ hasText: "E2E Bridge Track Med" })
    ).toHaveCount(0, { timeout: 3000 });
  }).toPass();

  // The tracked med now appears as a current medication row.
  await expect(
    page
      .getByTestId("medication-row")
      .filter({ hasText: "E2E Bridge Track Med" })
  ).toBeVisible();
});

test("records bridge dismisses a suggestion via the findings bus", async ({
  page,
}) => {
  await page.goto("/medications");

  const item = page
    .getByTestId("records-bridge-item")
    .filter({ hasText: "E2E Bridge Dismiss Med" });
  await expect(item).toBeVisible();

  // Dismiss is a client onClick — retry the tap to ride out the hydration window
  // (#730), asserting the suggestion clears once it lands.
  await expect(async () => {
    await item.getByTestId("records-bridge-dismiss").click();
    await expect(item).toHaveCount(0, { timeout: 3000 });
  }).toPass();

  // The dismissal stays gone across a reload (persisted on the findings bus).
  await page.reload();
  await expect(
    page
      .getByTestId("records-bridge-item")
      .filter({ hasText: "E2E Bridge Dismiss Med" })
  ).toHaveCount(0);
});
