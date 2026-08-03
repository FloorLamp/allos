import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
import { workerDbPath } from "./worker-env";

// #1596 (landing #28's original "add set" ask): a workout logged entirely offline —
// the form never managed to create its server row — is captured into the offline
// queue when the editor closes, then replayed through the SAME saveActivityCore the
// live auto-save posts to, landing EXACTLY ONCE even though several flush triggers
// (the online event, the on-load flush, Background Sync) can race.
//
// Uses Playwright's context.setOffline for the dead-reception gym moment. The
// distinctive session title makes the row trivially findable + countable, and the
// activities/exercise_sets DB check is what proves both the replay (a real row with
// its sets) and the idempotency ledger (exactly one row after reload re-flushes).

interface SessionRow {
  id: number;
  sets: number;
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
}

function sessionRows(marker: string): SessionRow[] {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return db
      .prepare(
        `SELECT a.id, a.start_time, a.end_time, a.duration_min,
                (SELECT COUNT(*) FROM exercise_sets s WHERE s.activity_id = a.id) AS sets
           FROM activities a WHERE a.title = ?`
      )
      .all(marker) as SessionRow[];
  } finally {
    db.close();
  }
}

// Pick an activity in the editor's exercise combobox (the live-workout spec's
// shape-tolerant matcher).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

test("a workout logged offline queues at close, then syncs exactly once (#1596)", async ({
  page,
  context,
}) => {
  const marker = `Offline session ${Date.now()}`; // clock-ok: unique-name suffix for this spec's own session title, never a stored timestamp

  await page.goto("/training");
  await hydratedClick(
    page,
    page.getByRole("main").getByRole("button", { name: "New activity" })
  );
  await expect(page.getByTestId("activity-form")).toBeVisible();

  // Reception dies AFTER the editor is open — the mid-gym moment. Every
  // auto-save from here on fails; the close-path flush must queue instead.
  await context.setOffline(true);

  await pickActivity(page, "Barbell Bench Press");
  // Tapping "Use" seeds set 1 from the coached suggestion (#335/#1971), making
  // the form savable — but offline, nothing can persist.
  const weight = page.getByTestId("set1-weight");
  await page
    .getByTestId("next-set-card")
    .getByRole("button", { name: "Use" })
    .click();
  await expect(weight).toHaveValue(/^\d/);
  await page.getByLabel("Activity name").fill(marker);

  // Close the editor: the before-close flush dies on the dead connection and the
  // never-created session is captured into the offline queue.
  await page.keyboard.press("Escape");
  await expect(
    page.getByText("Workout saved offline — will sync when you reconnect.")
  ).toBeVisible();
  const badge = page.getByTestId("offline-queue-badge");
  await expect(badge).toHaveText(/1 queued offline/);

  // Nothing reached the server yet.
  expect(sessionRows(marker)).toHaveLength(0);

  // Reconnect → the "online" event triggers a flush that replays the queue.
  await context.setOffline(false);
  await expect(page.getByText(/Synced 1 offline entr/)).toBeVisible();
  await expect(badge).toHaveCount(0);

  // The session is durably persisted with its set — and EXACTLY ONCE. A further
  // reload re-runs the on-load flush against the drained queue; the replayed_keys
  // ledger keeps it a no-op.
  await page.reload();
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);
  const rows = sessionRows(marker);
  expect(rows).toHaveLength(1);
  expect(rows[0].sets).toBeGreaterThanOrEqual(1);

  // The replayed session is a COMPLETED session — never the live-draft
  // signature (started, unended, duration-less). Left live-shaped, workout
  // presence would resurrect it as an ACTIVE workout and the app-wide dock +
  // "Still working out?" nag would haunt every page (and, on a shared CI
  // worker, every later spec) for up to 90 minutes. The replay stamps the
  // capture (close) instant as the end, so the row must carry one.
  expect(rows[0].start_time).not.toBeNull();
  expect(rows[0].end_time).not.toBeNull();
  await expect(page.getByTestId("workout-dock")).toHaveCount(0);

  // No draft-restore offer either: the queue owns the entry, so reopening the
  // editor must not offer the same session back for a duplicate save (#1699 vs
  // #1596 boundary).
  await hydratedClick(
    page,
    page.getByRole("main").getByRole("button", { name: "New activity" })
  );
  await expect(page.getByTestId("activity-form")).toBeVisible();
  await expect(page.getByTestId("draft-restore-banner")).toHaveCount(0);
  await page.keyboard.press("Escape");
});
