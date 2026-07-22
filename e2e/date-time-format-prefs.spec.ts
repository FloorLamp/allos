import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

// Clears any body-hygiene dismissal so the seeded 92 kg weight-jump finding is
// guaranteed visible before the finding-text assertion, regardless of retries or
// prior runs against the shared seeded DB (the resetPreventiveFixture pattern from
// #206 — same blast radius as rule-findings.spec.ts's reset). Short-lived
// connection, busy timeout so it never contends with the running server (WAL).
function resetBodyHygieneDismissals(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE signal_key LIKE 'body-hygiene:%'"
    ).run();
  } finally {
    db.close();
  }
}

// Change a Settings select and wait for the autosave to LAND. The card's SaveStatus
// shows a "Saved" check only after the Server Action's write has committed (savedAt
// is set inside the resolved transition), so gating on it before the next step can't
// race an uncommitted write. The caller reloads (a fresh page clears the 3s "Saved"
// linger) between changes so this check always refers to the change just made.
async function selectAndSave(
  page: Page,
  testId: string,
  value: string
): Promise<void> {
  await page.getByTestId(testId).selectOption(value);
  await expect(page.getByLabel("Saved")).toBeVisible();
}

// Date/time display login preferences (#964). A login picks its clock (12h/24h) and
// date shape (mdy/dmy/iso) under Settings → Preferences, and every date/time surface
// follows. This drives the real Settings selects and confirms:
//   - a record date (the seeded "Essential hypertension" onset, 2019-03-01) renders
//     in the chosen date shape on /conditions, and
//   - a journal timestamp (the seeded "Strava morning ride", 07:15–08:17, logged 3
//     days ago) renders in the chosen clock on the Training → Log feed,
//   - a timeline day header renders in the chosen date shape (#1020), and
//   - the seeded 92 kg weight-jump finding's TEXT re-renders its embedded dates in
//     the chosen shape (#1020 — same finding, same dedupeKey, reshaped copy).
// All read seeded rows by VALUE (never an exact count), and the finally block
// restores the defaults so the shared admin login doesn't leak the preference into
// other specs.

test("flipping the date/time prefs re-renders a record date and a journal timestamp", async ({
  page,
}) => {
  try {
    // Baseline: the status-quo defaults (mdy long-date; 24h clock).
    await page.goto("/records/problems");
    await expect(page.getByText("Mar 1, 2019").first()).toBeVisible(); // first-ok: asserts a date renders in the mdy long-date format — order-agnostic presence

    await page.goto("/training");
    await expect(page.getByText("Strava morning ride").first()).toBeVisible(); // first-ok: the seeded Strava ride activity — order-agnostic presence
    // 24h default — the ride's start renders as "07:15", never a 12h "7:15 AM".
    await expect(page.getByText(/07:15/).first()).toBeVisible(); // first-ok: asserts a time renders in 24h format — order-agnostic presence

    // Timeline day headers default to the mdy long shape ("Monday, July 6") —
    // never an ISO date (#1020).
    await page.goto("/timeline");
    await expect(
      page.getByText(/^[A-Za-z]+day, [A-Z][a-z]+ \d{1,2}/).first() // first-ok: asserts a timeline date renders in long-date format — order-agnostic presence
    ).toBeVisible();

    // The seeded weight-jump finding embeds its dates in the default shape too
    // ("On Monday, July 6 you logged …", #1020).
    resetBodyHygieneDismissals();
    await page.goto("/trends?tab=body");
    await expect(
      page
        .getByRole("main")
        .getByTestId("body-hygiene-findings")
        .getByText(/On [A-Za-z]+day, [A-Z][a-z]+ \d{1,2} you logged/)
        .first() // first-ok: asserts a finding renders its date in long-date format — order-agnostic presence
    ).toBeVisible();

    // Flip both prefs on Settings → Preferences (autosave on change). Reload between
    // the two changes: like the Units card, each field's save posts BOTH values from
    // its onChange closure, and React defers the first field's re-render inside the
    // save transition — so a second change fired before that render commits would
    // post a stale first value. A human's two clicks settle between renders; the
    // reload gives the second change a committed starting state deterministically.
    await page.goto("/settings");
    await selectAndSave(page, "date-format-select", "iso");
    await page.reload();
    await expect(page.getByTestId("date-format-select")).toHaveValue("iso");
    await selectAndSave(page, "time-format-select", "12h");

    // They persist across a full reload.
    await page.reload();
    await expect(page.getByTestId("date-format-select")).toHaveValue("iso");
    await expect(page.getByTestId("time-format-select")).toHaveValue("12h");

    // The record date now renders ISO on /conditions.
    await page.goto("/records/problems");
    await expect(page.getByText("2019-03-01").first()).toBeVisible(); // first-ok: asserts a date renders in ISO format — order-agnostic presence

    // The journal timestamp now renders a 12-hour clock on Training → Log.
    await page.goto("/training");
    await expect(page.getByText("Strava morning ride").first()).toBeVisible(); // first-ok: the seeded Strava ride activity — order-agnostic presence
    await expect(page.getByText(/7:15\s*AM/).first()).toBeVisible(); // first-ok: asserts a time renders in 12h format — order-agnostic presence

    // Timeline day headers follow the pref ("Monday, 2026-07-06" — iso keeps the
    // weekday prefix, #1020).
    await page.goto("/timeline");
    await expect(
      page.getByText(/^[A-Za-z]+day, \d{4}-\d{2}-\d{2}$/).first() // first-ok: asserts a timeline date renders in ISO format — order-agnostic presence
    ).toBeVisible();

    // The weight-jump finding's embedded dates follow the pref too — same
    // finding, same dedupeKey, reshaped text (#1020).
    resetBodyHygieneDismissals();
    await page.goto("/trends?tab=body");
    await expect(
      page
        .getByRole("main")
        .getByTestId("body-hygiene-findings")
        .getByText(/On [A-Za-z]+day, \d{4}-\d{2}-\d{2} you logged/)
        .first() // first-ok: asserts a finding renders its date in ISO format — order-agnostic presence
    ).toBeVisible();
  } finally {
    // Restore the defaults so the shared admin login preference doesn't bleed into
    // other specs.
    await page.goto("/settings");
    await selectAndSave(page, "date-format-select", "mdy");
    await page.reload();
    await selectAndSave(page, "time-format-select", "24h");
    await page.reload();
    await expect(page.getByTestId("date-format-select")).toHaveValue("mdy");
    await expect(page.getByTestId("time-format-select")).toHaveValue("24h");
  }
});
