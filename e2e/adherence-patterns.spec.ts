import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";
import { workerDbPath } from "./worker-env";

// Issue #45 (domain 3): adherence-PATTERN detection on Supplements & Meds. The seed
// fixture (e2e/seed-events.ts) logs a daily Evening "Vitamin C (e2e)" dose taken
// every day for ~9 weeks EXCEPT every Friday, so the weekday-miss rule fires: "you
// miss your evening dose most Fridays — move it earlier?". A pure lib rule
// (lib/adherence-patterns.ts) surfaced as a dismissible finding on the shared
// findings bus.

test("Supplements & Meds shows an every-Friday adherence pattern (#45)", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");
  // THE PATTERNS DIALOG IS GONE (#3987 phase 2): Manage renders its insights as
  // sections, not as counted badges that open modals, so the finding is simply on
  // the page — inside the Insights section, which is what scopes this.
  const card = page
    .getByTestId("supplement-insights")
    .getByTestId("adherence-findings");
  await expect(card).toBeVisible();
  await expect(card).toContainText(/Vitamin C/i);
  await expect(card).toContainText(/Friday/i);
  await expect(card).toContainText(/morning/i);
});

// Clears any adherence dismissal so the seeded finding is present again — the same
// row-delete the app's own restore path performs (restoreFinding → DELETE FROM
// upcoming_dismissals). The dismiss test below writes a PERSISTENT dismissal
// (dismissAdherencePattern → dismissFinding, keyed "adherence:…") to the shared
// seeded DB and nothing else resets it, so under --repeat-each (one server, one DB)
// repeat #2+ of the presence test would otherwise find the finding already
// dismissed. Resetting before every test makes BOTH the presence and dismiss tests
// idempotent regardless of order/retries; the afterAll leaves the shared DB clean
// for neighbors. Short-lived connection, busy timeout so it never contends with the
// running server (WAL).
function resetAdherenceDismissals(): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE signal_key LIKE 'adherence:%'"
    ).run();
  } finally {
    db.close();
  }
}

test.beforeEach(() => resetAdherenceDismissals());
test.afterAll(() => resetAdherenceDismissals());

// Dismissing an adherence-pattern finding hides it via the shared findings-bus
// store (dismissAdherencePattern → dismissFinding), so it stops rendering.
//
// BOTH the locate and the disappearance assertion are scoped to the INSIGHTS
// SECTION, and the scope is load-bearing rather than tidiness (#1543's vacuous-guard
// rule): a disappearance check scoped to something that never holds the row matches
// zero nodes at every instant and passes even when the dismiss button does nothing
// at all. That is exactly how it read while the findings lived in a portalled modal
// and the check was scoped to <main>. Scope it to the element that actually renders
// the row, and the zero means something.
test("an adherence-pattern finding can be dismissed (#45)", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");
  const insights = page.getByTestId("supplement-insights");
  const finding = insights
    .getByTestId("adherence-findings-item")
    .filter({ hasText: "Vitamin C" });
  await expect(finding).toBeVisible();

  // FindingRow renders a <form action={dismiss}> submit, so this posts a Server
  // Action; the assertion below ran on the 5s default against that round trip.
  await settledClick(page, finding.getByTestId("adherence-findings-dismiss"));

  // The section survives the action's revalidation and re-renders without the
  // dismissed row. Asserting it is still THERE keeps the count below honest: a
  // section that had vanished would make the zero-count vacuous for the same
  // reason a closed dialog did.
  await expect(insights).toBeVisible();
  await expect(
    insights
      .getByTestId("adherence-findings-item")
      .filter({ hasText: "Vitamin C" })
  ).toHaveCount(0);
});
