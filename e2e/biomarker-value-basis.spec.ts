import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// A COLOURED BIOMARKER VALUE CAN POINT AT ITS BASIS (#2340).
//
// WHAT WAS WRONG. The detail page coloured its latest value from the stored flag but
// built its range display exclusively from the CURATED catalog entry. On an analyte
// the catalog deliberately declines to band, that list is empty and no range rendered
// at all — while the range the flag came from sat on the row, in
// `medical_records.reference_range`, unread by this surface. The reader saw an
// alarming value and no basis for the alarm.
//
// And the same page printed prose about the analyte twice: the curated `note` in the
// header subtitle, the curated `description` in the explainer card fifteen lines
// below, near-paraphrases of each other. The note's one distinct clause — WHY there
// is no band — was the most useful sentence on the page and the one buried furthest
// from where it is asked.
//
// Fixture hygiene (#868): every row here is this spec's OWN, tagged by a source no
// other fixture uses, and removed afterwards. No exact counts of shared-seed
// aggregates.

const DB_PATH = workerDbPath();
const SOURCE = "e2e-basis-2340";
// Two analytes the curated catalog declines to band, which is exactly when the
// curated range list is guaranteed empty: one whose documents printed their own
// range, one whose document printed nothing.
const REPORTED = "Leptin";
const BARE = "Creatinine, Urine";

function withDb<T>(fn: (handle: Database.Database, pid: number) => T): T {
  const handle = new Database(DB_PATH);
  try {
    const pid = (
      handle.prepare("SELECT id FROM profiles ORDER BY id LIMIT 1").get() as {
        id: number;
      }
    ).id;
    return fn(handle, pid);
  } finally {
    handle.close();
  }
}

function cleanup() {
  withDb((handle) => {
    handle.prepare("DELETE FROM medical_records WHERE source = ?").run(SOURCE);
  });
}

test.beforeEach(() => {
  cleanup();
  withDb((handle, pid) => {
    const insert = handle.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value, value_num, unit,
          reference_range, flag, source)
       VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // Two draws of one band-less analyte carrying DIFFERENT printed ranges — the
    // issue's own evidence that the source's range is the only range that ever
    // applied to that draw, and why the catalog publishes none. Each keeps the flag
    // its document's range produced; nothing canonical can re-derive it.
    insert.run(
      pid,
      "2026-01-06",
      REPORTED,
      REPORTED,
      "1.8",
      1.8,
      "ng/mL",
      "3.0-15.0 ng/mL",
      "low",
      SOURCE
    );
    insert.run(
      pid,
      "2026-02-17",
      REPORTED,
      REPORTED,
      "2.1",
      2.1,
      "ng/mL",
      "0.5-13.8 ng/mL",
      "low",
      SOURCE
    );
    // A flagged reading whose document printed no range at all: nothing anywhere on
    // the page can say what it is low against.
    insert.run(
      pid,
      "2026-02-17",
      BARE,
      BARE,
      "42",
      42,
      "mg/dL",
      null,
      "low",
      SOURCE
    );
  });
});

test.afterEach(() => {
  cleanup();
});

test("a band-less analyte shows the source's own range, attributed, and keeps its colour", async ({
  page,
}) => {
  await page.goto(`/biomarkers/view?name=${encodeURIComponent(REPORTED)}`);

  const value = page.getByTestId("biomarker-latest-value");
  await expect(value).toBeVisible();
  await expect(value).toHaveAttribute("data-basis", "reported");

  // The range the flag actually came from, named as the LAB's — not a population
  // band the app endorses.
  const reported = page.getByTestId("biomarker-reported-range");
  await expect(reported).toBeVisible();
  await expect(reported).toContainText("Reference range (as reported)");
  await expect(reported).toContainText("0.5-13.8 ng/mL");

  // The flag survives, because it now has something on screen to point at. On the
  // header value the severity rides in an `sr-only` span; on the readings table
  // #2343 renders it as text.
  const word = value.getByTestId("medical-flag-text");
  await expect(word).toBeVisible();
  await expect(word).toHaveText("Low");
  const rows = page.getByRole("row").filter({ hasText: "3.0-15.0 ng/mL" });
  await expect(rows).toHaveCount(1);
  const olderWord = rows.getByTestId("medical-flag-text");
  await expect(olderWord).toBeVisible();
  await expect(olderWord).toHaveText("Low");
});

test("a reading with no band and no printed range is not coloured, and claims no severity", async ({
  page,
}) => {
  await page.goto(`/biomarkers/view?name=${encodeURIComponent(BARE)}`);

  const value = page.getByTestId("biomarker-latest-value");
  await expect(value).toBeVisible();
  await expect(value).toContainText("42");
  await expect(value).toHaveAttribute("data-basis", "none");

  // No range renders — that is the whole point — so no colour and no severity word
  // may be claimed either. #2343 made that word VISIBLE on the readings table, which
  // is precisely why the suppression happens at the flag: an unexplained red would
  // otherwise have become an unexplained red plus the word "Low".
  await expect(page.getByTestId("biomarker-reported-range")).toHaveCount(0);
  // Not even in the accessibility tree: the suppression is at the flag, so the
  // sr-only severity span the header would otherwise carry is gone too.
  await expect(value.getByTestId("medical-flag-text")).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: "42 mg/dL" });
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("medical-flag-text")).toHaveCount(0);
  await expect(row.locator('[data-basis="none"]')).toBeVisible();
});

test("the page explains the analyte once, and says why it has no band beside the missing band", async ({
  page,
}) => {
  await page.goto(`/biomarkers/view?name=${encodeURIComponent(REPORTED)}`);

  // The explainer card keeps the educational description.
  const explainer = page.getByTestId("biomarker-explainer");
  await expect(explainer).toBeVisible();
  await expect(explainer).toContainText("hormone released by fat tissue");

  // The subtitle no longer repeats it in the curated note's slightly different
  // words — the duplication the issue is about.
  await expect(page.getByText("hormone made by fat tissue")).toHaveCount(0);
  const subtitle = page.getByText("2 readings", { exact: true });
  await expect(subtitle).toBeVisible();

  // And the note's one distinct clause is now where the band is missing, in the
  // summary card beside the value and the attributed range.
  const bandNote = page.getByTestId("biomarker-band-note");
  await expect(bandNote).toBeVisible();
  await expect(bandNote).toContainText("No reference band.");
  await expect(bandNote).toContainText("no single reference band applies");
});
