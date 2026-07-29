import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { hydratedClick, settledFill, settledSelect } from "./helpers";
import { workerDbPath } from "./worker-env";

// The lab RESULT LIFECYCLE on the surfaces a user actually reads (#1404).
//
// Two behaviors, both previously impossible:
//   1. A re-issued (corrected/amended) result used to overwrite the value the user
//      had already read, leaving nothing behind. The superseded value is now
//      preserved beside its reading and shown on the biomarker detail page — while
//      staying OUT of the readings themselves (it must never chart or count).
//   2. A reading could not say whether it was drawn fasting, from what specimen, or
//      where it sat in the lab's own lifecycle. The record form now round-trips all
//      three, and the detail page shows exactly what the source stated — nothing
//      invented for a reading that stated nothing.
//
// Fixture hygiene (#868): every row this spec touches is its OWN, under names no
// seed uses, on a DEEP-PAST date; cleanup removes them by name. No exact counts of
// shared-seed aggregates.

const DB_PATH = workerDbPath();
const DRAW_DATE = "2026-01-12";
const CORRECTED = "E2E Lifecycle Potassium";
const FASTING = "E2E Lifecycle Fasting Glucose";
const BIOMARKERS = "/results/biomarkers";

function profileId(handle: Database.Database): number {
  return (
    handle.prepare("SELECT id FROM profiles ORDER BY id LIMIT 1").get() as {
      id: number;
    }
  ).id;
}

function withDb<T>(fn: (handle: Database.Database, pid: number) => T): T {
  const handle = new Database(DB_PATH);
  try {
    return fn(handle, profileId(handle));
  } finally {
    handle.close();
  }
}

function cleanup() {
  withDb((handle, pid) => {
    // A raw connection defaults to foreign_keys = OFF, so the ON DELETE CASCADE
    // that clears lineage at runtime does NOT fire here — clear the children first.
    handle
      .prepare(
        `DELETE FROM medical_record_revisions WHERE record_id IN (
           SELECT id FROM medical_records WHERE profile_id = ? AND name IN (?, ?))`
      )
      .run(pid, CORRECTED, FASTING);
    handle
      .prepare(
        "DELETE FROM medical_records WHERE profile_id = ? AND name IN (?, ?)"
      )
      .run(pid, CORRECTED, FASTING);
  });
}

// A reading whose value was re-issued by the lab: the live row carries the CORRECTED
// number and status, and the number it replaced is preserved beside it — the exact
// state upsertVitals leaves behind after a corrected re-import.
function seedCorrectedReading() {
  withDb((handle, pid) => {
    const id = Number(
      handle
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, canonical_name, value, value_num, unit,
              result_status, fasting, specimen, source, external_id)
           VALUES (?, ?, 'lab', ?, ?, '4.4', 4.4, 'mmol/L', 'corrected', 0, 'Serum',
                   'e2e-lab-feed', 'e2e-lab-feed:k:2026-01-12')`
        )
        .run(pid, DRAW_DATE, CORRECTED, CORRECTED).lastInsertRowid
    );
    handle
      .prepare(
        `INSERT INTO medical_record_revisions
           (record_id, date, value, value_num, unit, result_status,
            superseded_by_status, source, superseded_at)
         VALUES (?, ?, '5.2', 5.2, 'mmol/L', 'final', 'corrected', 'e2e-lab-feed',
                 '2026-01-14 09:00:00')`
      )
      .run(id, DRAW_DATE);
  });
}

test.describe("lab result lifecycle (#1404)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("a corrected reading shows what it replaced, without charting it", async ({
    page,
  }) => {
    seedCorrectedReading();
    await page.goto(`/biomarkers/view?name=${encodeURIComponent(CORRECTED)}`);

    // The CURRENT value is the corrected one, stated as corrected + how it was drawn.
    const attributes = page.getByTestId("reading-attributes");
    await expect(attributes).toContainText("Corrected");
    await expect(attributes).toContainText("Non-fasting");
    await expect(attributes).toContainText("Serum");

    // …and the value it replaced is visible rather than lost.
    const revision = page.getByTestId("reading-revision");
    await expect(revision).toHaveCount(1);
    await expect(revision).toContainText("was 5.2 mmol/L");
    await expect(revision).toContainText("Corrected");

    // The superseded value is PROVENANCE, not an observation: the readings table
    // holds exactly one row for this analyte — the live, corrected one.
    const rows = page.locator("tbody tr", { hasText: "4.4" });
    await expect(rows).toHaveCount(1);
  });

  test("the record form round-trips fasting, specimen and result status", async ({
    page,
  }) => {
    await page.goto(
      `${BIOMARKERS}?new=1&name=${encodeURIComponent(FASTING)}#add-result`
    );
    const form = page.locator("#add-result");
    await expect(form.getByLabel("Name", { exact: true })).toHaveValue(FASTING);

    // DateField DISPLAYS a friendly format ("Jan 12, 2026") while posting the ISO
    // value, so it is filled directly rather than through settledFill's readback.
    await form.getByLabel("Date", { exact: true }).fill(DRAW_DATE);
    await settledFill(page, form.getByLabel("Value", { exact: true }), "92");
    await settledFill(page, form.getByLabel("Unit", { exact: true }), "mg/dL");
    await settledSelect(
      page,
      form.getByTestId("record-result-status"),
      "final"
    );
    await settledSelect(page, form.getByTestId("record-fasting"), "1");
    // The specimen picker is the shared free-text Combobox: typing opens its
    // suggestion list, which would cover the submit button — Escape closes the list
    // and keeps the typed value (the free-text contract).
    await settledFill(
      page,
      form.getByLabel("Specimen", { exact: true }),
      "Plasma"
    );
    await page.keyboard.press("Escape");
    await hydratedClick(
      page,
      form.getByRole("button", { name: "Save record" })
    );

    // What the user said about the draw survives the write and reads back on the
    // analyte's own page.
    await page.goto(`/biomarkers/view?name=${encodeURIComponent(FASTING)}`);
    const attributes = page.getByTestId("reading-attributes");
    await expect(attributes).toContainText("Final");
    await expect(attributes).toContainText("Fasting");
    await expect(attributes).toContainText("Plasma");
    // Nothing was invented: an unstated reading shows no lineage line.
    await expect(page.getByTestId("reading-revision")).toHaveCount(0);
  });
});
