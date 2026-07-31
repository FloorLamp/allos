import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";
import { expectNoClippedContent } from "./helpers";

// The Longevity pillar card renders the CANONICAL analyte name and leads with the
// VALUE (#1501).
//
// Why this spec plants its own row: shouting case is INVISIBLE in seed data,
// because seed authors write clean `name` values — which is exactly why the bug
// was reported from live data and never caught by a test. So the fixture is a
// reading whose RAW name is shouting case ("TRANSFERRIN SATURATION") but whose
// canonical_name is the vocabulary's clean display text ("Transferrin
// Saturation"). The card must show the clean one; the biomarker detail page's
// "Reported as" column must still show the raw one (provenance is the point there).
//
// Fixture ownership (#868): Transferrin Saturation is absent from the shared seed,
// so this spec's row is the only one of its analyte — no neighbour's assertion can
// see it, and the seeded markers the card already lists are untouched. Synthetic
// data only.
const DB_PATH = workerDbPath();
const RAW_NAME = "TRANSFERRIN SATURATION";
const CANONICAL_NAME = "Transferrin Saturation";
// In the reference range (20–50 %) but above the curated optimal band (25–35 %),
// so the reading lands in the card's "Outside their optimal band" list with a
// directional (up) verdict.
const VALUE = "42";
// Deep past: the card judges the CURRENT reading per analyte with no recency gate,
// and a fixed date keeps the fixture independent of the run's frozen clock.
const READING_DATE = "2023-04-11";

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

function cleanup() {
  withDb((db) =>
    db.prepare("DELETE FROM medical_records WHERE name = ?").run(RAW_NAME)
  );
}

test.beforeAll(() => {
  cleanup();
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, canonical_name, value, value_num, unit)
         VALUES (1, ?, 'lab', ?, ?, ?, ?, '%')`
      )
      .run(READING_DATE, RAW_NAME, CANONICAL_NAME, VALUE, Number(VALUE))
  );
});

test.afterAll(cleanup);

test("the pillar card shows the canonical name and the value, not the raw name and a chip", async ({
  page,
}) => {
  test.slow();
  await page.goto("/longevity");

  const section = page.getByRole("main").getByTestId("longevity-biomarkers");
  await expect(section).toBeVisible();

  const row = section
    .getByTestId("longevity-biomarker-row")
    .filter({ hasText: CANONICAL_NAME })
    .first(); // first-ok: filtered to the analyte THIS spec planted — the only reading of it
  await expect(row).toBeVisible();

  // The clean vocabulary casing, never the lab's shouting case.
  await expect(row.getByRole("link")).toHaveText(CANONICAL_NAME);
  await expect(section).not.toContainText(RAW_NAME);

  // Value-led: the reading + its unit through MedicalValue, with the non-color
  // severity channel (#1220) and the curated optimal band beside it.
  await expect(row).toContainText(`${VALUE} %`);
  await expect(row.getByTestId("medical-flag-text")).toHaveText(
    "Above optimal"
  );
  await expect(row.getByTestId("longevity-biomarker-optimal")).toHaveText(
    "opt 25–35"
  );
  // The old full-width direction chip is gone (both directions used to collapse
  // into one amber badge that never showed the number).
  await expect(row.locator("span.badge")).toHaveCount(0);

  await expectNoClippedContent(page);
});

test("the biomarker detail page still reports the raw name in its provenance column", async ({
  page,
}) => {
  test.slow();
  await page.goto(
    `/biomarkers/view?name=${encodeURIComponent(CANONICAL_NAME)}`
  );
  const main = page.getByRole("main");
  // The heading is the canonical analyte…
  await expect(main).toContainText(CANONICAL_NAME);
  // …and the readings table's "Reported as" column keeps the document's own
  // string, deliberately un-prettified.
  await expect(main).toContainText(RAW_NAME);
});
