import { test, expect } from "./fixtures";
import { closeEditor, openFact, setObligation } from "./intake-form-helpers";
import Database from "better-sqlite3";
import {
  medicationsToday,
  prnTodayItem,
  medicationRow,
} from "./med-card-helpers";
import { ADMIN_PASSWORD, ADMIN_USERNAME, workerDbPath } from "./worker-env";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { switchToProfile } from "./family-helpers";
import { loginAs } from "./nav";

// Shared redose counts may change; the add flow owns a separate profile.
const REDOSE_MED = "PRN Redose Med (e2e)";

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
  browser,
}) => {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  const profileName = "Redose confirmation (e2e)";
  const profileId = createFixtureProfile(db, profileName);
  const page = await loginAs(browser, {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  });
  try {
    // A separate session keeps this switch from changing the shared admin session.
    await switchToProfile(page, profileName);
    await page.goto("/medications");
    await page.getByTestId("medication-add-toggle").click();
    const addCard = page.getByTestId("medication-add-panel");
    await expect(addCard).toBeVisible();

    // Exact curated identity; fixture uniqueness belongs to the profile.
    const name = "Ibuprofen";
    await addCard.getByLabel("Name").fill(name);
    await setObligation(page, "may", addCard);
    const timing = await openFact(page, "timing", addCard);
    const block = timing.getByTestId("redose-block");
    await expect(block).toBeVisible();
    await block.getByTestId("redose-prefill").click();
    await expect(block.getByTestId("redose-interval")).toHaveValue("6");
    await expect(block.getByTestId("redose-max")).toHaveValue("4");

    // Confirmation must persist even after its editor closes.
    await block.getByTestId("redose-optin").check();
    await closeEditor(page, addCard);
    await addCard.getByRole("button", { name: "Add", exact: true }).click();
    await expect(medicationRow(page, name)).toBeVisible();
  } finally {
    await page.context().close();
    db.prepare("DELETE FROM intake_items WHERE profile_id = ?").run(profileId);
    db.prepare("DELETE FROM profile_settings WHERE profile_id = ?").run(
      profileId
    );
    destroyFixtureProfile(db, profileId);
    db.close();
  }
});
