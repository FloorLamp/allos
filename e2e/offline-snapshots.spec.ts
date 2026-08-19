import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { hydratedClick, readyForOffline, settledClick } from "./helpers";
import { SNAPSHOT_KINDS } from "@/lib/offline/snapshots";
import {
  E2E_LOGIN_OFFLINE_SNAPSHOTS,
  OFFLINE_SNAPSHOTS_MED,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Offline read snapshots (#2908) — the render path, end to end, with a real service
// worker and a real dead connection.
//
// This spec owns its LOGIN and its PROFILE (#3040, the #3017 coaching-episode
// shape — see e2e/seed/intake.ts's seedOfflineSnapshots for why the shared ones
// could not host it). It runs in its OWN unauthenticated context and logs in by
// hand (like e2e/emergency-card.spec.ts) because it exercises LOGOUT, which
// destroys the session row server-side and would otherwise invalidate the shared
// cookie every other spec relies on. And it captures and replays against its own
// profile because the reconnect replay writes a REAL taken-dose row for whatever
// profile captured the tap — on the shared profile 1 that leftover cost
// offline-write-gate's R3d a red while this spec's old drain assertion, a
// count-0 on a fresh navigation, passed whether or not the drain had happened.
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
  await page.fill('input[name="username"]', E2E_LOGIN_OFFLINE_SNAPSHOTS);
  await page.fill('input[name="password"]', E2E_MEMBER_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
}

// The stored snapshot kinds, read straight out of IndexedDB. Returns [] when the
// database or the store is absent, which is what "wiped" looks like from here.
//
// IT MUST NOT CREATE THE DATABASE, and that is not a tidiness point — it is what made
// this spec red on CI and green here. `indexedDB.open(name)` with NO version CREATES
// the database at version 1 when it does not exist, so a poll that raced the app's own
// first open left a v1 connection in the way of the app's v4 upgrade. IndexedDB answers
// that with `blocked`, which never fires `error`, so before the companion fix in
// lib/offline/idb.ts the app's open never settled at all: no capture, no offline
// render, and a 15s timeout on a control that was never going to appear. `databases()`
// asks the question without opening anything.
function storedKinds(page: Page): Promise<string[]> {
  return page.evaluate(
    ([dbName, storeName]) =>
      (async () => {
        const known = await indexedDB.databases();
        if (!known.some((d) => d.name === dbName)) return [];
        return new Promise<string[]>((resolve) => {
          const req = indexedDB.open(dbName);
          req.onerror = () => resolve([]);
          req.onblocked = () => resolve([]);
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
        });
      })(),
    [DB, STORE] as const
  );
}

// Wait until the offline shell's device-local read has RESOLVED.
//
// The shell hydrates and only then reads IndexedDB, so until this settles "no snapshot
// list" and "still reading" look identical — which made every assertion below a race
// that an idle box wins and a loaded 2-core CI runner loses. Waiting on the page's own
// stated state is the fix; a bigger timeout on the locator would only have moved it.
async function settledOfflineRead(page: Page): Promise<void> {
  await expect(page.locator("main[data-offline-read]")).toHaveAttribute(
    "data-offline-read",
    "done",
    { timeout: 30_000 }
  );
}

// Latency on both legs of a logout, so the window the leaks live in is a real interval
// rather than whatever a fast box happens to leave: enough on the snapshot GET to have
// one genuinely in flight when the button is pressed, and enough on the logout POST to
// keep the page alive, authenticated and interactive while it lands — which is not a
// contrivance but exactly how long a real logout takes.
const SNAPSHOT_GET_LATENCY_MS = 2_000;
const LOGOUT_POST_LATENCY_MS = 6_000;

test("offline reads: one visit captures, /offline renders them with no network, logout wipes (#2908)", async ({
  page,
  context,
}) => {
  // Several full navigations plus a bounded service-worker wait.
  test.slow();
  await login(page);

  // 1. An ordinary authenticated visit is the whole refresh policy — no background
  //    sync, no push. Wait on the CAPTURED STATE, never on the navigation: a loaded
  //    page is not a captured snapshot, and the refresh is deliberately background
  //    work nobody is waiting on (which is also why lib/nav-fetch-guard.ts never holds
  //    it). Every kind, not just one — the store is written in a single transaction,
  //    so a partial read means the write has not landed yet.
  await page.goto("/");
  await expect
    .poll(() => storedKinds(page), { timeout: 30_000 })
    .toEqual([...SNAPSHOT_KINDS].sort());

  // 2. The service worker is live in this harness (a production build under
  //    `next start`), so a failed navigation genuinely lands on the precached shell —
  //    and the shell's own code is in the cache because the app put it there, not
  //    because this test opened /offline first (#2997). THIS PAGE HAS NEVER BEEN
  //    VISITED in this context, which is the whole point: the precache is the HTML
  //    alone, so without the warm-up the shell renders and never hydrates, and every
  //    testid below stays absent in a way that reads like a product bug.
  await readyForOffline(page);
  await context.setOffline(true);
  try {
    // A deep-linked navigation that fails lands here, which is the right landing.
    await page.goto("/medications");
    await settledOfflineRead(page);
    await expect(page.getByTestId("offline-snapshot-list")).toBeVisible();

    // The safety case: the med list, readable with no network and no session.
    await hydratedClick(page, page.getByTestId("offline-open-medication-list"));
    const meds = page.getByTestId("offline-snapshot-medication-list");
    await expect(meds).toContainText(OFFLINE_SNAPSHOTS_MED);
    // Every offline render carries its "as of" line — one vocabulary, not a banner
    // dialect per section.
    await expect(page.getByTestId("offline-snapshot-asof")).toContainText(
      /^As of /
    );

    // Today's doses, for the profile that was active at capture.
    await hydratedClick(page, page.getByTestId("offline-snapshot-back"));
    await hydratedClick(page, page.getByTestId("offline-open-dose-schedule"));
    await expect(
      page.getByTestId("offline-snapshot-dose-schedule")
    ).toContainText(OFFLINE_SNAPSHOTS_MED);
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
  // whoever picks the phone up next. The settled marker is what makes this a real
  // assertion — without it, "no list" is also what a page mid-read looks like, and
  // the test would pass before it had read anything.
  await page.goto("/offline");
  await settledOfflineRead(page);
  await expect(page.getByTestId("offline-snapshot-list")).toHaveCount(0);
});

// THE OTHER HALF OF THE WINDOW, and the one that actually shipped red.
//
// The fence above stops a refresh caught MID-FLIGHT by the wipe. It structurally cannot
// stop a refresh that STARTS after it: that refresh captures the post-wipe generation,
// so its fence holds — correctly, by the fence's own rule. It then reads an EMPTY store,
// concludes every kind is missing, asks the server for all five, and is answered 200,
// because logout does not end the session until its POST lands. The complete payload
// goes straight back into the store logout just cleared.
//
// On CI that surfaced as all five kinds surviving logout, from the ordinary test above,
// with no instrumentation. The trigger there was incidental timing; here it is the
// refresher's own `online` trigger, fired deliberately AFTER the store is observed
// empty, so the ordering is a fact of the test rather than a hope. A reconnect during a
// logout round trip is a real thing to do — this is the app's own public behaviour, not
// a back door.
//
// TITLED FOR THE GUARD IT ACTUALLY OBSERVES. There are two halves to the gate:
// `snapshotWritesClosed()`, asked before the fetch so a closed device does not even make
// the request, and `gateAllows` inside the write's own transaction. This test is
// satisfied by the FIRST — it stays green against `gateAllows` mutated to `return true`,
// because the request never happens. That is a real guard and worth pinning; it is just
// not the other one. The in-transaction half is what the test at :290 and
// offline-write-gate.spec.ts's R3d/R3e observe, and calling this one "writes nothing"
// claimed both.
test("logout stops the REQUEST: a refresh started after the wipe never asks the server (#2908)", async ({
  page,
}) => {
  test.slow();
  await login(page);

  await page.goto("/");
  await expect
    .poll(() => storedKinds(page), { timeout: 30_000 })
    .toEqual([...SNAPSHOT_KINDS].sort());

  let snapshotGetsAfterClick = 0;
  let clicked = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.url().includes("/api/offline-snapshots")) {
      if (clicked) snapshotGetsAfterClick += 1;
    } else if (request.method() === "POST") {
      // The only POST from here on is the logout Server Action. Holding it open is what
      // keeps the page alive, authenticated and interactive — which is the real
      // condition, not a contrivance: that is exactly how long a logout takes.
      await new Promise((r) => setTimeout(r, LOGOUT_POST_LATENCY_MS));
    }
    await route.continue();
  });

  clicked = true;
  await page.getByRole("button", { name: "Log out" }).click();

  // Wait for the WIPE, not for the navigation: everything below has to happen in the
  // window between the store being emptied and the session actually ending.
  await expect.poll(() => storedKinds(page), { timeout: 15_000 }).toEqual([]);

  // Now wake the refresher, on a page that is still mounted and still authenticated,
  // with an empty store in front of it. Before the close this asked for all five kinds
  // and got a 200.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await page.waitForURL(/\/login/, { timeout: 30_000 });

  // Nothing came back — and nothing was even ASKED for. The second assertion is the
  // stronger one: a page on its way to /login has no business requesting a fresh copy
  // of the payload it just erased, and "it asked but the write was refused" would leave
  // the answer depending on a race the user cannot see.
  await expect.poll(() => storedKinds(page), { timeout: 20_000 }).toEqual([]);
  expect(
    snapshotGetsAfterClick,
    "the refresher asked the server for snapshots after logout began"
  ).toBe(0);

  await page.goto("/offline");
  await settledOfflineRead(page);
  await expect(page.getByTestId("offline-snapshot-list")).toHaveCount(0);
});

