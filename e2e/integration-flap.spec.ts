import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenSyncInstant } from "./worker-env";

// #1880/#2263: flapping is not failing, and what separates them is SILENCE. A
// provider alternating Failed/Refreshed with a recent success is `intermittent` — a
// calm amber fact on Review's Connected sources, the Import grid, and its own source
// page — and NEVER enters Needs attention, the Data badge, or Upcoming. Once no run
// has succeeded inside the provider's declared tolerance the ONE standing escalates,
// and every surface flips at once, with the failing source rendered exactly once on
// Review (the duplicate-text tripwire).
//
// Weather on PROFILE 1 is this spec's own fixture (the shared seed leaves it
// untouched there — the healthy weather fixture lives on its own findings profile),
// mirroring integration-staleness.spec.ts, which owns the quiet-stop variant of the
// same provider and likewise restores it in afterAll.

const PROFILE_ID = 1;
const PROVIDER = "weather";
const ERR = "weather fetch failed (503)";
// Weather's declared silence tolerance: 12 polls × its hourly cadence.
const TOLERANCE_HOURS = 12;
// Weather's blurb opening — the pitch a COMPACT card must no longer carry.
const BLURB_SNIPPET = "Bring in the actual UV index";

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

// The run's frozen clock minus N hours, in the sync ledger's own convention
// ('YYYY-MM-DDTHH:MM:SSZ', #2205 / migration 163).
const at = frozenSyncInstant;

// One fixed forecast window across every seeded run, so the history's window norm
// is quiet and the rows under test are the outcomes.
const WINDOW = ["2026-06-25", "2026-07-09"] as const;

function seedEvents(events: { hoursAgo: number; ok: boolean }[]): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO integration_connections (profile_id, provider, status)
       VALUES (?, ?, 'connected')
       ON CONFLICT (profile_id, provider) DO UPDATE SET status = 'connected'`
    ).run(PROFILE_ID, PROVIDER);
    db.prepare(
      `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider = ?`
    ).run(PROFILE_ID, PROVIDER);
    const ins = db.prepare(
      `INSERT INTO integration_sync_events
         (profile_id, provider, at, ok, window_start, window_end,
          inserted, updated, unchanged, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    );
    for (const e of events) {
      ins.run(
        PROFILE_ID,
        PROVIDER,
        at(e.hoursAgo),
        e.ok ? 1 : 0,
        WINDOW[0],
        WINDOW[1],
        e.ok ? 16 : null,
        e.ok ? 320 : null,
        e.ok ? null : ERR
      );
    }
  });
}

// Alternating Failed/Refreshed — 3 of the last 6 runs failed, last success 2h ago.
function seedFlapping(): void {
  seedEvents([
    { hoursAgo: 6, ok: true },
    { hoursAgo: 5, ok: false },
    { hoursAgo: 4, ok: true },
    { hoursAgo: 3, ok: false },
    { hoursAgo: 2, ok: true },
    { hoursAgo: 1, ok: false },
  ]);
}

// No run has succeeded inside the tolerance — the escalation boundary. The failure
// PATTERN is the same shape the calm fixture above has; the only thing that changed is
// how long ago the last success was, which is the whole point of #2263.
function seedEscalated(): void {
  seedEvents([
    { hoursAgo: TOLERANCE_HOURS + 2, ok: true },
    { hoursAgo: TOLERANCE_HOURS + 1, ok: true },
    { hoursAgo: 3, ok: false },
    { hoursAgo: 2, ok: false },
    { hoursAgo: 1, ok: false },
  ]);
}

function clearFixture(): void {
  withDb((db) => {
    db.prepare(
      `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider = ?`
    ).run(PROFILE_ID, PROVIDER);
    db.prepare(
      `DELETE FROM integration_connections WHERE profile_id = ? AND provider = ?`
    ).run(PROFILE_ID, PROVIDER);
  });
}

test.afterAll(() => clearFixture());

