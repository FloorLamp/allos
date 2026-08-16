import { test, expect } from "./fixtures";
import { type Page, type BrowserContext } from "@playwright/test";
import { hydratedClick } from "./helpers";
import { SNAPSHOT_KINDS } from "@/lib/offline/snapshots";

// THE DEVICE WRITE GATE, end to end, against a real IndexedDB (#2908).
//
// This spec exists because the unit tier CANNOT hold these assertions. There is no
// `indexedDB` in the pure suite, so a writer there returns "did not write" for every
// input and every such assertion passes against any implementation — which is exactly
// how two mutants of the reviewed claims shipped green. Whether a write LANDS is
// observable in one place only: a browser with the real database in it. So the pure tier
// keeps `gateAllows` (lib/__tests__/offline-write-gate.test.ts) and everything below is
// here.
//
// Leaks measured on this branch before the gate existed, all of the same shape — a guard
// that was true of its own function and false of the system:
//   R1   the OFF SWITCH re-materialised all five kinds from a server not yet told;
//   R2   a SECOND TAB wrote everything back into the store logout had just cleared;
//   R2b  the same, with the race removed: a tab that LOADS inside the logout window;
//   R2c  and the other direction — the next login must get the feature back;
//   R3d  a queue flush in flight re-wrote its retry entries after the wipe;
//   R3e  a form draft's 600ms debounce landed a half-typed record after the wipe.
// And the two findings from the round after that, which are the same sentence read the
// other way round — a close that outlives the thing it was closing against:
//   R-A  a logout that FAILED left the whole device-local perimeter shut, permanently;
//   R-B  the off switch was a one-way latch, so a profile turned back on elsewhere never
//        came back on this device;
//   R-C  a stale second tab erased the switched-to profile's snapshots.
//
// WHICH HALF OF THE GATE A TEST ACTUALLY OBSERVES, because the titles have been wrong
// about this before. There are two: `snapshotWritesClosed()`, asked BEFORE the fetch so a
// closed device does not even make the request, and `gateAllows` inside the write's own
// transaction. R1 and offline-snapshots.spec.ts's post-wipe-refresh test are satisfied by
// the FIRST — they are real tests of a real guard, and both are titled for it. The
// in-transaction half is what offline-snapshots.spec.ts:290, R3d and R3e observe, and
// they are the ones that go red when `gateAllows` is mutated to `return true`.
//
// MOVING A TEST TO THIS TIER IS NOT THE SAME AS MAKING IT MEASURE SOMETHING, and both
// tests added here since have been caught not measuring. Mutation testing is the only
// thing that found either, so it is the standard for anything added below:
//
//   • R2 passed 12/12 locally against an `openSessionAs` that re-opened the gate
//     unconditionally — the exact shipped defect — and failed 2 of 3 on a loaded CI
//     runner. It is a race, not a property. R2b is the same finding with the race taken
//     out, and it fails 2/2 against that mutant.
//   • R3d asserted an empty intents store after a logout that had already navigated to
//     /login, taking the flush continuation with it. The store was empty because the
//     writer had been destroyed. It passed against `gateAllows` mutated to `return true`.
//     It now intercepts the replay before the network returns, answers `error` so there
//     IS a write-back, keeps the page alive for it, and counts the replayed keys — and
//     against that mutant it fails with `attempts: 1`, which is the review's own
//     signature for a re-write rather than a wipe that missed.
//   • R-A, R-B and R-C were each run against a restoration of the exact defect they
//     describe, and each failed on the assertion that measures the CONSEQUENCE rather
//     than only on the one that reads the gate — checked by removing the gate assertion
//     and running the mutant again. R-A: no queue badge and no intent after a failed
//     logout. R-B: `capturedAll` never resolves after the other device turns it back on.
//     R-C: `SNAPSHOTS AFTER: []`.
//
// So: an absence proves nothing without a control showing the presence was possible.
// Every test below that asserts "nothing was written" says how it knows something would
// have been.
//
// It runs in its own unauthenticated context and logs in by hand, because it exercises
// LOGOUT — which destroys the session row server-side and would invalidate the shared
// cookie every other spec relies on.
test.use({ storageState: { cookies: [], origins: [] } });

const DB = "allos-offline";

// Holding the logout POST open is not a contrivance: it is how long a real logout takes,
// and the page stays mounted, authenticated and interactive for all of it. That window
// is where every one of these leaks lived.
const LOGOUT_POST_LATENCY_MS = 6_000;

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "e2e-admin-pass");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
}

