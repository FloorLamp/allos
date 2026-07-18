import { test, expect, type Page } from "@playwright/test";

// Change a Settings select and await the Server-Action POST it fires (Next posts to
// the current route). Deterministic where the shared "Saved" indicator can't be:
// it can't tell a second save from a first whose 3s check is still lingering.
async function selectAndSave(
  page: Page,
  testId: string,
  value: string
): Promise<void> {
  const saved = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("/settings")
  );
  await page.getByTestId(testId).selectOption(value);
  await saved;
}

// Date/time display login preferences (#964). A login picks its clock (12h/24h) and
// date shape (mdy/dmy/iso) under Settings → Preferences, and every date/time surface
// follows. This drives the real Settings selects and confirms:
//   - a record date (the seeded "Essential hypertension" onset, 2019-03-01) renders
//     in the chosen date shape on /conditions, and
//   - a journal timestamp (the seeded "Strava morning ride", 07:15–08:17, logged 3
//     days ago) renders in the chosen clock on the Training → Log feed.
// Both read seeded rows by VALUE (never an exact count), and the finally block
// restores the defaults so the shared admin login doesn't leak the preference into
// other specs.

test("flipping the date/time prefs re-renders a record date and a journal timestamp", async ({
  page,
}) => {
  try {
    // Baseline: the status-quo defaults (mdy long-date; 24h clock).
    await page.goto("/conditions");
    await expect(page.getByText("Mar 1, 2019").first()).toBeVisible();

    await page.goto("/training");
    await expect(page.getByText("Strava morning ride").first()).toBeVisible();
    // 24h default — the ride's start renders as "07:15", never a 12h "7:15 AM".
    await expect(page.getByText(/07:15/).first()).toBeVisible();

    // Flip both prefs on Settings → Preferences (autosave on change). Await each
    // Server-Action POST before the next change so the two back-to-back saves can't
    // race — the shared "Saved" indicator lingers 3s, so it can't distinguish them.
    await page.goto("/settings");
    await selectAndSave(page, "date-format-select", "iso");
    await selectAndSave(page, "time-format-select", "12h");

    // They persist across a full reload.
    await page.reload();
    await expect(page.getByTestId("date-format-select")).toHaveValue("iso");
    await expect(page.getByTestId("time-format-select")).toHaveValue("12h");

    // The record date now renders ISO on /conditions.
    await page.goto("/conditions");
    await expect(page.getByText("2019-03-01").first()).toBeVisible();

    // The journal timestamp now renders a 12-hour clock on Training → Log.
    await page.goto("/training");
    await expect(page.getByText("Strava morning ride").first()).toBeVisible();
    await expect(page.getByText(/7:15\s*AM/).first()).toBeVisible();
  } finally {
    // Restore the defaults so the shared admin login preference doesn't bleed into
    // other specs.
    await page.goto("/settings");
    await selectAndSave(page, "date-format-select", "mdy");
    await selectAndSave(page, "time-format-select", "24h");
    await expect(page.getByTestId("date-format-select")).toHaveValue("mdy");
    await expect(page.getByTestId("time-format-select")).toHaveValue("24h");
  }
});
