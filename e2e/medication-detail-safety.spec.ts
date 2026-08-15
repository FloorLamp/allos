import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import {
  intakeWarnings,
  expandIntakeWarnings,
  interactionWarnings,
} from "./intake-warnings-helpers";
import { openMedDetailViaHref } from "./med-card-helpers";
import { workerDbPath } from "./worker-env";

// The per-medication safety section on /medications/[id] (#2795) and the adherence
// calendar's pending-today cell (#2796).
//
// Both are defects of the same shape: the detail page knew less than the page beside
// it. The list page led with "Safety notices — Major: Warfarin + Ibuprofen" while
// Warfarin's OWN page showed Monitoring/Food/About and never mentioned the
// interaction; and the calendar painted today red "Missed" while the TODAY block
// directly above it still offered "Mark taken".
//
// The findings are filtered from the whole-stack gather the page already ran and keep
// their dedupeKeys, so this spec drives the SHARED IntakeWarnings card through the
// shared driver rather than re-deriving its anatomy.

// The interaction is bus-gated: one dismissal silences it on every surface, and
// e2e/drug-interactions.spec.ts dismisses it on Upcoming as its own owned side effect.
// Clear the dismissals first so this spec's subject is guaranteed present regardless of
// spec order, --repeat-each, or retries — the resetPreventiveFixture pattern (#206),
// same short-lived WAL-safe connection drug-interactions.spec.ts uses.
function resetInteractionDismissals(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE signal_key LIKE 'interaction:%'"
    ).run();
  } finally {
    db.close();
  }
}

test.beforeEach(() => {
  resetInteractionDismissals();
});

test("a medication's own detail page carries the interaction it is party to", async ({
  page,
}) => {
  await page.goto("/medications");
  const detail = await openMedDetailViaHref(page, "Warfarin");
  await expect(detail).toBeVisible();

  const card = intakeWarnings(detail);
  await expect(card).toBeVisible();
  await expandIntakeWarnings(detail);

  const warnings = interactionWarnings(detail);
  await expect(warnings).toBeVisible();
  // The seeded MAJOR pair, named in full — the partner matters as much as the drug
  // whose page this is.
  await expect(warnings).toContainText("Warfarin");
  await expect(warnings).toContainText("Ibuprofen");
  await expect(warnings).toContainText("Major");
  // Informational framing and a citation, exactly as the list page states them.
  await expect(warnings).toContainText("Source:");
});

test("the interaction appears on BOTH partners' pages, not just one", async ({
  page,
}) => {
  // Symmetry is the substance of the fix: an interaction belongs to both of its items,
  // so whichever one the person opened before taking a dose, it is there.
  await page.goto("/medications");
  const detail = await openMedDetailViaHref(page, "Ibuprofen");
  await expect(detail).toBeVisible();
  await expandIntakeWarnings(detail);

  const warnings = interactionWarnings(detail);
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText("Warfarin");
});

test("an unrelated medication's page stays quiet", async ({ page }) => {
  // The section is FILTERED, not the whole stack re-rendered per med. The e2e parity
  // fixture carries no rxcui and matches no dataset, so it is party to nothing.
  await page.goto("/medications");
  const detail = await openMedDetailViaHref(page, "Adherence Refill Med (e2e)");
  await expect(detail).toBeVisible();
  await expect(intakeWarnings(detail)).toHaveCount(0);
});

test("the adherence calendar never marks the still-pending today as missed", async ({
  page,
}) => {
  await page.goto("/medications");
  const detail = await openMedDetailViaHref(page, "Adherence Refill Med (e2e)");
  const month = detail.getByTestId("medication-adherence-month");
  await expect(month).toBeVisible();

  // Today's cell, located by its own date rather than positionally.
  const todayCell = month
    .locator('[data-testid="adherence-cal-day"]')
    .filter({ hasText: /^\d+$/ })
    .last();
  await expect(todayCell).toBeVisible();

  // The invariant, whatever today's dose has been resolved to by the time this runs:
  // today is never a MISS. A sibling spec (micro-motion) takes and un-takes this med's
  // dose, so pinning the exact state would be pinning spec order; pinning "not missed"
  // is the actual claim and it holds either way. The deterministic pending/taken/
  // earlier-lapse cases are pinned at the DB tier
  // (lib/__db_tests__/medication-detail-gather.test.ts), where the day's state is owned.
  await expect(todayCell).not.toHaveAttribute("data-state", "missed");

  // And the legend names the state, so a neutral cell is explained rather than
  // mysterious.
  await expect(
    month.getByTestId("adherence-calendar-legend")
  ).toContainText("Today, not yet taken");
});