// Read a store's keys straight out of IndexedDB. MUST NOT CREATE THE DATABASE:
// `indexedDB.open(name)` with no version creates it at version 1 when absent, and a v1
// connection blocks the app's own upgrade — which is a hang, not an error. `databases()`
// asks without opening.
function storedRows(page: Page, storeName: string): Promise<unknown[]> {
  return page.evaluate(
    ([dbName, store]) =>
      (async () => {
        const known = await indexedDB.databases();
        if (!known.some((d) => d.name === dbName)) return [];
        return new Promise<unknown[]>((resolve) => {
          const req = indexedDB.open(dbName);
          req.onerror = () => resolve([]);
          req.onblocked = () => resolve([]);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(store)) {
              db.close();
              resolve([]);
              return;
            }
            const all = db
              .transaction(store, "readonly")
              .objectStore(store)
              .getAll();
            all.onerror = () => {
              db.close();
              resolve([]);
            };
            all.onsuccess = () => {
              const rows = all.result as unknown[];
              db.close();
              resolve(rows);
            };
          };
        });
      })(),
    [DB, storeName] as const
  );
}

async function storedKinds(page: Page): Promise<string[]> {
  const rows = (await storedRows(page, "snapshots")) as { kind: string }[];
  return rows.map((r) => r.kind).sort();
}

/** The write gate itself, as it stands in the database. `null` before anything wrote it. */
async function gateRow(page: Page): Promise<Record<string, unknown> | null> {
  const rows = (await storedRows(page, "meta")) as Record<string, unknown>[];
  return rows.find((r) => r.key === "device-writes") ?? null;
}

/**
 * Re-stamp every stored snapshot onto another profile — the state a document is in when
 * the profile was switched somewhere it cannot see. Written raw rather than through the
 * app, because the app has no way to produce it on purpose; the rows are otherwise
 * untouched, so they still parse.
 */
async function restampSnapshots(page: Page, profileId: number): Promise<void> {
  await page.evaluate(
    ([dbName, pid]) =>
      new Promise<void>((resolve) => {
        const req = indexedDB.open(dbName as string);
        req.onerror = () => resolve();
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("snapshots", "readwrite");
          const store = tx.objectStore("snapshots");
          const all = store.getAll();
          all.onsuccess = () => {
            for (const row of all.result as { profileId: number }[]) {
              store.put({ ...row, profileId: pid as number });
            }
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            resolve();
          };
        };
      }),
    [DB, profileId] as const
  );
}

async function capturedAll(
  page: Page,
  timeout: number = 30_000
): Promise<void> {
  await expect
    .poll(() => storedKinds(page), { timeout })
    .toEqual([...SNAPSHOT_KINDS].sort());
}

/** Hold every logout Server Action open, so the authenticated window is a real interval. */
async function holdLogoutPost(
  page: Page,
  ms: number = LOGOUT_POST_LATENCY_MS
): Promise<void> {
  await page.route("**/*", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((r) => setTimeout(r, ms));
    }
    await route.continue();
  });
}

test("R1 — the OFF SWITCH stops the REQUEST, so nothing re-materialises before the server is told", async ({
  page,
}) => {
  test.slow();
  await login(page);
  await page.goto("/");
  await capturedAll(page);

  await page.goto("/settings/privacy");
  const toggle = page.getByTestId("offline-snapshots-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();

  // THE WINDOW THIS TEST IS ABOUT is the Server Action's flight, so hold it open and make
  // it an interval rather than an instant. Until it lands the server still answers
  // `enabled: true`, and the old failure asked once inside exactly here, was told yes, and
  // wrote all five kinds back.
  const ACTION_HOLD_MS = 8_000;
  await page.route("**/*", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((r) => setTimeout(r, ACTION_HOLD_MS));
    }
    await route.continue();
  });
  // Registered AFTER the catch-all so it wins — Playwright matches most-recent first.
  let getsDuringFlight = 0;
  let toggled = false;
  await page.route("**/api/offline-snapshots*", async (route) => {
    if (toggled) getsDuringFlight += 1;
    await route.continue();
  });

  toggled = true;
  await toggle.uncheck();

  // The wipe landed and the action is still in flight. Everything until it settles is the
  // window the acceptance criterion covers.
  await expect.poll(() => storedKinds(page), { timeout: 15_000 }).toEqual([]);

  // Wake the refresher on a page that is still mounted and still authenticated, with an
  // empty store in front of it — the refresher's own public trigger, not a back door.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(2_000); // waitfortimeout-ok: the assertion IS an absence — nothing may re-materialise in the window the refresher would have written in

  // #2908: "nothing re-materializes until toggled back on".
  expect(await storedKinds(page)).toEqual([]);
  expect(
    getsDuringFlight,
    "the refresher asked a server that had not been told yet"
  ).toBe(0);

  // NOW LET THE SERVER BE TOLD, and the device-local close is done: it covered one window
  // and must not outlive it (R-B — persisted with no path back, it became a one-way latch
  // that no other device could ever undo). From here the SERVER is the off switch, and it
  // is asked on every refresh, so the store staying empty is its answer rather than this
  // device declining to ask.
  await expect(page.getByLabel("Saved")).toBeVisible({ timeout: 20_000 });
  await page.unroute("**/*");
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(3_000); // waitfortimeout-ok: absence again, across a fresh mount whose own refresh would be the writer
  expect(await storedKinds(page)).toEqual([]);

  // Turning it back ON re-opens the lane — asserted, not just tidied up, because a
  // close that could not be undone would be its own defect. The refresher needs a
  // trigger (the toggle is not a navigation), so use its own `online` one.
  await page.getByTestId("offline-snapshots-toggle").check();
  await expect(page.getByLabel("Saved")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await capturedAll(page);
});

