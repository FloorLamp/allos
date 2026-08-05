import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledFill } from "./helpers";
import { workerDbPath } from "./worker-env";

// Deployment skew, the Server Action half (docs/internals/deploy-skew.md).
//
// A deploy invalidates every Server Action id an open tab holds: the server
// answers each action POST with its not-found marker and the client throws
// UnrecognizedActionError, so EVERY save from that tab fails until it reloads.
// The reported loss was a live workout edited straight through a deploy —
// auto-saves failing quietly, the offline queue declining (online, not a
// TypeError), and the local draft inert in live mode — so the edits existed
// nowhere at all. What must hold now:
//
//   * the editor SAYS SO instead of a bare error glyph: a banner naming the
//     cause and the remedy, with the reload one tap away;
//   * the local draft (#1699) runs in LIVE mode too, so the failed edits are
//     kept on the device;
//   * after the reload the draft is offered — never silently applied — and
//     resuming restores the edits, which then save cleanly;
//   * a never-created session's close-path capture treats the stale signature
//     like a dead connection (shouldQueueOffline) and queues, because the
//     replay route (/api/offline-replay) is an ordinary route handler that no
//     deploy re-keys.
//
// The deploy is simulated at the transport: answering action POSTs with Next's
// own `x-nextjs-action-not-found: 1` marker makes the real client throw the
// real error — the exact shape a post-deploy tab produces.
//
// Fixture discipline (#868): every row this spec creates is deleted by value in
// a finally, keyed on titles nothing else uses.

const DB_PATH = workerDbPath();
const LIVE_TITLE = "Stalenet live";
const QUEUED_TITLE = "Stalenet queued";
// Debounced draft/auto-save writes plus action round-trips have no single UI
// settle point. Named ceiling per the e2e-hygiene census.
const STALE_SETTLE_MS = 20_000;

// Answer every server-action POST as a post-deploy server would: the not-found
// marker and no flight payload. Reads and route handlers pass through — a
// deploy does not re-key those.
async function armStaleActions(page: Page) {
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"]) {
      return route.fulfill({
        status: 404,
        headers: { "x-nextjs-action-not-found": "1" },
        body: "",
      });
    }
    return route.fallback();
  });
}

type DraftRow = { key: string };

async function activityDraftCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open("allos-offline");
        req.onerror = () => resolve(0);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("drafts")) {
            db.close();
            resolve(0);
            return;
          }
          const all = db
            .transaction("drafts", "readonly")
            .objectStore("drafts")
            .getAll();
          all.onerror = () => {
            db.close();
            resolve(0);
          };
          all.onsuccess = () => {
            const rows = (all.result ?? []) as DraftRow[];
            db.close();
            resolve(
              rows.filter((r) => String(r.key).includes(":activity:")).length
            );
          };
        };
      })
  );
}

function deleteActivitiesTitled(...titles: string[]) {
  const h = new Database(DB_PATH);
  try {
    for (const title of titles) {
      h.prepare("DELETE FROM activities WHERE title = ?").run(title);
    }
  } finally {
    h.close();
  }
}

function activityCount(title: string): number {
  const h = new Database(DB_PATH);
  try {
    return (
      h
        .prepare("SELECT COUNT(*) AS n FROM activities WHERE title = ?")
        .get(title) as { n: number }
    ).n;
  } finally {
    h.close();
  }
}

