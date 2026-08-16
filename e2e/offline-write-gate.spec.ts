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
// Four leaks, all measured on this branch before the gate existed, all of the same
// shape — a guard that was true of its own function and false of the system:
//   R1  the OFF SWITCH re-materialised all five kinds from a server not yet told;
//   R2  a SECOND TAB wrote everything back into the store logout had just cleared;
//   R3d a queue flush in flight re-wrote its retry entries after the wipe;
//   R3e a form draft's 600ms debounce landed a half-typed record after the wipe.
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

async function capturedAll(page: Page): Promise<void> {
  await expect
    .poll(() => storedKinds(page), { timeout: 30_000 })
    .toEqual([...SNAPSHOT_KINDS].sort());
}

/** Hold every logout Server Action open, so the authenticated window is a real interval. */
async function holdLogoutPost(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((r) => setTimeout(r, LOGOUT_POST_LATENCY_MS));
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
  try {
    await row.getByRole("button", { name: "Mark taken" }).click();
    await expect(page.getByTestId("offline-queue-badge")).toHaveText(
      /1 queued offline/
    );
  } finally {
    await context.setOffline(false);
  }
  expect((await storedRows(page, "intents")).length).toBe(1);

  // Hold the replay POST open so a flush is genuinely in flight, and the logout POST too.
  // `putIntents(plan.retry)` and `saveRejected` both run after that round trip resolves,
  // which is after the wipe — `attempts: 0 -> 1` in the store is what proved it a
  // re-write rather than a wipe that missed.
  await page.route("**/*", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((r) => setTimeout(r, LOGOUT_POST_LATENCY_MS));
    }
    await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await page.waitForTimeout(3_000); // waitfortimeout-ok: absence — outlasts the held replay round trip, after which the re-write used to land

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
