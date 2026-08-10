import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { hydratedClick, settledClick } from "./helpers";
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
  const badge = page.getByTestId("supplement-patterns-badge");
  await expect(badge).toHaveAttribute("aria-haspopup", "dialog");
  await expect(badge).not.toHaveAttribute("aria-expanded", /.*/);
  // Pure client launcher (InsightLauncher onClick -> setOpen), clicked straight
  // after goto, so the click can be lost in the hydration window.
  await hydratedClick(page, badge);
  const dialog = page.getByRole("dialog", { name: "Patterns" });
  const card = dialog.getByTestId("adherence-findings");
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
test("an adherence-pattern finding can be dismissed (#45)", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");
  const main = page.getByRole("main");
  await hydratedClick(page, main.getByTestId("supplement-patterns-badge"));
  const finding = page
    .getByRole("dialog", { name: "Patterns" })
    .getByTestId("adherence-findings-item")
    .filter({ hasText: "Vitamin C" });
  await expect(finding).toBeVisible();

  // FindingRow renders a <form action={dismiss}> submit, so this posts a Server
  // Action; the assertion below ran on the 5s default against that round trip.
  await settledClick(page, finding.getByTestId("adherence-findings-dismiss"));

  await expect(
    main.getByTestId("adherence-findings-item").filter({ hasText: "Vitamin C" })
  ).toHaveCount(0);
});
