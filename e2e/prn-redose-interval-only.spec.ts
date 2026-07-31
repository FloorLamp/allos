import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";
import { medicationsToday, prnTodayItem } from "./med-card-helpers";
import { workerDbPath } from "./worker-env";

// #1458 — the sick-kid path, end to end. A caregiver adds a PRN medication with a
// minimum interval and leaves the OPTIONAL "Maximum doses per day" blank, logs a dose,
// and must still get the one number they want at 2am: when the next dose is OK.
// Before the fix both med-data gathers ANDed interval AND max, so this exact config
// rendered `prn-redose-line` nowhere.
//
// #868 fixture ownership: the spec MINTS its own uniquely-named med each run and
// DB-cleans every med it minted in afterAll, so a --repeat-each run neither collides on
// the row nor leaves a PRN med behind to skew the neighbouring medication specs (which
// pin profile 1's PRN list). No shared-seed row is read or counted here.
const ADDED_MED_PREFIX = "Fever Syrup e2e interval-only";

function deleteAddedMeds(): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON"); // cascade the med's dose/log children
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

test("PRN med with ONLY a minimum interval still shows redose guidance (#1458)", async ({
  page,
}) => {
  await page.goto("/medications");

  const name = `${ADDED_MED_PREFIX} ${Date.now()}-${Math.floor(
    Math.random() * 1e6
  )}`;

  // --- Add the med: as-needed, 6h minimum interval, daily maximum LEFT BLANK ---
  await page.getByTestId("medication-add-toggle").click();
  await page.getByTestId("medication-add-full").click();
  const addCard = page.getByTestId("medication-add-panel");
  await expect(addCard).toBeVisible();
  await addCard.getByLabel("Name").fill(name);
  // "As needed" IS the `may` obligation since #1505 — the standalone as_needed
  // checkbox was collapsed into the single obligation select, so PRN is now
  // expressed by choosing `may` rather than by ticking a separate box.
  await addCard.getByTestId("med-obligation").selectOption("may");

  const block = addCard.getByTestId("redose-block");
  await expect(block).toBeVisible();
  await addCard.getByTestId("redose-interval").fill("6");
  // The field a parent is least likely to know offhand stays empty — that's the bug.
  await expect(addCard.getByTestId("redose-max")).toHaveValue("");

  await settledClick(
    page,
    addCard.getByRole("button", { name: "Add", exact: true })
  );

  // --- Log a dose from the Today panel's one-tap row ---
  const prnRow = prnTodayItem(medicationsToday(page), name);
  await expect(prnRow).toBeVisible();
  // Nothing logged yet ⇒ the window is unarmed ⇒ no guidance to give.
  await expect(prnRow.getByTestId("prn-redose-line")).toHaveCount(0);

  await settledClick(page, prnRow.getByTestId("prn-log-now"));

  // --- The guidance the issue says vanished ---
  const line = prnTodayItem(medicationsToday(page), name).getByTestId(
    "prn-redose-line"
  );
  await expect(line).toBeVisible();
  await expect(line).toContainText("Next dose in ~");
  // The count fragment degrades to a bare "N today" — no invented ceiling, and the
  // window is freshly closed so it must never read as a reached maximum.
  await expect(line).toContainText("1 today");
  await expect(line).not.toContainText(" of ");
  await expect(line).not.toContainText("Max reached");
});
