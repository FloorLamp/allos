import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";

// #1596: the food quick-adds — a one-tap food-group serving and the protein-grams
// control — queue while offline and replay through the same write cores on
// reconnect, landing EXACTLY ONCE despite the racing flush triggers (online event,
// on-load flush, Background Sync). Delta-based assertions on the server-rendered
// counts after a full reload prove the write landed once without exact-counting
// shared seed rows.

async function revealFoodGroup(page: Page, slug: string) {
  const row = page.getByTestId(`food-group-${slug}`);
  if (!(await row.isVisible())) {
    await page.getByTestId("food-more-groups-summary").click();
    await expect(row).toBeVisible();
  }
}

test("a food serving tapped offline queues, then syncs exactly once on reconnect (#1596)", async ({
  page,
  context,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await revealFoodGroup(page, "nuts_seeds");

  // The server-rendered baseline for this meal slot today.
  const count = page.getByTestId("count-nuts_seeds");
  const before = Number((await count.textContent())?.trim() || "0");

  // The kitchen-moment: connection gone at the instant of the tap.
  await context.setOffline(true);
  await hydratedClick(page, page.getByTestId("log-nuts_seeds"));

  // Queued, not failed: the toast + pending badge, with the optimistic count
  // standing in for the server total.
  await expect(
    page.getByText("Saved offline — will sync when you reconnect.")
  ).toBeVisible();
  const badge = page.getByTestId("offline-queue-badge");
  await expect(badge).toHaveText(/1 queued offline/);
  await expect(count).toHaveText(String(before + 1));

  // The undo "−" is deliberately online-only (a decrement is not a capture): an
  // offline tap rolls back with an honest message rather than pretending.
  await hydratedClick(page, page.getByTestId("undo-nuts_seeds"));
  await expect(
    page.getByText("You're offline — removing a serving needs a connection.")
  ).toBeVisible();
  await expect(count).toHaveText(String(before + 1));
  await expect(badge).toHaveText(/1 queued offline/);

  // Reconnect → the "online" event triggers the replay.
  await context.setOffline(false);
  await expect(page.getByText(/Synced 1 offline entr/)).toBeVisible();
  await expect(badge).toHaveCount(0);

  // Durable server truth after a reload (which re-runs the on-load flush against
  // the drained queue): exactly ONE more serving than the baseline.
  await page.reload();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  await revealFoodGroup(page, "nuts_seeds");
  await expect(page.getByTestId("count-nuts_seeds")).toHaveText(
    String(before + 1)
  );
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);
});

test("protein grams added offline queue, then sync exactly once on reconnect (#1596)", async ({
  page,
  context,
}) => {
  await page.goto("/nutrition");
  const quickAdd = page.getByTestId("protein-quickadd");
  await expect(quickAdd).toBeVisible();

  // The server-rendered baseline ("Ng today").
  const total = page.getByTestId("protein-quickadd-total");
  const before = Number(
    ((await total.textContent()) ?? "").match(/(\d+)g today/)?.[1] ?? "0"
  );

  await context.setOffline(true);
  await page.getByTestId("protein-quickadd-input").fill("30");
  await hydratedClick(page, page.getByTestId("protein-quickadd-add"));

  await expect(
    page.getByText("Saved offline — will sync when you reconnect.")
  ).toBeVisible();
  const badge = page.getByTestId("offline-queue-badge");
  await expect(badge).toHaveText(/1 queued offline/);
  await expect(total).toHaveText(`${before + 30}g today`);

  await context.setOffline(false);
  await expect(page.getByText(/Synced 1 offline entr/)).toBeVisible();
  await expect(badge).toHaveCount(0);

  // Durable, exactly once: the reloaded (server-rendered) total moved by 30 —
  // not 60, which is what a double-replay past the idempotency ledger would show.
  await page.reload();
  await expect(page.getByTestId("protein-quickadd-total")).toHaveText(
    `${before + 30}g today`
  );
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);
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
): { eaten_at: string | null; time_source: string | null } | undefined {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return db
      .prepare(
        `SELECT eaten_at, time_source FROM food_log_events
          WHERE id > ? AND group_key = 'berries'
          ORDER BY id DESC LIMIT 1`
      )
      .get(afterId) as
      { eaten_at: string | null; time_source: string | null } | undefined;
  } finally {
    db.close();
  }
}

// #2053: the eating-time statement has to survive the QUEUE, because a kitchen-moment
// tap is precisely the one most likely to be offline — the case the chips exist for is
// also the case the connection is worst. Offline the browser has no server to resolve a
// choice against, so the capture carries a resolved INSTANT, and the replay validates it
// (acceptEatenAt) rather than trusting it: it came off an untrusted client wall clock,
// the same posture resolveQueuedTakenAt takes for a queued dose's tap instant.
test("a stated eating time rides an offline serving through replay (#2053)", async ({
  page,
  context,
}) => {
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // State the time BEFORE going offline — the chips are local state, so the statement is
  // made against a page that already rendered its server-resolved options.
  await hydratedClick(page, page.getByTestId("food-eating-now"));
  await expect(page.getByTestId("food-eating-now")).toHaveAttribute(
    "aria-pressed",
    "true"
  );

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
  expect(row!.eaten_at).not.toBeNull();
  expect(
    Math.abs(new Date(row!.eaten_at!).getTime() - frozenNow().getTime())
  ).toBeLessThan(60 * 60_000);
});