test("R2 — a SECOND TAB does not write everything back after the first logs out", async ({
  page,
  context,
}: {
  page: Page;
  context: BrowserContext;
}) => {
  test.slow();
  await login(page);
  await page.goto("/");
  await capturedAll(page);

  // Tab B: same context, same cookies, same IndexedDB — and, before the gate was
  // persisted, its own module state saying "nothing has been closed here".
  const tabB = await context.newPage();
  await tabB.goto("/");
  await capturedAll(tabB);

  let tabBGetsAfterLogout = 0;
  let loggedOut = false;
  await tabB.route("**/api/offline-snapshots*", async (route) => {
    if (loggedOut) tabBGetsAfterLogout += 1;
    await route.continue();
  });

  await holdLogoutPost(page);
  loggedOut = true;
  await page.getByRole("button", { name: "Log out" }).click();

  // Wait for tab A's wipe to land, observed from tab B — one database, two documents.
  await expect.poll(() => storedKinds(tabB), { timeout: 15_000 }).toEqual([]);

  // Tab B is still mounted, still believes it is authenticated, and the session is still
  // alive because the POST has not landed. This is the whole finding.
  await tabB.evaluate(() => window.dispatchEvent(new Event("online")));
  await tabB.bringToFront();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await tabB.waitForTimeout(2_000); // waitfortimeout-ok: absence — tab B must write nothing in the window its refresh would have used

  expect(await storedKinds(tabB)).toEqual([]);
  expect(
    tabBGetsAfterLogout,
    "the second tab asked the server for snapshots after the first logged out"
  ).toBe(0);
  await tabB.close();
});

test("R2b — a tab that LOADS inside the logout window does not re-open the gate", async ({
  page,
  context,
}: {
  page: Page;
  context: BrowserContext;
}) => {
  test.slow();

  // THE SAME FINDING AS R2, WITH THE RACE TAKEN OUT, and it is here because R2 alone did
  // not hold the property. R2 failed on CI against the very fix written for it: the gate
  // was re-opened by `updateGate(openSession)` on MOUNT, and tab B — mounted before the
  // logout, still mounted after it — ran that effect whenever the loaded runner got
  // round to scheduling it. Whether tab B won or lost was a timing coin flip, which is
  // why R2 passed locally 12/12 and failed 2 of 3 repeats on CI.
  //
  // A tab that OPENS during the logout window needs no coin flip at all. The session
  // outlives the logout POST, so this document is served, authenticated, by a live
  // session — the one that is in the middle of ending. "A document mounted" is true of
  // it; "a new session began" is not, and only the second may re-open the gate.
  const LONG_HOLD_MS = 20_000;

  await login(page);
  await page.goto("/");
  await capturedAll(page);

  await holdLogoutPost(page, LONG_HOLD_MS);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect.poll(() => storedKinds(page), { timeout: 15_000 }).toEqual([]);

  // Opened after the wipe, while the session is still alive.
  const late = await context.newPage();
  let lateGets = 0;
  await late.route("**/api/offline-snapshots*", async (route) => {
    lateGets += 1;
    await route.continue();
  });
  await late.goto("/");

  // NON-VACUITY CONTROL, and the assertions below mean nothing without it: this tab must
  // really have been served the authenticated app. If the session had already ended it
  // would sit on /login, never mount the refresher, and write nothing for a reason that
  // has nothing to do with the gate.
  await expect(late.getByRole("button", { name: "Log out" })).toBeVisible({
    timeout: 20_000,
  });

  // Longer than the refresher's own initial delay, so this is the window it would have
  // used rather than a window that never arrived.
  await late.waitForTimeout(4_000); // waitfortimeout-ok: absence — the refresh window must pass with nothing written

  expect(await storedKinds(late)).toEqual([]);
  expect(
    lateGets,
    "a tab opened inside the logout window asked the server for snapshots"
  ).toBe(0);
  await late.close();
});

