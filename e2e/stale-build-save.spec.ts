import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { settledFill, spendAutoReloadRation } from "./helpers";
import { workerDbPath } from "./worker-env";
import { UPDATE_TAKEN_MESSAGE } from "@/lib/sw-update";

// Deployment skew, the Server Action half, and the tab that fixes it by itself
// (docs/internals/deploy-skew.md).
//
// A deploy invalidates every Server Action id an open tab holds: the server answers
// each action POST with its not-found marker and the client throws
// UnrecognizedActionError, so EVERY save from that tab fails until it reloads. The
// reported loss was a live workout edited straight through a deploy — auto-saves
// failing quietly, the offline queue declining (online, not a TypeError), and the
// local draft inert in live mode — so the edits existed nowhere at all.
//
// #2471 changed the remedy, not the diagnosis. The tab used to say so and wait for a
// tap; it now converges by itself at the first provably-safe moment, and what must
// hold is:
//
//   * the failed save is a TRIGGER, not a message: the tab flushes the draft, leaves
//     a one-shot pointer, reloads, reopens the editor and applies the draft — with
//     ZERO user taps — and the save then lands on the new build;
//   * that trigger is independent of the `/api/version` detector. The first test
//     never arms the version route at all, which is the #2447 tab whose poll has
//     latched off, and recovery still completes;
//   * a form that can never even ATTEMPT a save still converges, on the detector
//     alone, and is restored without a save being invented on the user's behalf;
//   * a deploy that stays broken degrades to the old banner after ONE automatic
//     attempt, never to a reload loop;
//   * and the never-created session's close-path capture still queues, because the
//     replay route is an ordinary route handler that no deploy re-keys.
//
// The deploy is simulated at the transport: answering action POSTs with Next's own
// `x-nextjs-action-not-found: 1` marker makes the real client throw the real error —
// the exact shape a post-deploy tab produces.
//
// Fixture discipline (#868): every row this spec creates is deleted by value in a
// finally, keyed on titles nothing else uses.

const DB_PATH = workerDbPath();
const LIVE_TITLE = "Stalenet live";
const QUEUED_TITLE = "Stalenet queued";
const UNSAVEABLE_TITLE = "Stalenet unsaveable";
const RATION_TITLE = "Stalenet rationed";
// Debounced draft/auto-save writes, a document load and the quiet window have no
// single UI settle point. Named ceiling per the e2e-hygiene census.
const STALE_SETTLE_MS = 25_000;

// A commit that can never be the running build's, so the detector reads it as a
// deploy. Answered ONCE: the reloaded document must read the sha it was actually
// served with, the way a tab that took a real update does.
const DEPLOYED = { sha: "2471abc", commitMessage: "e2e self reload" };

async function installVersionDeploy(page: Page): Promise<{ arm: () => void }> {
  let armed = false;
  let served = 0;
  await page.route("**/api/version", (route) => {
    if (!armed || served > 0) return route.continue();
    served += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DEPLOYED),
    });
  });
  return {
    arm: () => {
      armed = true;
    },
  };
}

// Answer every server-action POST as a post-deploy server would: the not-found
// marker and no flight payload. Reads and route handlers pass through — a deploy
// does not re-key those.
//
// INSTALLED BEFORE goto, ARMED LATER — both halves load-bearing, for exactly the
// reasons e2e/sw-update.spec.ts records. Installed before navigation because a
// `page.route` registered into a page ALREADY CONTROLLED by a service worker
// sometimes never applies to it, permanently, at ~8-13% per cold-started browser
// (this spec does not block workers, and it arms deep into a long setup, so it sat
// squarely in that window: the route missed, no action POST ever failed, the
// stale-build trigger never fired and the tab correctly did nothing). Armed later
// because the deploy has to land UNDER an editor that is already open, which is the
// scenario.
//
// `untilReload` models the deploy ENDING when the tab takes it: once the main frame
// navigates, the interception stops, so the reloaded document is the new build whose
// action ids work. Pass false for the broken-deploy case, where the point is that
// reloading does not help.
async function installStaleActions(
  page: Page,
  { untilReload = true } = {}
): Promise<{ arm: () => void }> {
  let armed = false;
  // The deploy is over the moment a NEW DOCUMENT loads: that document is the reloaded
  // build, and its action ids work. Keyed on the page's `load` event, which is the
  // only signal that is both precise and reachable here. The two obvious
  // alternatives are each wrong in a way that cost a debugging round:
  // `framenavigated` also fires for the App Router's same-document history rewrites,
  // and a disarm on one of those lets the very save under test succeed; and counting
  // document REQUESTS in the route handler misses entirely, because a navigation
  // fetched by the service worker never reaches `page.route` at all — this spec does
  // not block workers, so the reload's document went unseen, the interception stayed
  // armed across the reload, and the restored edit never saved.
  // `page.goto` resolves ON `load`, so the initial navigation's event lands before
  // `arm()` is ever called and cannot disarm anything prematurely.
  if (untilReload) {
    page.on("load", () => {
      armed = false;
    });
  }
  await page.route("**/*", (route) => {
    const req = route.request();
    if (armed && req.method() === "POST" && req.headers()["next-action"]) {
      return route.fulfill({
        status: 404,
        headers: { "x-nextjs-action-not-found": "1" },
        body: "",
      });
    }
    return route.fallback();
  });
  return {
    arm: () => {
      armed = true;
    },
  };
}

