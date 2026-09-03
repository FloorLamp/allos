import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  hydratedClick,
  openFoodAdd,
  settledClick,
  settledFill,
  settledSelect,
} from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";
import {
  foodEventHighWater,
  removeFoodEventsAfter,
} from "./food-ledger-fixture";

// #1596: the food quick-adds — a one-tap food-group serving and the protein-grams
// control — queue while offline and replay through the same write cores on
// reconnect, landing EXACTLY ONCE despite the racing flush triggers (online event,
// on-load flush, Background Sync). Delta-based assertions on the server-rendered
// counts after a full reload prove the write landed once without exact-counting
// shared seed rows.

async function revealFoodGroup(page: Page, slug: string) {
  // The add layer folds behind one `+ Add` door (#4477) and the overflow is a
  // second fold inside it, so reaching a row means opening both.
  await openFoodAdd(page);
  const row = page.getByTestId(`food-group-${slug}`);
  if (!(await row.isVisible())) {
    await hydratedClick(page, page.getByTestId("food-more-groups-summary"));
    await expect(row).toBeVisible();
  }
}

let foodEventId: number;
test.beforeEach(() => {
  foodEventId = foodEventHighWater();
});
test.afterEach(() => {
  removeFoodEventsAfter(foodEventId, ["nuts_seeds", "berries"]);
});

test.describe("protein quick-add hydration (#4399)", () => {
  test.use({ serviceWorkers: "block" });

  test("the arming fill survives a forced pre-hydration window", async ({
    page,
  }) => {
    let releaseChunks = (): void => {};
    const chunksReleased = new Promise<void>((resolve) => {
      releaseChunks = resolve;
    });
    await page.route(
      /\/_next\/static\/chunks\/[^?]*\.js(\?|$)/,
      async (route) => {
        await chunksReleased;
        await route.continue();
      }
    );
    await page.goto("/nutrition", { waitUntil: "commit" });
    await openFoodAdd(page);
    const input = page.getByTestId("protein-quickadd-input");
    await expect(input).toBeVisible();
    expect(
      await input.evaluate((node) =>
        Object.keys(node).some((key) => key.startsWith("__react"))
      )
    ).toBe(false);

    const fill = settledFill(page, input, "30");
    releaseChunks();
    await fill;
    await expect(page.getByTestId("protein-quickadd-add")).toBeEnabled();
  });
});

test("food serving and protein grams queue together offline, then each sync exactly once (#1596)", async ({
  page,
  context,
}) => {
  await page.goto("/nutrition");
  await openFoodAdd(page);
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await revealFoodGroup(page, "nuts_seeds");
  const quickAdd = page.getByTestId("protein-quickadd");
  await expect(quickAdd).toBeVisible();

  // Server-rendered baselines for the meal slot and protein total today.
  const count = page.getByTestId("count-nuts_seeds");
  const servingBefore = Number((await count.textContent())?.trim() || "0");
  const total = page.getByTestId("protein-quickadd-total");
  const proteinBefore = Number(
    ((await total.textContent()) ?? "").match(/(\d+)g today/)?.[1] ?? "0"
  );

  // The kitchen-moment: connection gone while both quick captures are made.
  await context.setOffline(true);
  await hydratedClick(page, page.getByTestId("log-nuts_seeds"));

  // Queued, not failed: the toast + pending badge, with the optimistic count
  // standing in for the server total.
  const offlineNotices = page.getByText(
    "Saved offline — will sync when you reconnect."
  );
  await expect(offlineNotices).toHaveCount(1);
  const badge = page.getByTestId("offline-queue-badge");
  await expect(badge).toHaveText(/1 queued offline/);
  await expect(count).toHaveText(String(servingBefore + 1));

  // The undo "−" is deliberately online-only (a decrement is not a capture): an
  // offline tap rolls back with an honest message rather than pretending.
  await hydratedClick(page, page.getByTestId("undo-nuts_seeds"));
  await expect(
    page.getByText("You're offline — removing a serving needs a connection.")
  ).toBeVisible();
  await expect(count).toHaveText(String(servingBefore + 1));
  await expect(badge).toHaveText(/1 queued offline/);

  await settledFill(page, page.getByTestId("protein-quickadd-input"), "30");
  await hydratedClick(page, page.getByTestId("protein-quickadd-add"));
  await expect(offlineNotices).toHaveCount(2);
  await expect(badge).toHaveText(/2 queued offline/);
  await expect(total).toHaveText(`${proteinBefore + 30}g today`);

  // One reconnect flushes both action kinds.
  await context.setOffline(false);
  await expect(page.getByText(/Synced 2 offline entr/)).toBeVisible();
  await expect(badge).toHaveCount(0);

  // Durable server truth after a reload (which also re-runs the on-load flush
  // against the drained queue): one serving and 30 g, never duplicates.
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await revealFoodGroup(page, "nuts_seeds");
  await expect(page.getByTestId("count-nuts_seeds")).toHaveText(
    String(servingBefore + 1)
  );
  await expect(page.getByTestId("protein-quickadd-total")).toHaveText(
    `${proteinBefore + 30}g today`
  );
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);

  // Undo, so this leaves the SHARED profile as it found it — the same rule
  // protein-quickadd.spec follows on its own isolated fixture, and for the same
  // reason: tracked grams flip the adequacy card from the ESTIMATED basis to
  // COMBINED, which is exactly what protein-adequacy.spec asserts about profile 1.
  // The delta assertions above are already shared-seed safe; the RESIDUE was not,
  // and a leftover row breaks any neighbour on this worker rather than this test.
  // It only surfaced when duration-balanced sharding (#2590) put the two specs in
  // one shard — the collision was always here, waiting on a grouping to reveal it.
  await settledClick(page, page.getByTestId("protein-quickadd-undo"));
  await expect(page.getByTestId("protein-quickadd-total")).toHaveText(
    `${proteinBefore}g today`
  );
});

