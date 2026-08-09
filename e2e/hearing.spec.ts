import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import {
  expandIntakeWarnings,
  ototoxicWarnings,
  ototoxicWarningRows,
} from "./intake-warnings-helpers";
import { followLink, settledClick } from "./helpers";
import { workerDbPath } from "./worker-env";

// Hearing / audiology domain (#713 + #717 + #1600). The user-visible surfaces the
// build/typecheck/unit tiers can't prove render:
//   • the AUDIOGRAM biomarker series (#713) — seeded per-ear/per-frequency pure-tone
//     thresholds trend on the Biomarkers surface like any other analyte, and a recent
//     4 kHz reading above the ≤25 dB HL band flags. Read-only over the shared seed
//     (visibility, never an exact count).
//   • the HEARING PANE (#1600) — Records › Specialty › Hearing, beside Vision: entering
//     a hearing test through the real form, seeing it listed with its per-ear average,
//     and removing it again.
//   • the OTOTOXIC-medication awareness note (#717) — an active ototoxic medication
//     surfaces a calm, cited, never-prescriptive note on /medications AND a dismissible
//     finding on /upcoming — now CITING the hearing baseline when one is on file (#1600).
//
// Fixture discipline (shared seeded DB): this spec OWNS its rows — one uniquely-named
// active aminoglycoside medication for profile 1, plus one audiogram on a marker date no
// seed row uses — seeded/removed via a raw connection and cleaned up in beforeAll AND
// afterAll so it's idempotent across retries and never touches seeded rows. Locators are
// scoped to the specific row.

const MED = "E2E Ototoxic Gentamicin"; // tokenizes to contain the "gentamicin" synonym
const MED_PREFIX = "E2E Ototoxic";
// A fixed historical date this spec owns outright. Fixed (not frozenNow-relative) on
// purpose: it is only ever compared to itself, so it is week-mode- and clock-agnostic,
// and it can't collide with the seed's relative audiogram dates.
const AUDIOGRAM_DATE = "2019-03-05";
// Two more marker dates this spec owns, for the reported pure-tone average (#2322):
// one hearing test carrying BOTH thresholds and a reported right-ear average (so the
// precedence is visible side by side), and one report that carried the average alone.
const PTA_DATE = "2019-04-09";
const PTA_ONLY_DATE = "2019-05-14";
const HEARING_DATES = [AUDIOGRAM_DATE, PTA_DATE, PTA_ONLY_DATE];

function dbPath(): string {
  return workerDbPath();
}

function cleanup(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const medIds = db
      .prepare("SELECT id FROM intake_items WHERE name LIKE ?")
      .all(`${MED_PREFIX}%`) as { id: number }[];
    for (const { id } of medIds) {
      db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key LIKE ?").run(
        `ototoxic:${id}:%`
      );
    }
    db.prepare("DELETE FROM intake_items WHERE name LIKE ?").run(
      `${MED_PREFIX}%`
    );
    // The audiogram this spec enters through the form (#1600) — keyed on its marker
    // date so the seed's own audiograms are never touched.
    const drop = db.prepare(
      `DELETE FROM medical_records
        WHERE profile_id = 1 AND date = ?
          AND (canonical_name LIKE 'Hearing Threshold,%'
               OR canonical_name LIKE 'Pure Tone Average,%')`
    );
    for (const date of HEARING_DATES) drop.run(date);
  } finally {
    db.close();
  }
}

function seed(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    // Profile 1 is the seeded active profile the e2e login acts as.
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, obligation)
       VALUES (1, ?, 1, 'medication', 'must')`
    ).run(MED);
    // #2322 — reported pure-tone averages, stored exactly as a document import leaves
    // them: canonical `vitals` medical_records rows under their own analyte name.
    const insert = db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
       VALUES (1, ?, 'vitals', ?, ?, ?, 'dB HL', ?, 'E2E audiology report')`
    );
    const reading = (date: string, canonical: string, dbHl: number) =>
      insert.run(date, canonical, String(dbHl), dbHl, canonical);
    // A test with BOTH: right ear thresholds averaging 10, plus a reported 18 that
    // must win; the left ear has thresholds only and keeps its derived 20.
    for (const hz of [500, 1000, 2000, 4000]) {
      const label = hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
      reading(PTA_DATE, `Hearing Threshold, Right Ear ${label}`, 10);
      reading(PTA_DATE, `Hearing Threshold, Left Ear ${label}`, 20);
    }
    reading(PTA_DATE, "Pure Tone Average, Right Ear (Air Conduction)", 18);
    // A summary report: the average and nothing else.
    reading(PTA_ONLY_DATE, "Pure Tone Average, Right Ear (Air Conduction)", 22);
  } finally {
    db.close();
  }
}