test("R2c — the NEXT person to sign in on the device gets the feature back", async ({
  page,
}: {
  page: Page;
}) => {
  test.slow();

  // The other half of R2b, and the reason the fix is an identity rather than "once
  // closed, stay closed". A close that no login could undo would be a silent, permanent
  // death of offline reads on any device anyone had ever logged out of — a worse bug than
  // the one being fixed, and invisible until someone reached a dead zone and found
  // nothing there.
  // Two full logins and two full captures in one test, so both polls get a wider budget
  // than the file's default — a capture that is merely SLOW here would read as the
  // stuck-closed gate this test exists to detect, which is the wrong alarm to make loud.
  const CAPTURE_TIMEOUT_MS = 60_000;

  await login(page);
  await page.goto("/");
  await capturedAll(page, CAPTURE_TIMEOUT_MS);

  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await expect.poll(() => storedKinds(page), { timeout: 15_000 }).toEqual([]);

  // A different session on the same device, same IndexedDB, gate still closed for the
  // previous one.
  await login(page);
  await page.goto("/");
  await capturedAll(page, CAPTURE_TIMEOUT_MS);
});

test("R3d — a queue flush in flight does not re-write its intents after logout", async ({
  page,
  context,
}) => {
  test.slow();
  await login(page);
  await page.goto("/medications");

  // Capture a dose offline, so there is a real intent with real PHI in the queue.
  const row = page
    .getByTestId("medications-today")
    .locator("[data-today-row]")
    .filter({ hasText: "Sertraline" });
  await expect(row).toHaveCount(1);
  await context.setOffline(true);
  await row.getByRole("button", { name: "Mark taken" }).click();
  await expect(page.getByTestId("offline-queue-badge")).toHaveText(
    /1 queued offline/
  );
  expect((await storedRows(page, "intents")).length).toBe(1);

  // THE RE-WRITE HAS TO HAPPEN SOMEWHERE THE DOCUMENT IS STILL ALIVE, and getting that
  // wrong is how the first version of this test came to assert nothing at all. It went
  // back online first — so the browser's own `online` event flushed the queue against the
  // real server, which replayed it successfully and deleted the row — then held both
  // POSTs for the same 6s and waited for `/login`. By then there was no queue left to
  // flush, no write-back to refuse, and the page had navigated away from the writer
  // anyway. It passed with `gateAllows` mutated to `return true`, which is the definition
  // of measuring nothing. The control at the bottom is what would have caught that, so it
  // is now part of the test.
  //
  // Three things had to change. The replay is intercepted BEFORE the network comes back,
  // so the first flush is the one under control. It answers `error`, which is the branch
  // that calls `putIntents` — a successful replay DELETES the row and there is nothing to
  // refuse. And the logout POST is held far longer than the replay, so the wipe lands
  // first and the write-back then runs on a page still mounted, still authenticated and
  // still on /medications.
  const REPLAY_HOLD_MS = 8_000;
  const LOGOUT_HOLD_MS = 30_000;

  await page.route("**/*", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((r) => setTimeout(r, LOGOUT_HOLD_MS));
    }
    await route.continue();
  });

  // Registered AFTER the catch-all so it wins — Playwright matches most-recent first.
  let replayedKeys = 0;
  await page.route("**/api/offline-replay*", async (route) => {
    const body = route.request().postDataJSON() as {
      intents?: { key: string }[];
    };
    const results = (body.intents ?? []).map((i) => ({
      key: i.key,
      status: "error",
    }));
    replayedKeys += results.length;
    await new Promise((r) => setTimeout(r, REPLAY_HOLD_MS));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results }),
    });
  });

  await context.setOffline(false);
  // Log out only once the flush is genuinely in flight — the window the finding is about
  // is the one between the request going out and its answer coming back.
  await expect.poll(() => replayedKeys, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Log out" }).click();

  // The wipe landed, and the logout POST is still being held — so everything below runs
  // inside the authenticated window.
  await expect
    .poll(() => storedRows(page, "intents"), { timeout: 15_000 })
    .toEqual([]);

  // Outlast the held replay, whose resolution is where `putIntents(plan.retry)` runs.
  await page.waitForTimeout(REPLAY_HOLD_MS + 3_000); // waitfortimeout-ok: absence — the re-write lands here or not at all

  // NON-VACUITY CONTROL. Everything below is an absence, and an absence is only evidence
  // if the thing that would have caused a presence actually happened. A flush that never
  // reached the server has no write-back to refuse, and the two assertions after this
  // would then pass against any implementation — which is the exact failure mode this
  // whole file was rewritten to escape.
  expect(
    replayedKeys,
    "the flush never reached the server, so no write-back could have been refused"
  ).toBeGreaterThan(0);

  expect(await storedRows(page, "intents")).toEqual([]);
  expect(await storedRows(page, "rejected")).toEqual([]);
});

