import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import {
  intakeWarnings,
  expandIntakeWarnings,
  interactionWarnings,
  interactionWarningRows,
  pgxWarnings,
} from "./intake-warnings-helpers";

// Drug-/supplement-interaction checking (issue #144). The seed gives profile 1 a
// known-interacting pair — Warfarin (rxcui-keyed) + Ibuprofen (name-matched), a MAJOR
// bleeding-risk interaction. The Medications page must show a severity-ranked warning row, and
// the SAME finding must appear on Upcoming and stay hidden once dismissed. Assertions
// are scoped to the page's main region; the Upcoming dismiss mutates seeded state, so
// this test owns that side effect for the run.

test("shows the seeded warfarin + ibuprofen interaction warning on /medications", async ({
  page,
}) => {
  await page.goto("/medications");
  const main = page.getByRole("main");
  await expandIntakeWarnings(main);

  const warnings = interactionWarnings(main);
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText("Warfarin");
  await expect(warnings).toContainText("Ibuprofen");
  // Severity + the informational, never-prescriptive framing + a source citation.
  await expect(warnings).toContainText("Major");
  await expect(warnings).toContainText("with your");
  await expect(warnings).toContainText("Source:");
});

// Clears interaction dismissals so the warfarin finding is guaranteed visible at
// the start of EVERY test, regardless of retries, --repeat-each, or a prior run
// against the shared seeded DB (a dismissal persists in upcoming_dismissals — the
// resetPreventiveFixture pattern from #206). This is the #868 fixture-ownership fix:
// the dismiss test below silences the warfarin+ibuprofen finding on the SHARED seed,
// and — because the finding is bus-gated (dismiss once, silence both surfaces) — that
// dismissal used to leak into the FIRST test's "warning is visible" assertion on the
// next repeat. Resetting before each test makes the file own its dismissal state.
// Short-lived connection, busy timeout so it never contends with the running server (WAL).
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

test.beforeEach(() => {
  resetInteractionDismissals();
});

test("the interaction surfaces on Upcoming and stays hidden once dismissed", async ({
  page,
}) => {
  await page.goto("/upcoming");
  const main = page.getByRole("main");

  // The finding is keyed on the item-id pair (`interaction:<lo>-<hi>`); the seed
  // yields several interacting pairs, so select the warfarin+ibuprofen one by text
  // rather than a positional first-match (severity ordering puts other pairs first).
  const finding = main
    .locator('[data-testid^="upcoming-item-interaction:"]')
    .filter({ hasText: "Warfarin" })
    .filter({ hasText: "Ibuprofen" })
    .first(); // first-ok: filtered to the Warfarin+Ibuprofen pair — one match
  await expect(finding).toBeVisible();
  const findingTestId = await finding.getAttribute("data-testid");
  expect(findingTestId).toMatch(/^upcoming-item-interaction:/);

  // The item's menu is the shared OverflowMenu popover (#281): its trigger is a
  // button, and the panel is portaled to <body> — so the Dismiss item is located
  // from the page-level menu role, not inside the row. Open, then dismiss.
  await finding.getByRole("button", { name: "Snooze or dismiss" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: "Dismiss" })
    .click();

  // After the server action + reload, THIS item-id pair is gone. Other tests can
  // add another ibuprofen medication, producing a separate, legitimate
  // Warfarin + Ibuprofen finding that must not make this assertion fail.
  await expect(main.getByTestId(findingTestId!)).toHaveCount(0);
});

// Combination medications (issue #279): the seed's Hyzaar (losartan/HCTZ — a combo
// BRAND with a product-level RxCUI + cached ingredient CUIs) + Klor-Con (potassium
// chloride, name-matched) pair must surface the moderate ace_arb × potassium
// hyperkalemia warning. Before #279 this pair was a silent false negative: the
// single scalar product rxcui matched no ingredient-keyed concept and no synonym
// listed the combo brand.
test("flags the seeded combination-medication pair (Hyzaar + Klor-Con) on /medications", async ({
  page,
}) => {
  await page.goto("/medications");
  const main = page.getByRole("main");
  await expandIntakeWarnings(main);

  const warnings = interactionWarnings(main);
  await expect(warnings).toBeVisible();
  const row = interactionWarningRows(warnings)
    .filter({ hasText: "Hyzaar" })
    .filter({ hasText: "Klor-Con" })
    .first(); // first-ok: filtered to the Hyzaar+Klor-Con pair — one match
  await expect(row).toBeVisible();
  await expect(row).toContainText("MODERATE", { ignoreCase: true });
  await expect(row).toContainText("potassium", { ignoreCase: true });
});

test("scopes intake warnings to the items represented on each surface", async ({
  page,
}) => {
  await page.goto("/medications");
  let main = page.getByRole("main");
  let notices = intakeWarnings(main);
  await expandIntakeWarnings(main);
  await expect(
    interactionWarnings(notices).filter({ hasText: "Calcium + Iron" })
  ).toHaveCount(0);
  await expect(
    interactionWarningRows(notices)
      .filter({ hasText: "Sertraline" })
      .filter({ hasText: "Ibuprofen" })
      .first() // first-ok: filtered to the Sertraline+Ibuprofen pair — one match
  ).toBeVisible();

  await page.goto("/nutrition?tab=supplements");
  main = page.getByRole("main");
  notices = intakeWarnings(main);
  await expandIntakeWarnings(main);
  await expect(
    interactionWarningRows(notices)
      .filter({ hasText: "Calcium" })
      .filter({ hasText: "Iron" })
  ).toBeVisible();
  await expect(
    interactionWarningRows(notices)
      .filter({ hasText: "Sertraline" })
      .filter({ hasText: "Ibuprofen" })
  ).toHaveCount(0);
  await expect(pgxWarnings(notices)).toHaveCount(0);
});