test("a live workout edited through a deploy keeps its edits on the device, and the banner's reload path restores them (#1699/#451)", async ({
  page,
}) => {
  test.slow();
  try {
    // A live session with one logged set, saved while the build is still good —
    // the state the user is in when the deploy lands.
    await page.goto("/training");
    await page.getByRole("main").getByTestId("start-workout").click();
    await expect(page.getByTestId("live-workout-panel")).toBeVisible();
    await settledFill(page, page.getByLabel("Activity name"), LIVE_TITLE);
    await page.getByPlaceholder(/What did you do/).fill("Barbell Bench Press");
    await page
      .getByRole("listbox")
      .getByRole("button")
      .filter({ hasText: "Barbell Bench Press" })
      .first() // first-ok: transient combobox list this spec just opened by typing
      .click();
    await page
      .getByTestId("next-set-card")
      .getByRole("button", { name: "Use" })
      .click();
    await expect(page.getByTestId("set1-weight")).toHaveValue(/^\d/);
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeVisible({ timeout: STALE_SETTLE_MS });

    // The deploy lands under the open tab. From here every action POST fails
    // with the stale signature.
    await armStaleActions(page);

    // Mid-set edit — the thing that used to vanish.
    await settledFill(page, page.getByTestId("set1-weight"), "123");

    // The failed save is a STATE, not a glyph: the banner names the cause and
    // the remedy…
    const banner = page.getByTestId("stale-save-banner");
    await expect(banner).toBeVisible({ timeout: STALE_SETTLE_MS });
    await expect(banner).toContainText("kept on this device");

    // …and the promise it makes is true: the draft holds the edit, in LIVE
    // mode, where it used to be inert.
    await expect
      .poll(() => activityDraftCount(page), {
        timeout: STALE_SETTLE_MS,
        message: "the failed edit to reach the on-device draft",
      })
      .toBe(1);

    // The reload the banner offers. The deploy is over from here on — the
    // reloaded page is the new build, whose action ids work.
    await page.unroute("**/*");
    await page.getByTestId("stale-save-reload").click();

    // The live session survives on the server (its pre-deploy content), so the
    // training page offers it back inline (the dock is suppressed on /training);
    // the draft is OFFERED on top, never silently applied. hydratedClick: this
    // follows the reload, and a bare click swallowed pre-hydration would leave
    // the editor closed (the #1556 class).
    await hydratedClick(
      page,
      page.getByRole("button", { name: "Resume workout" })
    );
    const offer = page.getByTestId("draft-restore-banner");
    await expect(offer).toBeVisible({ timeout: STALE_SETTLE_MS });
    await offer.getByTestId("draft-restore-resume").click();
    await expect(page.getByTestId("set1-weight")).toHaveValue("123");

    // With the build fresh, the restored edit saves — and the draft is dropped
    // the moment the server copy is current, so nothing re-offers it later.
    await expect
      .poll(() => activityDraftCount(page), {
        timeout: STALE_SETTLE_MS,
        message: "the restored edit to save and clear the draft",
      })
      .toBe(0);
  } finally {
    deleteActivitiesTitled(LIVE_TITLE);
  }
});

test("a never-created session closed under a stale build queues its capture, and the replay lands it (#1596)", async ({
  page,
}) => {
  test.slow();
  try {
    await page.goto("/training");
    // The deploy lands BEFORE the first save, so the session never gets a
    // server row — the close-path capture's charter, now reachable via the
    // stale signature as well as a dead connection.
    await armStaleActions(page);

    await page
      .getByRole("main")
      .getByRole("button", { name: "New activity" })
      .click();
    await expect(page.getByTestId("activity-form")).toBeVisible();
    await settledFill(page, page.getByLabel("Activity name"), QUEUED_TITLE);
    await page.getByPlaceholder(/What did you do/).fill("Running");
    await page
      .getByRole("listbox")
      .getByRole("button", { name: "Running", exact: true })
      .click();
    await settledFill(page, page.getByTestId("cardio-duration"), "30");

    // The savable form's auto-save is failing — the banner says why here too.
    await expect(page.getByTestId("stale-save-banner")).toBeVisible({
      timeout: STALE_SETTLE_MS,
    });

    // Closing runs the bounded flush; its stale failure captures the whole
    // session into the offline queue instead of stranding it.
    await page.keyboard.press("Escape");
    await expect(
      page.getByTestId("toast").filter({ hasText: "saved offline" })
    ).toBeVisible({ timeout: STALE_SETTLE_MS });

    // The replay route is not build-keyed, so once the interception is gone the
    // queued session lands — the flush fires on load, and the Background Sync
    // path may even have delivered it already.
    await page.unroute("**/*");
    await page.reload();
    await expect
      .poll(() => activityCount(QUEUED_TITLE), {
        timeout: STALE_SETTLE_MS,
        message: "the queued session to replay into the database",
      })
      .toBe(1);
  } finally {
    deleteActivitiesTitled(QUEUED_TITLE);
  }
});