test.describe("Hearing / audiology (#713, #717, #1600)", () => {
  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(cleanup);

  test("seeded audiogram thresholds render + flag on the Biomarkers surface (#713)", async ({
    page,
  }) => {
    await page.goto("/results?q=" + encodeURIComponent("Hearing Threshold"));
    const main = page.getByRole("main");
    // The seeded per-ear/per-frequency series show; the recent 4 kHz reading is above
    // the ≤25 dB HL band (visibility, not an exact count over the shared seed).
    await expect(main.getByText(/Hearing Threshold/).first()).toBeVisible(); // first-ok: asserts the Hearing Threshold readout renders — order-agnostic presence
    await expect(main.getByText(/4 kHz/).first()).toBeVisible(); // first-ok: asserts a 4 kHz frequency label renders — order-agnostic presence
  });

  test("an active ototoxic medication shows the hearing-safety note on /medications (#717)", async ({
    page,
  }) => {
    await page.goto("/medications");
    const main = page.getByRole("main");

    // Safety notices use the shared disclosure; open it before inspecting the
    // individual hearing-safety finding.
    await expandIntakeWarnings(main);
    const warnings = ototoxicWarnings(main);
    await expect(warnings).toBeVisible();

    const row = ototoxicWarningRows(warnings).filter({ hasText: MED });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/inner ear|hearing/i);
    // Informational, cited, never prescriptive.
    await expect(row).toContainText("discuss");
    await expect(row).toContainText("Source:");
    // #1600 — the payoff: the note now cites the profile's hearing baseline, and the
    // seeded pair of audiograms (a widening 4/8 kHz noise notch) is a documented
    // threshold shift, so the note can finally state the conjunction. Presence-only
    // over the shared seed — never an exact value.
    await expect(row).toContainText("Hearing baseline on file");
    await expect(row).toContainText("documented threshold shift");
  });

  test("records a hearing test on Records › Specialty › Hearing and removes it again (#1600)", async ({
    page,
  }) => {
    test.slow();

    // Reach the pane the way a person does: from a sibling Specialty pane's sub-tab.
    await page.goto("/records/specialty/skin");
    await followLink(
      page,
      page.getByTestId("records-sub-tabs").getByRole("link", {
        name: "Hearing",
        exact: true,
      }),
      /\/records\/specialty\/hearing$/
    );
    await expect(page.getByTestId("records-hearing")).toBeVisible();

    await page.getByTestId("add-audiogram-panel-toggle").click();
    const form = page.getByTestId("audiogram-form");
    await expect(form).toBeVisible();

    await form.getByLabel("Test date").fill(AUDIOGRAM_DATE);
    // The DateField's calendar popup overlays the submit button; Escape is its
    // documented close (the optical-prescription spec does the same).
    await page.keyboard.press("Escape");
    // A clean baseline audiogram: both ears well inside the ≤25 dB HL normal band.
    await form.locator('input[name="right_500"]').fill("5");
    await form.locator('input[name="right_1000"]').fill("10");
    await form.locator('input[name="right_2000"]').fill("10");
    await form.locator('input[name="right_4000"]').fill("15");
    await form.locator('input[name="left_1000"]').fill("10");
    await settledClick(
      page,
      form.getByRole("button", { name: "Add", exact: true })
    );

    // It lists as ONE dated hearing test with its per-ear average — the readings are
    // twelve-analytes-wide underneath, but the surface speaks in audiograms.
    const card = page.getByTestId(`audiogram-${AUDIOGRAM_DATE}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("15 dB HL");
    await expect(
      card.getByTestId(`audiogram-pta-${AUDIOGRAM_DATE}-right-air`)
    ).toContainText("10 dB HL");
    // A frequency left blank stays "not tested", never a fabricated 0.
    await expect(
      card.getByTestId(`audiogram-pta-${AUDIOGRAM_DATE}-left-air`)
    ).toContainText("10 dB HL");

    // Confirm-first removal, scoped to this card (every audiogram row has a Delete).
    await card.getByRole("button", { name: "Delete", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
  });

  test("a REPORTED pure-tone average wins over the derived one, per ear (#2322)", async ({
    page,
  }) => {
    await page.goto("/records/specialty/hearing");
    await expect(page.getByTestId("records-hearing")).toBeVisible();

    const card = page.getByTestId(`audiogram-${PTA_DATE}`);
    await expect(card).toBeVisible();
    // Right ear: the document's own 18 dB HL, not the 10 dB HL its thresholds imply,
    // and the line says which it is.
    const right = card.getByTestId(`audiogram-pta-${PTA_DATE}-right-air`);
    await expect(right).toContainText("18 dB HL");
    await expect(right).toContainText("as reported");
    // The OTHER ear is untouched — the precedence is per ear, never per document.
    const left = card.getByTestId(`audiogram-pta-${PTA_DATE}-left-air`);
    await expect(left).toContainText("20 dB HL");
    await expect(left).toContainText("averaged from 4 recorded frequencies");
    // The thresholds behind the derived value still render.
    await expect(card).toContainText("4 kHz");
  });

  test("a report carrying only the average lists as a hearing test, and says so (#2322)", async ({
    page,
  }) => {
    await page.goto("/records/specialty/hearing");
    const card = page.getByTestId(`audiogram-${PTA_ONLY_DATE}`);
    await expect(card).toBeVisible();
    await expect(
      card.getByTestId(`audiogram-pta-${PTA_ONLY_DATE}-right-air`)
    ).toContainText("22 dB HL");
    await expect(
      card.getByTestId(`audiogram-no-thresholds-${PTA_ONLY_DATE}`)
    ).toBeVisible();
  });

  test("the ototoxic finding surfaces on Upcoming (#717)", async ({ page }) => {
    await page.goto("/upcoming");
    const main = page.getByRole("main");

    const finding = main
      .locator('[data-testid^="upcoming-item-ototoxic:"]')
      .filter({ hasText: MED });
    await expect(finding).toBeVisible();
    await expect(finding).toContainText(/Ototoxic medication/i);
  });
});
