import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";
// #384 — "Recorded allergies" must collapse cross-document twins like its
// clinical-list siblings. The e2e fixture (e2e/seed-events.ts) plants the same
// "E2E Ragweed" allergy twice (one manual, one from the browser document); the
// manager table must show it ONCE. The merged "Known allergies" card renders
// substances in <li>/<span> (not table cells), so scoping to table cells isolates
// the Recorded-allergies manager.
test("recorded-allergies manager collapses cross-document twins (#384)", async ({
  page,
}) => {
  await page.goto("/records/problems/allergies");
  await expect(
    page.getByRole("cell", { name: "E2E Ragweed", exact: true })
  ).toHaveCount(1);
});

// #1405 — allergy safety attributes. The fixture plants ONE allergy carrying
// criticality 'high', verification 'refuted', and TWO graded manifestations. All
// three are facts the old single-`reaction` shape could not hold, and the refuted
// one is load-bearing: the row must stay on the management table (so the user can
// see and undo the refutation) while dropping OUT of the merged known-allergies
// view that feeds the passport, the emergency card, and the drug screen.
const SAFETY_ALLERGEN = "E2E Refuted Allergen";

test("a refuted allergy stays on the manager but leaves the known-allergies view (#1405)", async ({
  page,
}) => {
  await page.goto("/records/problems/allergies");

  const row = page.getByRole("row").filter({ hasText: SAFETY_ALLERGEN });
  await expect(row).toHaveCount(1);
  // Both graded manifestations render, not just the cached first one.
  await expect(row).toContainText("Hives (moderate)");
  await expect(row).toContainText("Anaphylaxis (severe)");
  // Criticality and the refutation are both stated, including WHY it stopped gating.
  await expect(row).toContainText("High criticality");
  await expect(row).toContainText("Refuted");
  await expect(row).toContainText("not screening");

  // The merged "Known allergies & sensitizations" card renders substances in
  // <li>/<span>, never table cells — so a non-cell match would mean it leaked into
  // the passport-facing view.
  await expect(page.getByText(SAFETY_ALLERGEN, { exact: true })).toHaveCount(1);
});

const CORROBORATED_ALLERGEN = "E2E Corroborated";
const CORROBORATING_MARKER = `${CORROBORATED_ALLERGEN} IgE`;

function clearCorroboratedFixture() {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "DELETE FROM allergies WHERE profile_id = 1 AND substance = ?"
    ).run(CORROBORATED_ALLERGEN);
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = 1 AND name = ?"
    ).run(CORROBORATING_MARKER);
  } finally {
    db.close();
  }
}

test("a documented allergy keeps its corroborating IgE evidence", async ({
  page,
}) => {
  clearCorroboratedFixture();
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, status)
       VALUES (1, ?, 'active')`
    ).run(CORROBORATED_ALLERGEN);
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, flag, source)
       VALUES (1, '2026-07-30', 'lab', ?, 'Class 3', 3, 'high', 'manual')`
    ).run(CORROBORATING_MARKER);
  } finally {
    db.close();
  }

  try {
    await page.goto("/records/problems/allergies");
    await expect(
      page.getByRole("cell", { name: CORROBORATED_ALLERGEN, exact: true })
    ).toBeVisible();
    const sensitizations = page
      .getByRole("heading", { name: "Lab sensitizations" })
      .locator("..");
    await expect(sensitizations).toContainText(CORROBORATED_ALLERGEN);
    await expect(sensitizations).toContainText(CORROBORATING_MARKER);
    await expect(sensitizations).toContainText("Class 3");
  } finally {
    clearCorroboratedFixture();
  }
});
