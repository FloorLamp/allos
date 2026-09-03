import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenSyncInstant } from "./worker-env";
import { expectNoClippedContent } from "./helpers";

// #1880/#2263: flapping is not failing, and what separates them is SILENCE. A
// source alternating Failed/Refreshed with a recent success is `intermittent` — a
// calm amber fact on Review's Connected sources, the Import grid, and its own source
// page — and NEVER enters Needs attention, the Data badge, or Upcoming. Once no run
// has succeeded inside the source's declared tolerance the ONE standing escalates,
// and every surface flips at once, with the failing source rendered exactly once on
// Review (the duplicate-text tripwire).
//
// Weather on PROFILE 1 is this spec's own fixture (the shared seed leaves it
// untouched there — the healthy weather fixture lives on its own findings profile),
// mirroring integration-staleness.spec.ts, which owns the quiet-stop variant of the
// same source and likewise restores it in afterAll.

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

function seedEvents(
  events: { hoursAgo: number; ok: boolean; tally?: string }[]
): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO integration_connections (profile_id, source_id, status)
       VALUES (?, ?, 'connected')
       ON CONFLICT (profile_id, source_id) DO UPDATE SET status = 'connected'`
    ).run(PROFILE_ID, PROVIDER);
    db.prepare(
      `DELETE FROM integration_sync_events WHERE profile_id = ? AND source_id = ?`
    ).run(PROFILE_ID, PROVIDER);
    const ins = db.prepare(
      `INSERT INTO integration_sync_events
         (profile_id, source_id, at, ok, window_start, window_end,
          inserted, updated, unchanged, error, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
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
        e.ok ? null : ERR,
        e.tally ?? null
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

// ALIVE AND DROPPING (#4975): every run succeeded, cells landed, and one metric
// arrived in every refresh and was stored none of the times. Nothing failed and data
// IS arriving, so neither `intermittent` nor `failing` describes it — and each of the
// surfaces below had a branch for both of those and none for this.
const DROPPED_METRIC = "uv_index";
function seedDropping(): void {
  const tally = JSON.stringify({
    warnings: [],
    origins: [],
    tally: {
      temperature_c: { received: 24, landed: 24 },
      [DROPPED_METRIC]: { received: 24, landed: 0 },
    },
  });
  seedEvents([
    { hoursAgo: 6, ok: true, tally },
    { hoursAgo: 4, ok: true, tally },
    { hoursAgo: 2, ok: true, tally },
    { hoursAgo: 1, ok: true, tally },
  ]);
}

function clearFixture(): void {
  withDb((db) => {
    db.prepare(
      `DELETE FROM integration_sync_events WHERE profile_id = ? AND source_id = ?`
    ).run(PROFILE_ID, PROVIDER);
    db.prepare(
      `DELETE FROM integration_connections WHERE profile_id = ? AND source_id = ?`
    ).run(PROFILE_ID, PROVIDER);
  });
}

test.afterAll(() => clearFixture());

test("Connected-source timestamp and chevron share a trailing rail inside the Data page measure", async ({
  page,
}) => {
  seedFlapping();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/data?section=review");

  const healthy = page.getByTestId("sources-healthy");
  const trailing = healthy.getByTestId(`source-trailing-${PROVIDER}`);
  const timestamp = trailing.getByTestId("sync-timestamp-compact");
  await expect(timestamp).toHaveCount(1);
  await expect(trailing.locator("svg")).toHaveCount(1);
  const timestampBeforeChevron = await trailing.evaluate((rail) => {
    const timestamp = rail.querySelector<HTMLElement>(
      '[data-testid="sync-timestamp-compact"]'
    )!;
    const chevron = rail.querySelector<SVGElement>("svg")!;
    return (
      (timestamp.compareDocumentPosition(chevron) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0
    );
  });
  expect(timestampBeforeChevron).toBe(true);
  await expect
    .poll(async () => {
      const rightGap = await trailing.evaluate((rail) => {
        const chevron = rail.querySelector<SVGElement>("svg")!;
        const surface = rail.parentElement!;
        return (
          surface.getBoundingClientRect().right -
          chevron.getBoundingClientRect().right
        );
      });
      return rightGap >= 10 && rightGap <= 14
        ? "right gap is 10–14px"
        : `right gap is ${rightGap}px`;
    })
    .toBe("right gap is 10–14px");
  expect(
    (await page.getByTestId("data-page").boundingBox())!.width
  ).toBeLessThanOrEqual(1152);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoClippedContent(page);
});

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

test("a live source that stores nothing says so on every surface it escalates to", async ({
  page,
}) => {
  // #4975. The standing is the whole delivery — Review's Needs-attention card filters
  // on `isEscalatedSource`, never on an attention kind — but the surfaces underneath
  // it had no branch for a source that is syncing and losing data, so each of them
  // fell back to a sentence written for a source that had gone quiet or failed. This
  // walks the three of them together.
  seedDropping();

  // Review: escalated, with the chip and a consequence that names WHAT is being lost.
  // The generic line here is "…have stopped arriving", which is false: they arrive.
  await page.goto("/data?section=review");
  const review = page.getByTestId("review-inbox");
  const card = review
    .getByTestId("needs-attention-sources")
    .getByTestId(`source-${PROVIDER}`);
  await expect(card.getByTestId(`sync-status-${PROVIDER}`)).toContainText(
    "Dropping records"
  );
  const consequence = card.getByTestId(`source-consequence-${PROVIDER}`);
  await expect(consequence).toHaveText(
    "Uv index is arriving but not being stored."
  );
  await expect(consequence).not.toContainText("stopped arriving");
  // It leaves the calm half of the page, like every other escalated source.
  await expect(
    review.getByTestId("connected-sources").getByTestId(`source-${PROVIDER}`)
  ).toHaveCount(0);

  // The grid: the rose attention card, with a fact instead of "Refreshed · 1 hour
  // ago" — which is what fell through under that border before.
  await page.goto("/data?section=import");
  const gridCard = page.getByTestId(`integration-card-${PROVIDER}`);
  await expect(gridCard).toHaveAttribute("data-card-state", "attention");
  await expect(gridCard.getByText("Dropping records")).toBeVisible();
  await expect(gridCard).toContainText("Uv index is arriving but not being stored.");
  await expect(gridCard.getByText("Forecast refreshed")).toHaveCount(0);

  // The source page: the standing as a headline, and the reason line the header
  // rendered NOTHING for — the stale line is gated on staleness and the error lines
  // on a failed run, and this source is neither.
  await page.goto("/integrations/weather");
  await expect(page.getByTestId(`sync-status-${PROVIDER}`)).toContainText(
    "Dropping records"
  );
  await expect(page.getByTestId(`sync-period-${PROVIDER}`)).toContainText(
    "Some records aren't being stored"
  );
  await expect(page.getByTestId(`sync-dropping-${PROVIDER}`)).toHaveText(
    "Uv index is arriving but not being stored."
  );
  await expect(page.getByTestId(`sync-stale-${PROVIDER}`)).toHaveCount(0);
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
  expect(states).toEqual(expect.arrayContaining(["attention", "connected"]));
  const lastAttention = states.lastIndexOf("attention");
  const firstConnected = states.indexOf("connected");
  expect(lastAttention).toBeLessThan(firstConnected);

  // An unconnected source keeps the pitch: blurb, a few chips, Set up →. Health
  // Connect is never set up on profile 1.
  const hc = main.getByTestId("integration-card-health-connect");
  await expect(hc).toHaveAttribute("data-card-state", "available");
  // The card shows the registry LEAD and only the lead (#3490/#1880): the
  // 72-word blurb that used to sit here is now the folded `detail`, which no
  // grid card renders at all.
  await expect(hc.getByText(/Sync weight, heart rate, steps/)).toBeVisible();
  await expect(hc.getByText(/MyFitnessPal/)).toHaveCount(0);
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