/** Count document loads in the page itself, so "reloaded once" is measurable. */
async function countLoads(page: Page) {
  await page.addInitScript(() => {
    const n = Number(sessionStorage.getItem("staleSpecLoads") ?? "0");
    sessionStorage.setItem("staleSpecLoads", String(n + 1));
  });
}

async function loads(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => sessionStorage.getItem("staleSpecLoads"));
  } catch {
    return null; // mid-navigation: the execution context is being replaced
  }
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

test("a live workout edited through a deploy reloads itself and comes back with the edits, with no taps (#2471)", async ({
  page,
}) => {
  test.slow();
  try {
    await countLoads(page);
    // THE DETECTOR IS NEVER ARMED IN THIS TEST. /api/version answers honestly
    // throughout, so `pending` stays false and trigger B never fires — this is the
    // tab whose poll has latched off (#2447), and the failed save alone has to be
    // enough. That independence is the property, not an accident of the fixture.
    const stale = await installStaleActions(page);
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

    // The deploy lands under the open tab. From here every action POST fails with
    // the stale signature — until the tab reloads, which is when the deploy is over.
    stale.arm();

    // Mid-set edit — the thing that used to vanish, and then the thing that cost
    // four taps to get back.
    await settledFill(page, page.getByTestId("set1-weight"), "123");

    // The tab converges on its own. Nobody tapped anything.
    await expect
      .poll(() => loads(page), {
        timeout: STALE_SETTLE_MS,
        message: "the tab to reload itself after the failed save",
      })
      .toBe("2");

    // …and it comes back where it was: the session reopened from presence through
    // the existing `resumeLive()` path, with the draft applied into it and no banner
    // to tap. A resumed session arrives as `editData`, so #340's create-only live
    // PRESENTATION collapses to the plain editor — that is the pre-existing #451/#921
    // rehydration shape, unchanged here, and what this issue is about is that the
    // edit is back at all.
    await expect(page.getByTestId("activity-form")).toBeVisible({
      timeout: STALE_SETTLE_MS,
    });
    await expect(page.getByTestId("set1-weight")).toHaveValue("123", {
      timeout: STALE_SETTLE_MS,
    });
    await expect(page.getByTestId("draft-restore-banner")).toHaveCount(0);

    // The autosave then does what it always does, on a build that can answer: the
    // draft is dropped the moment the server copy is current.
    await expect
      .poll(() => activityDraftCount(page), {
        timeout: STALE_SETTLE_MS,
        message: "the restored edit to save and clear the draft",
      })
      .toBe(0);

    // Tell-after, not ask-before — and no bar for the build this tab just took.
    await expect(page.getByTestId("toast")).toContainText(
      UPDATE_TAKEN_MESSAGE,
      {
        timeout: STALE_SETTLE_MS,
      }
    );
    await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);
  } finally {
    deleteActivitiesTitled(LIVE_TITLE);
  }
});

