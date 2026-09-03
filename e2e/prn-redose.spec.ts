import { test, expect } from "./fixtures";
import { closeEditor, openFact, setObligation } from "./intake-form-helpers";
import Database from "better-sqlite3";
import {
  medicationsToday,
  prnTodayItem,
  medicationRow,
} from "./med-card-helpers";
import { workerDbPath } from "./worker-env";

// #798 PRN redose notice + confirm flow. The seed (e2e/seed-events.ts) ships
// "PRN Redose Med (e2e)" — a PRN med with a CONFIRMED redose notice (6h interval,
// max 4/day) and ONE administration ~7h ago, so its redose window is OPEN and both
// the Medications card and the dashboard presentation render the status line. The add-form
// test drives the confirm flow: pre-fill the label defaults, opt in, save.
//
// #868 fixture ownership: the "N of 4 in 24h" count is a SHARED-seed tally that other
// specs add to, so these specs assert the count PATTERN (`/\d of 4 in 24h/`) and the
// max, never a pinned "1 of 4". The day-boundary drift this note used to describe —
// the seeded "~7h ago" administration rolling onto yesterday's `date` in the early
// morning and dropping the count to 0 — is gone since #4686: the ceiling counts the
// trailing 24 HOURS, so a 7-hour-old dose is inside it at every hour of the day.
// The add-form test creates its own uniquely-named med each run and DB-cleans it in
// afterAll, so a --repeat-each run neither collides on the row nor leaves an
// ibuprofen med behind to skew the neighbor interaction specs.
const REDOSE_MED = "PRN Redose Med (e2e)";

// Name prefix for the meds this spec creates, so afterAll can remove them all.
const ADDED_MED_PREFIX = "Ibuprofen e2e redose";

function deleteAddedMeds(): void {
  const dbPath = workerDbPath();
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
  const prnRow = prnTodayItem(medicationsToday(page), REDOSE_MED);
  await expect(prnRow).toBeVisible();
  // The window is open (last dose ~7h ago > 6h interval), 1 of 4 in the last 24h.
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
  await expect(line).toContainText(/\d of 4 in 24h/);
});

test("med form: confirm flow pre-fills OTC label defaults and opts in (#798)", async ({
  page,
}) => {
  await page.goto("/medications");

  await page.getByTestId("medication-add-toggle").click();
  const addCard = page.getByTestId("medication-add-panel");
  await expect(addCard).toBeVisible();

  // Name an ingredient the curated dataset knows so the pre-fill affordance appears.
  // Unique per run (#868) so a --repeat-each run doesn't collide on the row below;
  // afterAll DB-cleans every "Ibuprofen e2e redose*" this spec minted.
  const nameStamp = Date.now(); // clock-ok: unique medication-name suffix, never a stored timestamp
  const name = `${ADDED_MED_PREFIX} ${nameStamp}-${Math.floor(Math.random() * 1e6)}`;
  await addCard.getByLabel("Name").fill(name);

  // Marking it PRN reveals the redose-notice block. "As needed" IS the `may`
  // obligation since #1505 — the standalone as_needed checkbox was collapsed into the
  // single obligation select, so PRN is now expressed by choosing `may`.
  await setObligation(page, "may", addCard);
  const timing = await openFact(page, "timing", addCard);
  const block = timing.getByTestId("redose-block");
  await expect(block).toBeVisible();

  // "Use label defaults" pre-fills the CONFIRMED numbers (ibuprofen: 6h / max 4).
  await block.getByTestId("redose-prefill").click();
  await expect(block.getByTestId("redose-interval")).toHaveValue("6");
  await expect(block.getByTestId("redose-max")).toHaveValue("4");

  // The user explicitly opts in (the liability confirm), CLOSES the editor, and saves.
  // Closing it is the point: the opt-in must reach the action from a fact nobody is
  // looking at (#2014).
  await block.getByTestId("redose-optin").check();
  await closeEditor(page, addCard);
  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  // The new PRN med appears as a current medication row (#817).
  await expect(medicationRow(page, name)).toBeVisible();
});
