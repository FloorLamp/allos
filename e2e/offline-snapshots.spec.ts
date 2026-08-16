import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";

// Offline read snapshots (#2908) — the render path, end to end, with a real service
// worker and a real dead connection.
//
// This spec runs in its OWN unauthenticated context and logs in by hand (like
// e2e/emergency-card.spec.ts) because it exercises LOGOUT, which destroys the session
// row server-side and would otherwise invalidate the shared cookie every other spec
// relies on.
//
// What it pins, in the order a person would meet it:
//   1. one authenticated visit captures the snapshots into IndexedDB;
//   2. with the connection genuinely off, /offline lists them and renders the med list
//      and today's dose schedule under an "as of" line;
//   3. a dose tapped while offline shows in the offline schedule as queued-resolved —
//      the read-your-writes gap the issue names;
//   4. logout wipes every snapshot, asserted rather than assumed.
test.use({ storageState: { cookies: [], origins: [] } });

const DB = "allos-offline";
const STORE = "snapshots";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "e2e-admin-pass");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
}

// The stored snapshot kinds, read straight out of IndexedDB. Returns [] when the
// database or the store is absent, which is what "wiped" looks like from here.
function storedKinds(page: Page): Promise<string[]> {
  return page.evaluate(
    ([dbName, storeName]) =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open(dbName);
        req.onerror = () => resolve([]);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.close();
            resolve([]);
            return;
          }
          const all = db
            .transaction(storeName, "readonly")
            .objectStore(storeName)
            .getAll();
          all.onerror = () => {
            db.close();
            resolve([]);
          };
          all.onsuccess = () => {
            const rows = all.result as { kind: string }[];
            db.close();
            resolve(rows.map((r) => r.kind).sort());
          };
        };
      }),
    [DB, STORE] as const
  );
}

test("offline reads: one visit captures, /offline renders them with no network, logout wipes (#2908)", async ({
  page,
  context,
}) => {
  // Several full navigations plus a bounded service-worker wait.
  test.slow();
  await login(page);

  // 1. An ordinary authenticated visit is the whole refresh policy — no background
  //    sync, no push. The capture is a client effect after hydration, so poll.
  await page.goto("/");
  await expect
    .poll(() => storedKinds(page), { timeout: 20_000 })
    .toContain("medication-list");

  // 2. The service worker is live in this harness (a production build under
  //    `next start`), so a failed navigation genuinely lands on the precached shell.
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, {
    timeout: 15_000,
  });
  await context.setOffline(true);
  try {
    // A deep-linked navigation that fails lands here, which is the right landing.
    await page.goto("/medications");
    const list = page.getByTestId("offline-snapshot-list");
    await expect(list).toBeVisible();

    // The safety case: the med list, readable with no network and no session.
    await page.getByTestId("offline-open-medication-list").click();
    const meds = page.getByTestId("offline-snapshot-medication-list");
    await expect(meds).toContainText("Sertraline");
    // Every offline render carries its "as of" line — one vocabulary, not a banner
    // dialect per section.
    await expect(page.getByTestId("offline-snapshot-asof")).toContainText(
      /^As of /
    );

    // Today's doses, for the profile that was active at capture.
    await page.getByTestId("offline-snapshot-back").click();
    await page.getByTestId("offline-open-dose-schedule").click();
    await expect(
      page.getByTestId("offline-snapshot-dose-schedule")
    ).toContainText("Sertraline");
  } finally {
    await context.setOffline(false);
  }

  // 3. Log out. Every snapshot goes with the session — the emergency-card wipe shape,
  //    asserted rather than assumed.
  await page.goto("/");
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });
  await expect.poll(() => storedKinds(page), { timeout: 20_000 }).toEqual([]);

  // And /offline offers nothing: no session, no stored payload, no leftovers for
  // whoever picks the phone up next.
  await page.goto("/offline");
  await expect(page.getByTestId("offline-snapshot-list")).toHaveCount(0);
});

test("a dose tapped offline shows as queued-resolved in the offline schedule (#2908)", async ({
  page,
  context,
}) => {
  test.slow();
  await login(page);

  await page.goto("/");
  await expect
    .poll(() => storedKinds(page), { timeout: 20_000 })
    .toContain("dose-schedule");
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, {
    timeout: 15_000,
  });

  // The pills are in your hand and the network isn't there. The page is already
  // loaded and interactive, so the tap lands and the write queue catches it.
  await page.goto("/medications");
  // The Today panel's own row for the seeded Sertraline — one dose, one row.
  const row = page
    .getByTestId("medications-today")
    .locator("[data-today-row]")
    .filter({ hasText: "Sertraline" });
  await expect(row).toHaveCount(1);
  await context.setOffline(true);
  try {
    await row.getByRole("button", { name: "Mark taken" }).click();
    await expect(page.getByTestId("offline-queue-badge")).toHaveText(
      /1 queued offline/
    );

    // The gap the issue names: the device KNOWS the dose was tapped, and until now no
    // offline surface showed it. It does now — marked queued, not presented as a
    // server fact.
    //
    // Straight to /offline rather than re-requesting the page we came from: that URL
    // was fetched online moments ago, so the browser's own HTTP cache can satisfy the
    // navigation without the service worker's offline fallback ever running. The
    // deep-link-lands-here leg is covered by the first test, from a URL this context
    // has not visited.
    await page.goto("/offline");
    await page.getByTestId("offline-open-dose-schedule").click();
    const schedule = page.getByTestId("offline-snapshot-dose-schedule");
    await expect(schedule).toContainText("Sertraline");
    await expect(schedule.getByTestId("offline-queued-mark")).toHaveCount(1);
  } finally {
    await context.setOffline(false);
  }

  // Drain the queue so this spec leaves the world as it found it, then log out (this
  // context's own session, never the shared one).
  await page.goto("/medications");
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });
});
