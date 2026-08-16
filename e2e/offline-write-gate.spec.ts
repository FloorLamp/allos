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

test("R1 — the OFF SWITCH: nothing re-materialises, even before the server is told", async ({
  page,
}) => {
  test.slow();
  await login(page);
  await page.goto("/");
  await capturedAll(page);

  // Count snapshot GETs from the moment the toggle is flipped. The old failure asked
  // once, was answered `enabled: true` by a server whose Server Action had not landed,
  // and wrote all five kinds back.
  let getsAfterToggle = 0;
  let toggled = false;
  await page.route("**/api/offline-snapshots*", async (route) => {
    if (toggled) getsAfterToggle += 1;
    await route.continue();
  });

  await page.goto("/settings/privacy");
  const toggle = page.getByTestId("offline-snapshots-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();

  toggled = true;
  await toggle.uncheck();

  // The wipe landed. Everything after this is the window the acceptance criterion covers.
  await expect.poll(() => storedKinds(page), { timeout: 15_000 }).toEqual([]);

  // Wake the refresher on a page that is still mounted and still authenticated, with an
  // empty store in front of it — the refresher's own public trigger, not a back door.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(2_000); // waitfortimeout-ok: the assertion IS an absence — nothing may re-materialise in the window the refresher would have written in

  // #2908: "nothing re-materializes until toggled back on".
  expect(await storedKinds(page)).toEqual([]);
  expect(
    getsAfterToggle,
    "the refresher asked the server for snapshots after the switch was turned off"
  ).toBe(0);

  // And it survives a reload, because the close is in the database rather than in a
  // module — the toggle is a promise about the device, not about one document.
  await page.reload();
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