// The ledger's high-water mark, so a test can address the row IT created without
// exact-counting the shared seed. A worker owns its database and runs one test at a
// time, so nothing else moves this between the two reads.
function maxFoodEventId(): number {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return (
      (
        db.prepare("SELECT MAX(id) AS id FROM food_log_events").get() as {
          id: number | null;
        }
      ).id ?? 0
    );
  } finally {
    db.close();
  }
}

function newestBerriesEventAfter(
  afterId: number
): { occurred_at: string | null; time_source: string | null } | undefined {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return db
      .prepare(
        `SELECT occurred_at, time_source FROM food_log_events
          WHERE id > ? AND group_key = 'berries'
          ORDER BY id DESC LIMIT 1`
      )
      .get(afterId) as
      { occurred_at: string | null; time_source: string | null } | undefined;
  } finally {
    db.close();
  }
}

// #2053: the eating-time statement has to survive the QUEUE, because a kitchen-moment
// tap is precisely the one most likely to be offline — the case the chips exist for is
// also the case the connection is worst. Offline the browser has no server to resolve a
// choice against, so the capture carries a resolved INSTANT, and the replay validates it
// (judgeEatenAt) rather than trusting it: it came off an untrusted client wall clock,
// the same posture resolveQueuedTakenAt takes for a queued dose's tap instant. What it
// is validated AGAINST is the app's own clock seam (#2287), not a second real clock —
// the fixture puts this browser on the same frozen instant the server reads, so the
// statement and the gate answer one "now" and only a genuinely divergent device clock
// can be refused.
test("a stated eating time rides an offline serving through replay (#2053)", async ({
  page,
  context,
}) => {
  await page.goto("/nutrition");
  await openFoodAdd(page);
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // State the time BEFORE going offline — the control is local state, so the statement
  // is made against a page that already rendered. Since #3987 it sits behind one fold.
  await hydratedClick(page, page.getByTestId("food-when-summary"));
  await hydratedClick(page, page.getByTestId("food-when-now"));
  await expect(page.getByTestId("food-when-time")).not.toHaveValue("");

  await revealFoodGroup(page, "berries");
  const count = page.getByTestId("count-berries");
  const before = Number((await count.textContent())?.trim() || "0");
  const baselineEventId = maxFoodEventId();

  await context.setOffline(true);
  await hydratedClick(page, page.getByTestId("log-berries"));
  await expect(
    page.getByText("Saved offline — will sync when you reconnect.")
  ).toBeVisible();
  await expect(page.getByTestId("offline-queue-badge")).toHaveText(
    /1 queued offline/
  );

  await context.setOffline(false);
  await expect(page.getByText(/Synced 1 offline entr/)).toBeVisible();
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await revealFoodGroup(page, "berries");
  await expect(page.getByTestId("count-berries")).toHaveText(
    String(before + 1)
  );

  // The replayed serving carries the stated instant, not a NULL and not the reconnect
  // moment. Addressed by the row THIS test created — the one berries event newer than the
  // baseline id — so nothing exact-counts a seeded row.
  const row = newestBerriesEventAfter(baselineEventId);
  expect(row).not.toBeUndefined();
  expect(row!.time_source).toBe("stated");
  expect(row!.occurred_at).not.toBeNull();
  expect(
    Math.abs(new Date(row!.occurred_at!).getTime() - frozenNow().getTime())
  ).toBeLessThan(60 * 60_000);
});