test("a flapping source is amber Intermittent on all three surfaces and escalates nowhere", async ({
  page,
}) => {
  seedFlapping();

  // Review: a calm one-liner under Connected sources, stating the honest pattern.
  await page.goto("/data?section=review");
  const review = page.getByTestId("review-inbox");
  const row = review
    .getByTestId("connected-sources")
    .getByTestId(`source-${PROVIDER}`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId(`sync-status-${PROVIDER}`)).toContainText(
    "Intermittent"
  );
  const fact = row.getByTestId(`intermittent-fact-${PROVIDER}`);
  await expect(fact).toContainText("3 of the last 6 runs failed");
  await expect(fact).toContainText("last success");
  // The SIGNAL beside the failure tally (#2263 item 4): the successes are two hours
  // apart, which is what "3 of 6 failed" never said.
  await expect(fact).toContainText("succeeding about every 2 hours");
  await expect(fact).toContainText("nothing missing");
  // NO Needs-attention entry for it — flapping never escalates.
  await expect(
    review
      .getByTestId("needs-attention-sources")
      .getByTestId(`source-${PROVIDER}`)
  ).toHaveCount(0);
  await expect(review.getByTestId(`import-issue-${PROVIDER}`)).toHaveCount(0);

  // The Data badge does not count it: removing the fixture leaves the count as-is.
  const badge = page.getByTestId("review-badge").first(); // first-ok: the badge renders in the desktop sidebar AND the (hidden) mobile drawer's shared Nav; either mirror carries the same count
  const withFlap = Number((await badge.textContent())?.trim());
  clearFixture();
  await page.goto("/data?section=review");
  await expect(badge).toHaveText(String(withFlap));
  seedFlapping();

  // The Import grid: a compact status card — amber chip, one fact, Manage →, and
  // NO pitch blurb (its owner already bought).
  await page.goto("/data?section=import");
  const card = page.getByTestId(`integration-card-${PROVIDER}`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-card-state", "connected");
  await expect(card.getByText("Intermittent")).toBeVisible();
  await expect(card.getByText("Last success")).toBeVisible();
  await expect(card.getByText("Manage")).toBeVisible();
  await expect(card.getByText(BLURB_SNIPPET)).toHaveCount(0);

  // The source page: the same standing, the pattern headline, and the visible
  // escalation policy.
  await page.goto("/integrations/weather");
  await expect(page.getByTestId(`sync-status-${PROVIDER}`)).toContainText(
    "Intermittent"
  );
  const summary = page.getByTestId("intermittent-summary");
  await expect(summary).toContainText("Working, with interruptions");
  await expect(summary).toContainText("3 of the last 6 runs failed");
  await expect(summary).toContainText("succeeding about every 2 hours");
  // The visible escalation policy states the ONE rule the badge and digest use.
  const policy = page.getByTestId("escalation-policy");
  await expect(policy).toContainText(
    "“Sync failing” appears after 12 hours without a successful refresh"
  );
  await expect(policy).not.toContainText("consecutive");

  // Upcoming carries no item for it — intermittent never increases contact.
  await page.goto("/upcoming");
  const main = page.getByRole("main");
  await expect(main.getByTestId("upcoming-total")).toBeVisible();
  await expect(
    main.getByTestId(`upcoming-item-integration:${PROVIDER}`)
  ).toHaveCount(0);
});

test("silence past the tolerance escalates every surface at once, rendered once on Review", async ({
  page,
}) => {
  seedEscalated();

  // Review: the full card under Needs attention — chip, reason, consequence, and
  // all its actions together.
  await page.goto("/data?section=review");
  const review = page.getByTestId("review-inbox");
  const card = review
    .getByTestId("needs-attention-sources")
    .getByTestId(`source-${PROVIDER}`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId(`sync-status-${PROVIDER}`)).toContainText(
    "Sync failing"
  );
  await expect(card.getByText(ERR)).toBeVisible();
  await expect(
    card.getByTestId(`source-consequence-${PROVIDER}`)
  ).toContainText(
    "UV and daylight readings for your home location have stopped arriving."
  );
  await expect(card.getByRole("button", { name: "Sync now" })).toBeVisible();
  await expect(
    card.getByTestId(`source-history-link-${PROVIDER}`)
  ).toHaveAttribute("href", "/integrations/weather");

  // The duplicate-text tripwire: the reason renders exactly ONCE on the whole
  // Review surface, and the source is absent from Connected sources.
  await expect(review.getByText(ERR)).toHaveCount(1);
  await expect(
    review.getByTestId("connected-sources").getByTestId(`source-${PROVIDER}`)
  ).toHaveCount(0);

  // The grid: attention state — red border treatment, Reconnect →.
  await page.goto("/data?section=import");
  const gridCard = page.getByTestId(`integration-card-${PROVIDER}`);
  await expect(gridCard).toHaveAttribute("data-card-state", "attention");
  await expect(gridCard.getByText("Sync failing")).toBeVisible();
  await expect(gridCard.getByText("Reconnect")).toBeVisible();

  // The source page: same standing, and the history SHOWS the streak as one
  // grouped ×3 row (#1880 item 3) instead of three stripes. The streak is what the
  // history renders; it is no longer what escalates.
  await page.goto("/integrations/weather");
  await expect(page.getByTestId(`sync-status-${PROVIDER}`)).toContainText(
    "Sync failing"
  );
  const failureRun = page.getByTestId("sync-history-failure-run");
  await expect(failureRun).toContainText("Failed ×3");
  await expect(failureRun).toContainText(`${ERR} — all 3 runs`);
  // Matching top-level errors may still carry different per-run diagnostics or raw
  // payloads, so the collapsed streak is a summary, never a dead end.
  const itemizedBefore = await page.getByTestId(/^sync-run-/).count();
  await failureRun.getByTestId("sync-history-show-failures").click();
  const itemizedRuns = page.getByTestId(/^sync-run-/);
  await expect(itemizedRuns).toHaveCount(itemizedBefore + 3);
  await expect(itemizedRuns.getByText(ERR, { exact: true })).toHaveCount(3);

  // Upcoming carries the shared attention item.
  await page.goto("/upcoming");
  await expect(
    page.getByRole("main").getByTestId(`upcoming-item-integration:${PROVIDER}`)
  ).toBeVisible();
});

test("the grid pitches what you don't own and reports on what you do, attention first", async ({
  page,
}) => {
  seedFlapping();
  await page.goto("/data?section=import");
  const main = page.getByRole("main");

  // Connected group: the seeded Strava/Withings escalations lead with attention
  // cards; the flapping Weather rides behind them as a connected card.
  const connectedGrid = main.getByTestId("grid-connected");
  const states = await connectedGrid
    .locator("[data-card-state]")
    .evaluateAll((cards) =>
      cards.map((c) => c.getAttribute("data-card-state"))
    );
  expect(states.length).toBeGreaterThanOrEqual(2);
  // Every attention card precedes every plain connected card.
  const lastAttention = states.lastIndexOf("attention");
  const firstConnected = states.indexOf("connected");
  if (lastAttention !== -1 && firstConnected !== -1) {
    expect(lastAttention).toBeLessThan(firstConnected);
  }

  // An unconnected provider keeps the pitch: blurb, a few chips, Set up →. Health
  // Connect is never set up on profile 1.
  const hc = main.getByTestId("integration-card-health-connect");
  await expect(hc).toHaveAttribute("data-card-state", "available");
  await expect(hc.getByText(/Sync weight, body fat/)).toBeVisible();
  await expect(hc.getByText("Set up")).toBeVisible();

  // The planned Garmin dims at the end of the Available group.
  const garmin = main.getByTestId("integration-card-garmin");
  await expect(garmin).toHaveAttribute("data-card-state", "planned");
  await expect(garmin.getByText("Coming soon")).toBeVisible();
  const availableStates = await main
    .getByTestId("grid-available")
    .locator("[data-card-state]")
    .evaluateAll((cards) =>
      cards.map((c) => c.getAttribute("data-card-state"))
    );
  expect(availableStates[availableStates.length - 1]).toBe("planned");
});