test("a form that can never attempt a save still converges, and is restored without one being invented (#2471)", async ({
  page,
}) => {
  test.slow();
  try {
    // THE CASE THAT PROVES THE TRIGGER CANNOT BE SCOPED TO FAILED SAVES. An activity
    // with no exercise is not savable, so no POST is ever attempted and trigger A can
    // never fire for it. The draft is already safe — useFormDraft captures raw field
    // state on its debounce, validity-independent — but convergence needs the reload,
    // and only the detector can ask for it.
    await countLoads(page);
    const deploy = await installVersionDeploy(page);
    await page.goto("/training");
    await page
      .getByRole("main")
      .getByRole("button", { name: "New activity" })
      .click();
    await expect(page.getByTestId("activity-form")).toBeVisible();
    await settledFill(page, page.getByLabel("Activity name"), UNSAVEABLE_TITLE);

    // Only NOW does the deploy land — under an editor that is already open and
    // holding state no save will ever be attempted for. Arming before the editor
    // existed would be testing the clean-tab case with extra steps.
    deploy.arm();
    // …and the detector has to be asked. Its mount read already happened, honestly,
    // and a read that finds no mismatch does not latch — so the next scheduled one is
    // a full interval away. The visibility hook is the app's own "ask again now", and
    // this drives it from inside the page until the document goes away with the
    // reload. It is not input: `visibilitychange` is not in the quiet gate's event
    // set, so this cannot hold the tab awake either.
    await page.evaluate(() => {
      window.setInterval(
        () => document.dispatchEvent(new Event("visibilitychange")),
        500
      );
    });

    await expect
      .poll(() => loads(page), {
        timeout: STALE_SETTLE_MS,
        message: "the tab to reload itself once it went quiet",
      })
      .toBe("2");

    // Restored, incomplete, and NOT saved: restore never forces a write.
    await expect(page.getByTestId("activity-form")).toBeVisible({
      timeout: STALE_SETTLE_MS,
    });
    await expect(page.getByLabel("Activity name")).toHaveValue(
      UNSAVEABLE_TITLE,
      { timeout: STALE_SETTLE_MS }
    );
    await expect(page.getByTestId("draft-restore-banner")).toHaveCount(0);
    expect(activityCount(UNSAVEABLE_TITLE)).toBe(0);

    // Completing the form saves it on the new build, exactly as it would have done
    // if no deploy had happened at all.
    await page.getByPlaceholder(/What did you do/).fill("Running");
    await page
      .getByRole("listbox")
      .getByRole("button", { name: "Running", exact: true })
      .click();
    await settledFill(page, page.getByTestId("cardio-duration"), "30");
    await expect
      .poll(() => activityCount(UNSAVEABLE_TITLE), {
        timeout: STALE_SETTLE_MS,
        message: "the completed activity to save on the new build",
      })
      .toBe(1);
  } finally {
    deleteActivitiesTitled(UNSAVEABLE_TITLE);
  }
});

test("a deploy that stays broken gets ONE automatic attempt and then the banner (#2471)", async ({
  page,
}) => {
  test.slow();
  try {
    await countLoads(page);
    const stale = await installStaleActions(page, { untilReload: false });
    await page.goto("/training");
    // Armed for good: reloading does not fix this one, which is the shape a reload
    // loop would come from.
    stale.arm();

    await page
      .getByRole("main")
      .getByRole("button", { name: "New activity" })
      .click();
    await expect(page.getByTestId("activity-form")).toBeVisible();
    await settledFill(page, page.getByLabel("Activity name"), RATION_TITLE);
    await page.getByPlaceholder(/What did you do/).fill("Running");
    await page
      .getByRole("listbox")
      .getByRole("button", { name: "Running", exact: true })
      .click();
    await settledFill(page, page.getByTestId("cardio-duration"), "30");

    await expect
      .poll(() => loads(page), {
        timeout: STALE_SETTLE_MS,
        message: "the one automatic attempt",
      })
      .toBe("2");

    // The attempt is spent, the tab is still stale, and the honest remedy is handed
    // back to the user — the pre-#2471 affordance, in the one state that reaches it.
    await expect(page.getByTestId("stale-save-banner")).toBeVisible({
      timeout: STALE_SETTLE_MS,
    });
    // …and no second automatic reload behind it.
    expect(await loads(page)).toBe("2");
    expect(activityCount(RATION_TITLE)).toBe(0);
  } finally {
    deleteActivitiesTitled(RATION_TITLE);
  }
});

test("a never-created session closed under a stale build queues its capture, and the replay lands it (#1596)", async ({
  page,
}) => {
  test.slow();
  try {
    // Driven with the automatic attempt already spent: the close-path capture is
    // about what happens when the USER closes a form under a dead build, and #2471
    // leaves that path untouched. Spending the ration is how the tab stays put long
    // enough to exercise it.
    await spendAutoReloadRation(page);
    const stale = await installStaleActions(page, { untilReload: false });
    await page.goto("/training");
    // The deploy lands BEFORE the first save, so the session never gets a
    // server row — the close-path capture's charter, now reachable via the
    // stale signature as well as a dead connection.
    stale.arm();

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

// The healthy-path complement — a live draft never outliving a successful save, and
// the offer banner for a markerless (organic) revisit — stays in
// e2e/form-drafts.spec.ts, deliberately unchanged by this issue: nothing about an
// ordinary reopen is a continuation, so nothing about it may apply a draft without a
// tap.