// Drop ONE stored kind, so the next refresh has something to ask the server for. Uses
// the same no-version open as `storedKinds` above, and for the same reason: the database
// already exists at v4 here, and naming no version can never create it at v1 in the way
// of the app's own upgrade.
async function dropStoredKind(page: Page, kind: string): Promise<void> {
  await page.evaluate(
    ([dbName, storeName, doomed]) =>
      new Promise<void>((resolve) => {
        const req = indexedDB.open(dbName);
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
        req.onsuccess = () => {
          const db = req.result;
          const t = db.transaction(storeName, "readwrite");
          t.objectStore(storeName).delete(doomed);
          t.oncomplete = () => {
            db.close();
            resolve();
          };
          t.onerror = () => {
            db.close();
            resolve();
          };
        };
      }),
    [DB, STORE, kind] as const
  );
}

// THE WIPE RACE, MADE DETERMINISTIC.
//
// The logout wipe lost, and every snapshot — the med list, the dose schedule — survived
// it and rendered session-free at /offline. Not because the 2s bound expired: the wipe
// itself always completed. The leak was the RE-WRITE after it. The sidebar wipes first
// and then keeps the page alive for the whole logout round trip, and the refresher's
// only guard was the effect's `cancelled` flag, which is set on UNMOUNT — which happens
// only once the logout navigation lands. So the entire logout POST was a window in which
// an in-flight `putSnapshots(fresh)` restored the full payload into a cleared store.
//
// It reproduced with no instrumentation at all, on a cold-build first run, which is
// exactly why this test does not leave the timing to the box: latency on the snapshot
// GET puts a refresh IN FLIGHT when the button is pressed, and latency on the logout
// POST holds the page alive long enough for that refresh to land. A test that passes
// because the machine was fast is not a test of a PHI wipe.
test("logout wipes even with a snapshot refresh in flight (#2908)", async ({
  page,
}) => {
  test.slow();
  await login(page);

  await page.goto("/");
  await expect
    .poll(() => storedKinds(page), { timeout: 30_000 })
    .toEqual([...SNAPSHOT_KINDS].sort());

  // Installed AFTER the initial capture, so only the racing refresh is slowed. The two
  // counters make the race a stated FACT of this test rather than an assumption: a run
  // where the GET was never asked for, or was already answered before the button was
  // pressed, proves nothing and says so below instead of passing.
  let snapshotGets = 0;
  let snapshotGetReleasedAt = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.url().includes("/api/offline-snapshots")) {
      snapshotGets += 1;
      await new Promise((r) => setTimeout(r, SNAPSHOT_GET_LATENCY_MS));
      // Real elapsed time in the RUNNER, ordering two events in this test's own
      // lifetime: nothing is stored, and nothing reaches the app's frozen clock.
      snapshotGetReleasedAt = Date.now(); // clock-ok: runner-side ordering, never stored
    } else if (request.method() === "POST") {
      // The only POST from here on is the logout Server Action.
      await new Promise((r) => setTimeout(r, LOGOUT_POST_LATENCY_MS));
    }
    await route.continue();
  });

  // Give the refresher something to fetch, then wake it. `online` is one of its own
  // triggers, so nothing here reaches past the component's public behaviour.
  await dropStoredKind(page, "medication-list");
  await expect
    .poll(() => storedKinds(page), { timeout: 10_000 })
    .not.toContain("medication-list");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  // …and log out while that GET is still in the air.
  const logoutClickedAt = Date.now(); // clock-ok: runner-side ordering, never stored
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });

  // The race was real, or this test is worthless.
  expect(
    snapshotGets,
    "the refresher never asked — no refresh was in flight"
  ).toBeGreaterThan(0);
  expect(
    snapshotGetReleasedAt,
    "the snapshot GET was answered BEFORE logout was pressed — the window this test exists to cover never opened"
  ).toBeGreaterThan(logoutClickedAt);

  // Nothing survived, and nothing came back. The poll deliberately outlasts the GET's
  // latency: an empty store read before the racing write would land is not an answer.
  await expect.poll(() => storedKinds(page), { timeout: 20_000 }).toEqual([]);

  await page.goto("/offline");
  await settledOfflineRead(page);
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
    .poll(() => storedKinds(page), { timeout: 30_000 })
    .toEqual([...SNAPSHOT_KINDS].sort());
  // No hand warm-up: the app puts /offline's own code in the cache (#2997), and this
  // context has never opened that page.
  await readyForOffline(page);

  // The pills are in your hand and the network isn't there. The page is already
  // loaded and interactive, so the tap lands and the write queue catches it.
  await page.goto("/medications");
  // The Today panel's own row for this spec's seeded med — one dose, one row, and
  // an exact count this spec may assert because it owns the profile (#868).
  const row = page
    .getByTestId("medications-today")
    .locator("[data-today-row]")
    .filter({ hasText: OFFLINE_SNAPSHOTS_MED });
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
    await settledOfflineRead(page);
    await hydratedClick(page, page.getByTestId("offline-open-dose-schedule"));
    const schedule = page.getByTestId("offline-snapshot-dose-schedule");
    await expect(schedule).toContainText(OFFLINE_SNAPSHOTS_MED);
    await expect(schedule.getByTestId("offline-queued-mark")).toHaveCount(1);
  } finally {
    await context.setOffline(false);
  }

  // Reconnected: navigating remounts the queue provider, whose on-load flush replays
  // the tap. OBSERVE the drain (#3040) — the replayed write is a server fact only
  // once this row renders taken, so wait for that, not for an absence. The old
  // assertion here was a badge count-0 on a fresh navigation, which is equally true
  // before the provider has read its queue — it passed whether or not the replay
  // drained, and the leftover replay it certified cost offline-write-gate's R3d a
  // red on the then-shared profile.
  await page.goto("/medications");
  const takenUndo = row.getByRole("button", { name: "Mark not taken" });
  await expect(takenUndo).toBeVisible({ timeout: 20_000 });
  // Only after the drain is OBSERVED is "no badge" a claim about the queue rather
  // than about a page that has not read it yet.
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);

  // Un-take the dose through the product's own control, so --repeat-each meets the
  // same "Mark taken" row every time. Unconditional on purpose: the drain was just
  // observed, so this is a deterministic undo, not the state-guessing conditional
  // cleanup #3040 rejected. It restores this spec's OWN profile — the only world
  // this spec touches.
  await settledClick(page, takenUndo);
  await expect(row.getByRole("button", { name: "Mark taken" })).toBeVisible({
    timeout: 20_000,
  });

  // Then log out (this context's own session, never the shared one).
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });
});
