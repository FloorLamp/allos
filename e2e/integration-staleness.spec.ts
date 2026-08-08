import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenSyncInstant } from "./worker-env";

// Issue #1685b: a CONNECTED integration that has silently stopped syncing renders with
// its own copy — "sync has stopped" / "No data since <date>" — rather than the reauth
// wording, on both surfaces that show the shared attention model.
//
// The state under test cannot be produced by any recorded failure, which is the whole
// point: nothing failed (so the Strava-style "sync failed" row can't appear) and nothing
// arrived. The only evidence is the age of the last SUCCESSFUL sync, so this spec seeds
// exactly that: a connected provider plus one ok=1 event, dated well past the provider's
// registry threshold, measured against the run's frozen clock.
//
// Weather is chosen deliberately — the shared seed leaves it untouched (Strava is
// connected-and-failing, Oura disconnected, Withings needs_reauth, Health Connect
// unconnected), so this fixture is this spec's own and adds exactly one review item.
// It is removed in afterAll so neighbours see the world they seeded.

const PROFILE_ID = 1;
const PROVIDER = "weather";
// Weather's silence tolerance is 12 hours (#2263); 11 days is unambiguously past it
// and reads as a clear "no data since" date in the copy. Seeded as an exact multiple
// of 24 hours before the frozen clock so the duration the copy states is exactly
// eleven days — the copy FLOORS, so a fixture that drifted a few hours short would
// read "10 days".

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

const DAYS_STALE = 11;

// The seeded last-successful sync, as the instant the ledger stores and as the day the
// copy names.
function staleAt(): string {
  return frozenSyncInstant(DAYS_STALE * 24);
}
function staleSince(): string {
  return staleAt().slice(0, 10);
}

function seedStoppedSync(): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO integration_connections (profile_id, provider, status)
       VALUES (?, ?, 'connected')
       ON CONFLICT (profile_id, provider) DO UPDATE SET status = 'connected'`
    ).run(PROFILE_ID, PROVIDER);
    db.prepare(
      `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider = ?`
    ).run(PROFILE_ID, PROVIDER);
    // One healthy sync, long ago — and nothing since. No failure row: that is the case
    // the event-driven detectors cannot see.
    db.prepare(
      `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted, updated, unchanged)
       VALUES (?, ?, ?, 1, 0, 0, 24)`
    ).run(PROFILE_ID, PROVIDER, staleAt());
  });
}

function clearStoppedSync(): void {
  withDb((db) => {
    db.prepare(
      `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider = ?`
    ).run(PROFILE_ID, PROVIDER);
    db.prepare(
      `DELETE FROM integration_connections WHERE profile_id = ? AND provider = ?`
    ).run(PROFILE_ID, PROVIDER);
  });
}

// Re-seeded before each test so the spec is idempotent under --repeat-each, and cleared
// afterwards so the shared worker DB goes back to what its seed built.
test.beforeEach(() => seedStoppedSync());
test.afterAll(() => clearStoppedSync());

test("Data → Review shows a stopped sync with its own copy, not the reauth wording", async ({
  page,
}) => {
  await page.goto("/data?section=review");
  const review = page.getByTestId("review-inbox");
  const attention = review.getByTestId("needs-attention-sources");
  await expect(attention.getByText("Needs attention")).toBeVisible();

  // Since #1880 a quiet stop escalates the STANDING (the staleness breach composes
  // into `failing`), so the provider renders its full source card under Needs
  // attention — once — rather than a summary row beside a duplicate card below.
  const card = attention.getByTestId(`source-${PROVIDER}`);
  await expect(card).toBeVisible();
  // Says what we observed …
  await expect(card).toContainText(`No data since ${staleSince()}`);
  await expect(card).toContainText(`${DAYS_STALE} days`);
  await expect(card).toContainText("Check the connection");
  // … and never claims a cause it has no evidence for.
  await expect(card).not.toContainText("Reconnect to resume syncing");
  // The card renders ONCE: the provider is not listed again under Connected sources.
  await expect(
    review.getByTestId("connected-sources").getByTestId(`source-${PROVIDER}`)
  ).toHaveCount(0);
});

test("the stopped sync is counted by the Review badge", async ({ page }) => {
  await page.goto("/data?section=review");
  const badge = page.getByTestId("review-badge").first(); // first-ok: the review badge also renders in the mobile drawer; either mirror carries the same count
  await expect(badge).toBeVisible();
  const withStale = Number((await badge.textContent())?.trim());

  // Removing the fixture drops the count by exactly one — the badge counts this signal
  // like any other review item, rather than showing it in the list only.
  clearStoppedSync();
  await page.goto("/data?section=review");
  await expect(badge).toHaveText(String(withStale - 1));
  await expect(
    page.getByTestId("review-inbox").getByTestId(`source-${PROVIDER}`)
  ).toHaveCount(0);
});

test("the dashboard attention card carries the stopped sync with its own action", async ({
  page,
}) => {
  await page.goto("/upcoming");
  const main = page.getByRole("main");
  await expect(main.getByTestId("upcoming-total")).toBeVisible();
  // The Upcoming page renders the full shared model; the structural signals file under
  // "For review" alongside the import-review count. The row's testid is the item's own
  // key, which is `integration:<id>` for BOTH the failing and the stale variant — one
  // row per provider, whichever signal raised it.
  const item = main.getByTestId(`upcoming-item-integration:${PROVIDER}`);
  await expect(item).toBeVisible();
  await expect(item).toContainText("sync has stopped");
  await expect(item).toContainText("No data since");
  // Its status reads as an observation, where the failing variant reads "Reconnect".
  await expect(item).toContainText("No recent data");
  // The ask is to CHECK, not to reconnect — the connection may be perfectly authorized.
  await expect(item).toContainText("Check the connection");
  await expect(item).not.toContainText("Reconnect");
});
