import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenSyncInstant } from "./worker-env";

// #2301 — the Import grid stops answering the CONNECTION question about sources allos
// does not drive.
//
// Verified on a prod snapshot before this change: the Fitbit Takeout card rendered
// "Connected", green, for a ten-day-old file import; the calendar-feed card rendered
// "Connected", green, plus a permanent "No syncs yet" (nothing will ever sync in — it
// is outbound); and patient-portals rendered "Intermittent", a flapping-CONNECTION
// word for a tool a person runs by hand. This spec pins all three, plus the live
// consequence the hand-enumerated Imports-feed filter had: a portal run, failures
// included, appearing on NO Review surface at all.
//
// FIXTURE OWNERSHIP: patient-portals and calendar-feed rows on PROFILE 1 are this
// spec's own — nothing in the shared seed writes either — and afterAll removes them.
// The Fitbit Takeout card is only asserted NEGATIVELY (no green "Connected" chip),
// which holds for every attended state, so it never depends on which other spec has
// touched that provider's history.
//
// ONE SHARED-SEED DEPENDENCE, named so it is not a mystery the day it goes red: the
// six portal rows are this spec's own, but their VISIBILITY rests on
// `getImportDocumentsFeed` capping the merged documents + paste/CSV jobs + attended
// runs at 40. If profile 1's shared seed ever grows to 40 import entries newer than
// these (they are 24–140 hours old), the cap will push them off the feed and the
// count assertion below will fail for a reason that has nothing to do with delivery.

const PROFILE_ID = 1;
const PORTALS = "patient-portals";
const FEED = "calendar-feed";
const TAKEOUT = "fitbit-takeout";
const PORTAL_ERR = "portal sign-in timed out";

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

const at = frozenSyncInstant;

// A portal tool that has been run six times, three of which failed, most recently
// successfully — the exact prod shape that read "Intermittent". Plus the outbound
// calendar feed, enabled and (necessarily) eventless.
function seedFixture(): void {
  withDb((db) => {
    const conn = db.prepare(
      `INSERT INTO integration_connections (profile_id, provider, status)
       VALUES (?, ?, 'connected')
       ON CONFLICT (profile_id, provider) DO UPDATE SET status = 'connected'`
    );
    conn.run(PROFILE_ID, PORTALS);
    conn.run(PROFILE_ID, FEED);
    db.prepare(
      `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider = ?`
    ).run(PROFILE_ID, PORTALS);
    const ins = db.prepare(
      `INSERT INTO integration_sync_events
         (profile_id, provider, at, ok, inserted, updated, unchanged, error)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    );
    const runs: { hoursAgo: number; ok: boolean }[] = [
      { hoursAgo: 140, ok: true },
      { hoursAgo: 120, ok: false },
      { hoursAgo: 96, ok: true },
      { hoursAgo: 72, ok: false },
      { hoursAgo: 48, ok: false },
      { hoursAgo: 24, ok: true },
    ];
    for (const r of runs) {
      ins.run(
        PROFILE_ID,
        PORTALS,
        at(r.hoursAgo),
        r.ok ? 1 : 0,
        r.ok ? 4 : null,
        r.ok ? 1 : null,
        r.ok ? null : PORTAL_ERR
      );
    }
  });
}

function clearFixture(): void {
  withDb((db) => {
    db.prepare(
      `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider = ?`
    ).run(PROFILE_ID, PORTALS);
    db.prepare(
      `DELETE FROM integration_connections
        WHERE profile_id = ? AND provider IN (?, ?)`
    ).run(PROFILE_ID, PORTALS, FEED);
  });
}

test.afterAll(() => clearFixture());

test("the Import grid never claims a source allos does not drive is Connected", async ({
  page,
}) => {
  seedFixture();
  await page.goto("/data?section=import");
  const main = page.getByRole("main");

  // ── The archive: a file the user hands us. "Connected" is not a thing it can be,
  //    and green is a health verdict about a link that does not exist.
  const takeout = main.getByTestId(`integration-card-${TAKEOUT}`);
  await expect(takeout).toBeVisible();
  await expect(takeout.getByText("Connected", { exact: true })).toHaveCount(0);
  await expect(takeout.locator(".bg-brand-100")).toHaveCount(0);

  // ── The outbound feed: nothing arrives, so it neither connects nor waits for a
  //    first sync. "No syncs yet" was a promise it could never keep.
  const feed = main.getByTestId(`integration-card-${FEED}`);
  await expect(feed).toBeVisible();
  await expect(feed.getByText("Feed enabled")).toBeVisible();
  await expect(feed.getByText("Connected", { exact: true })).toHaveCount(0);
  await expect(feed.getByText("No syncs yet")).toHaveCount(0);
  await expect(feed.locator(".bg-brand-100")).toHaveCount(0);

  // ── The attended tool: read by its LAST ATTEMPT, never as a flapping connection.
  const portals = main.getByTestId(`integration-card-${PORTALS}`);
  await expect(portals).toBeVisible();
  await expect(portals.getByText("Intermittent")).toHaveCount(0);
  await expect(portals.getByText("Last upload", { exact: true })).toBeVisible();
  await expect(portals.locator(".bg-brand-100")).toHaveCount(0);
});

test("an attended provider's runs — failures included — reach Review's Imports feed", async ({
  page,
}) => {
  seedFixture();
  await page.goto("/data?section=review");
  const main = page.getByRole("main");

  // Before #2301 this feed said `provider = 'fitbit-takeout'` — one of the attended
  // family's two members — so these runs appeared NOWHERE: not here, not under
  // Connected sources (the kind is excluded), and not under Needs attention (an
  // attended provider is exempt from the silence rule, so it can never be `failing`).
  const feed = main.getByTestId("import-feed");
  await expect(feed).toBeVisible();
  const rows = feed
    .getByRole("listitem")
    .filter({ hasText: "Patient portals" });
  await expect(rows).toHaveCount(6);
  // Each failed run carries its own reason — the thing that was invisible.
  await expect(rows.filter({ hasText: PORTAL_ERR })).toHaveCount(3);

  // …and it is still not an escalation: nothing about it reaches Needs attention.
  await expect(
    main.getByTestId("sources-escalated").filter({ hasText: "Patient portals" })
  ).toHaveCount(0);
  await expect(
    main.getByTestId("connected-sources").filter({ hasText: "Patient portals" })
  ).toHaveCount(0);
});

test("an attended provider's page states the escalation policy's attended inverse", async ({
  page,
}) => {
  // Every scheduled provider page states its escalation rule under its sync history.
  // The archive page has no history table, so until now the attended sentence had no
  // caller at all — implemented, unit-tested and unreachable. This is that caller.
  await page.goto(`/integrations/${TAKEOUT}`);
  const policy = page.getByTestId("takeout-escalation-policy");
  await expect(policy).toBeVisible();
  // The ARCHIVE dialect ("import", not "upload" or "sync"), and the positive claim:
  // allos never marks this source late, because only the reader can start it.
  await expect(policy).toContainText("as fresh as your last import");
  await expect(policy).toContainText("never marks it late");
  // The hand-rolled status line above it is untouched this round (scoped out of
  // #2301), so the card still states both facts and neither replaced the other.
  await expect(page.getByTestId("takeout-status")).toBeVisible();
});
