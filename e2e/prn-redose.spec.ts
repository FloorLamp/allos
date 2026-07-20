import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

// #798 PRN redose notice + confirm flow. The seed (e2e/seed-events.ts) ships
// "PRN Redose Med (e2e)" — a PRN med with a CONFIRMED redose notice (6h interval,
// max 4/day) and ONE administration ~7h ago, so its redose window is OPEN and both
// the Medications card and the dashboard widget render the status line. The add-form
// test drives the confirm flow: pre-fill the label defaults, opt in, save.
//
// #868 fixture ownership: the "N of 4 today" count is a SHARED-seed tally whose exact
// value drifts near the day boundary (the seeded "~7h ago" administration rolls onto
// yesterday when the suite runs in the early morning, so today's count is 0), so these
// specs assert the count PATTERN (`/\d of 4 today/`) and the max, never a pinned "1 of 4".
// The add-form test creates its own uniquely-named med each run and DB-cleans it in
// afterAll, so a --repeat-each run neither collides on the row nor leaves an
// ibuprofen med behind to skew the neighbor interaction specs.
const REDOSE_MED = "PRN Redose Med (e2e)";

// Name prefix for the meds this spec creates, so afterAll can remove them all.
const ADDED_MED_PREFIX = "Ibuprofen e2e redose";

function deleteAddedMeds(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON"); // cascade the new med's dose/course/log children
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

test("Today panel PRN row surfaces the redose window status line (#798/#817)", async ({
  page,
}) => {
  await page.goto("/medications");

  // The redose status line rides the Today panel's PRN administration row in the
  // #817 redesign (same QuickLogPrnControl the dashboard renders, one computation).
  const prnRow = page
    .getByTestId("medications-today")
    .getByTestId("quick-log-prn-item")
    .filter({ hasText: REDOSE_MED });
  await expect(prnRow).toBeVisible();
  // The window is open (last dose ~7h ago > 6h interval), 1 of 4 today.
  const line = prnRow.getByTestId("prn-redose-line");
  const dayLabel = prnRow.getByTestId("prn-day-label");
  await expect(line).toBeVisible();
  await expect(dayLabel).toContainText("Last dose");
  await expect(dayLabel).not.toContainText(/\d+ today/);
  await expect(line).toHaveClass(/text-slate-600/);
  await expect(line).not.toHaveClass(/text-brand/);
  // Window open (last dose > 6h ago). Assert the count PATTERN + the max, never a
  // pinned "1 of 4" — the seeded count is 0 or 1 depending on the day boundary (#868).
  await expect(line).toContainText("Redose OK");
  await expect(line).toContainText(/\d of 4 today/);
});

test("dashboard PRN widget mirrors the redose status line (#798)", async ({
  page,
}) => {
  await page.goto("/");
  const widget = page.getByTestId("quick-log-prn");
  await expect(widget).toBeVisible();
  const item = widget
    .getByTestId("quick-log-prn-item")
    .filter({ hasText: REDOSE_MED });
  if (!(await item.isVisible())) {
    await widget.getByTestId("quick-log-prn-more").locator("summary").click();
  }
  await expect(item).toBeVisible();
  await expect(item.getByTestId("prn-day-label")).toContainText("Last dose");
  await expect(item.getByTestId("prn-day-label")).not.toContainText(
    /\d+ today/
  );
  await expect(item.getByTestId("prn-redose-line")).toContainText("Redose OK");
});

test("med form: confirm flow pre-fills OTC label defaults and opts in (#798)", async ({
  page,
}) => {
  await page.goto("/medications");

  await page.getByTestId("medication-add-toggle").click();
  await page.getByTestId("medication-add-full").click();
  const addCard = page.getByTestId("medication-add-panel");
  await expect(addCard).toBeVisible();

  // Name an ingredient the curated dataset knows so the pre-fill affordance appears.
  // Unique per run (#868) so a --repeat-each run doesn't collide on the row below;
  // afterAll DB-cleans every "Ibuprofen e2e redose*" this spec minted.
  const name = `${ADDED_MED_PREFIX} ${Date.now()}-${Math.floor(
    Math.random() * 1e6
  )}`;
  await addCard.getByLabel("Name").fill(name);

  // Marking it PRN reveals the redose-notice block.
  await addCard.getByRole("checkbox", { name: /As needed/ }).check();
  const block = addCard.getByTestId("redose-block");
  await expect(block).toBeVisible();

  // "Use label defaults" pre-fills the CONFIRMED numbers (ibuprofen: 6h / max 4).
  await addCard.getByTestId("redose-prefill").click();
  await expect(addCard.getByTestId("redose-interval")).toHaveValue("6");
  await expect(addCard.getByTestId("redose-max")).toHaveValue("4");

  // The user explicitly opts in (the liability confirm) and saves.
  await addCard.getByTestId("redose-optin").check();
  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  // The new PRN med appears as a current medication row (#817).
  await expect(
    page.getByTestId("medication-row").filter({ hasText: name })
  ).toBeVisible();
});