// #2296 (owner ruling, 2026-08-08) — a device clock running fast must not cost the
// stated eating time IN SILENCE.
//
// The acceptance gate tolerates five minutes of client/server skew and refuses
// anything further; that tolerance is defensible and is unchanged here. What was not
// defensible is that the refusal was invisible: the offline capture is the ONE food
// path carrying a client INSTANT (there is no server to resolve a choice against while
// offline), so a phone whose clock had drifted threw away the minute the user had just
// stated while the reconnect toast reported a clean sync.
//
// The fast clock is simulated the way the bug reproduces: the browser's system time is
// pushed hours ahead of the SERVER'S OWN NOW, so the captured instant lands beyond the
// skew window. That offset is anchored on `frozenNow()` — the instant the app's clock
// seam actually answers (#2287) — rather than on the runner's wall clock, so this test
// measures a DEVICE divergence and never the suite's own real-vs-frozen gap. Twelve
// hours is far past any run's own duration, so WHICH rule fires ("future", checked
// first) is deterministic.
//
// SINCE #3273 THE CLOCK IS SET BEFORE THE STATEMENT, and that is the same defect one
// step earlier. The bar now states through the shared when-control, which offers the
// hours of a day and resolves them against the BROWSER's clock — so a device that
// believes it is already tomorrow offers this day's late hours as though they were
// past, and the capture carries an instant hours beyond the server's now. Setting the
// clock after the fill would prove nothing now: the fill happens at fill time and the
// user can see the absolute time it produced.
const FAST_CLOCK_MS = 12 * 60 * 60_000;
// An hour the fast-clocked browser believes is behind it and the server knows is
// ahead: local time is pinned to 13:mm, so 23:00 today is ~10 hours in the server's
// future while the +12h device reads the day as already over.
const FAST_CLOCK_HOUR = "23:00";

test("a fast device clock keeps the serving and the sync SAYS the time wasn't recorded (#2296)", async ({
  page,
  context,
}) => {
  await page.goto("/nutrition");
  await openFoodAdd(page);
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // The broken clock, then a RELOAD: the control reads the browser's clock at render
  // to decide which of the day's hours are already past, and setting the time under a
  // mounted React tree changes nothing it has already rendered. The reload is what
  // makes this a device that has believed the wrong time all along.
  await context.clock.setSystemTime(
    new Date(frozenNow().getTime() + FAST_CLOCK_MS)
  );
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  await revealFoodGroup(page, "berries");
  const count = page.getByTestId("count-berries");
  const before = Number((await count.textContent())?.trim() || "0");
  const baselineEventId = maxFoodEventId();

  // The user states a time, exactly as in the passing #2053 case above — except the
  // device's own clock is what decided this hour was already behind them.
  // Through the settled path: a bare selectOption on a controlled select can land
  // before hydration and be reverted, and here that would silently withdraw the
  // statement this test is entirely about.
  await hydratedClick(page, page.getByTestId("food-when-summary"));
  const field = page.getByTestId("food-when-time");
  const value = await field
    .getByRole("option", { name: FAST_CLOCK_HOUR, exact: true })
    .getAttribute("value");
  await settledSelect(page, field, value ?? "");

  await context.setOffline(true);
  await hydratedClick(page, page.getByTestId("log-berries"));
  await expect(
    page.getByText("Saved offline — will sync when you reconnect.")
  ).toBeVisible();
  await expect(page.getByTestId("offline-queue-badge")).toHaveText(
    /1 queued offline/
  );

  // THE FIX: the confirmation the user already gets on reconnect now admits what it
  // could not keep, on the same toast and in the same calm tone — the entry DID sync,
  // so this must not read like the red "couldn't be applied" panel.
  await context.setOffline(false);
  await expect(
    page.getByText(
      "Synced 1 offline entry. One was saved without its stated time — your device's clock is ahead."
    )
  ).toBeVisible();
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);
  // Not the dead-letter panel: nothing here needs re-entering.
  await expect(page.getByTestId("offline-rejected-review")).toHaveCount(0);

  // And the ruling's other half: the SERVING still landed. Only the minute is gone.
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await revealFoodGroup(page, "berries");
  await expect(page.getByTestId("count-berries")).toHaveText(
    String(before + 1)
  );

  const row = newestBerriesEventAfter(baselineEventId);
  expect(row).not.toBeUndefined();
  expect(row!.occurred_at).toBeNull();
  expect(row!.time_source).toBeNull();
});