test("R3e — a draft's autosave debounce does not land a half-typed record after logout", async ({
  page,
}) => {
  test.slow();
  await login(page);
  await page.goto("/training?tab=log");

  // Open the inline activity form and type. `useFormDraft` debounces by 600ms, so the
  // write is still pending when the next line runs.
  // hydratedClick, not a bare click: this runs straight after a goto and the button
  // opens a form rather than following a link, so a click inside the hydration window is
  // swallowed invisibly (e2e/form-drafts.spec.ts states the same reason at length).
  await hydratedClick(
    page,
    page.getByRole("main").getByRole("button", { name: "New activity" })
  );
  await expect(page.getByTestId("activity-form")).toBeVisible();
  await page
    .getByPlaceholder(/What did you do/)
    .fill("Gate probe: half-typed workout");

  await holdLogoutPost(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  // Outlast the debounce several times over: this asserts an ABSENCE, and an empty store
  // read before the write would have landed proves nothing.
  await page.waitForTimeout(4_000); // waitfortimeout-ok: absence — several times the 600ms autosave debounce that used to land the draft

  // lib/offline/draft-db.ts's own contract: "the next login must never be offered the
  // previous one's half-typed workout."
  expect(await storedRows(page, "drafts")).toEqual([]);
});

test("R-A — a logout that FAILS leaves the device able to save again", async ({
  page,
  context,
}: {
  page: Page;
  context: BrowserContext;
}) => {
  test.slow();

  // THE CLOSE IS MADE BEFORE THE LOGOUT IS SENT, which is what makes every window above
  // safe — and what made this one fatal. SidebarContent wipes and closes, then submits.
  // When that POST never lands the session is still alive and the gate is closed for it,
  // and every rule in this file says only a DIFFERENT session may re-open. Nothing
  // changes `sessionKey` short of a successful logout and a new login, so the whole
  // device-local perimeter stayed shut — including the shipped #28 write queue, which
  // went on toasting "saved offline — will sync when you reconnect" over a queue that
  // captured nothing.
  //
  // Pressing Log out with no signal is this app's own subject matter, and a 5xx during a
  // deploy does the same. The person is then shown the error boundary, which invites them
  // to carry on in the very session that is now shut: "Something went wrong … Reload the
  // app".
  await login(page);
  await page.goto("/medications");
  const row = page
    .getByTestId("medications-today")
    .locator("[data-today-row]")
    .filter({ hasText: "Sertraline" });
  await expect(row).toHaveCount(1);

  // Kill the logout POST outright. Not a contrivance — this is what a tap on Log out in a
  // dead zone does, and the failure the error boundary is for.
  await page.route("**/*", async (route) => {
    if (route.request().method() === "POST") {
      await route.abort("internetdisconnected");
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Log out" }).click();

  // The close landed and was then undone by the closer, because its own logout failed.
  await expect
    .poll(() => gateRow(page), { timeout: 20_000 })
    .toMatchObject({ sessionClosed: false });

  await page.unroute("**/*");
  await page.reload();

  // NON-VACUITY CONTROL, and it is the whole reason this test means anything: the session
  // must really have survived. If the logout had actually landed this page would sit on
  // /login, there would be no dose to tap, and "the queue still works" would be a
  // statement about a page that never existed.
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible({
    timeout: 20_000,
  });

  // And the shipped feature still works. Measured on the PR head before this fix: `[]`
  // intents and the "saved offline" toast anyway; on origin/main, one intent.
  await context.setOffline(true);
  await page
    .getByTestId("medications-today")
    .locator("[data-today-row]")
    .filter({ hasText: "Sertraline" })
    .getByRole("button", { name: "Mark taken" })
    .click();
  await expect(page.getByTestId("offline-queue-badge")).toHaveText(
    /1 queued offline/
  );
  expect((await storedRows(page, "intents")).length).toBe(1);
  await context.setOffline(false);
});

test("R-B — the OFF SWITCH is not a latch: a profile turned back on elsewhere comes back", async ({
  page,
  browser,
}) => {
  test.slow();

  // `snapshotsClosed` is persisted, and the only thing that used to clear it was THIS
  // device's own toggle being ticked ON again. The refresher asks the gate before it asks
  // the server, so a closed device could never hear `enabled: true` from a profile turned
  // back on anywhere else — and the checkbox is server-driven, so it rendered ON above an
  // empty store, permanently and silently. R1 above pins the window the close is FOR;
  // this pins the window it must not outlive.
  //
  // Two contexts, because "another device" is the case: same account, same server,
  // separate storage.
  await login(page);
  await page.goto("/");
  await capturedAll(page);

  await page.goto("/settings/privacy");
  const toggle = page.getByTestId("offline-snapshots-toggle");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(page.getByLabel("Saved")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => storedKinds(page), { timeout: 15_000 }).toEqual([]);

  // The latch is released once the server has been told, and the server is the off switch
  // from here on. Asserted directly, because the behaviour below depends on it and a
  // still-closed lane would fail this test for a reason worth naming separately.
  await expect
    .poll(() => gateRow(page), { timeout: 15_000 })
    .toMatchObject({ snapshotsClosed: false });

  // Still off, though — the SERVER says so now, and it is asked on every refresh.
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(3_000); // waitfortimeout-ok: absence — the server's own `enabled: false` must keep the store empty with no help from a device-local latch
  expect(await storedKinds(page)).toEqual([]);

  // THE OTHER DEVICE turns it back on.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await login(otherPage);
  await otherPage.goto("/settings/privacy");
  await otherPage.getByTestId("offline-snapshots-toggle").check();
  await expect(otherPage.getByLabel("Saved")).toBeVisible({ timeout: 20_000 });
  await other.close();

  // This device's next authenticated visit hears it. Before the fix this poll never
  // resolved: the pre-fetch check bailed on the device's own latch and the server was
  // never asked again.
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await capturedAll(page, 60_000);

  // And the checkbox and the device agree, which is the user-visible half of the finding.
  await page.goto("/settings/privacy");
  await expect(page.getByTestId("offline-snapshots-toggle")).toBeChecked();
});

test("R-C — a STALE second tab does not erase the switched-to profile's snapshots", async ({
  page,
  context,
}: {
  page: Page;
  context: BrowserContext;
}) => {
  test.slow();

  // The foreign-profile wipe used to be judged against the COMPONENT'S OWN
  // `activeProfileId`, before the fetch. A second tab does not re-render when the profile
  // is switched in the first one, so its props stay on the old profile — and it wiped the
  // switched-to profile's payloads and started a wipe/re-capture loop between the tabs.
  //
  // SYNTHETIC, AND SAYING SO. A real switch would mutate session state this suite shares,
  // so the stale tab is built rather than produced: the store is seeded with a payload
  // belonging to another profile, and the server is made to answer with that profile —
  // which is exactly the state a stale tab is in, a document whose own `activeProfileId`
  // is not what the server says is active. What it measures is the decision under review:
  // WHOSE answer the wipe is judged against.
  await login(page);
  await page.goto("/");
  await capturedAll(page);

  const FOREIGN_PROFILE = 4242;
  await restampSnapshots(page, FOREIGN_PROFILE);

  let gets = 0;
  await page.route("**/api/offline-snapshots*", async (route) => {
    gets += 1;
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    // The server's answer, with the profile a stale document is out of step with.
    await route.fulfill({
      status: res.status(),
      contentType: "application/json",
      body: JSON.stringify({ ...body, profileId: FOREIGN_PROFILE }),
    });
  });

  await page.goto("/medications");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  // NON-VACUITY CONTROL: the refresh must actually have run, or "nothing was wiped" is a
  // statement about a refresher that never woke up.
  await expect.poll(() => gets, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2_000); // waitfortimeout-ok: the wipe under review lands here or not at all

  const kinds = await storedKinds(page);
  expect(
    kinds,
    "a document out of step with the server erased the store anyway"
  ).toContain("medication-list");
});
