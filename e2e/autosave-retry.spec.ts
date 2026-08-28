import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// The swap window's save failures recover BY THEMSELVES (#2866). A mid-deploy
// action POST doesn't reach a live Next server: behind a proxy the tab gets a
// 502 error page (the client throws Next's non-RSC-response error, stamped
// __NEXT_ERROR_CODE), and before this fix that shape missed every belt — not
// the stale signature (no trigger A), not queueable (online, not a TypeError),
// not retried (a failed persist re-attempted only on the next KEYSTROKE) — so
// a red triangle narrated the rest of the workout while the draft silently
// held everything.
//
// The contract under test: while the window lasts, the form says the true
// sentence ("Not saving right now — your entries are kept on this device");
// when the window ends, the bounded backoff lands the save with ZERO user
// interaction and no entry lost.

// Answer action POSTs the way a reverse proxy answers during a container swap:
// 502 with a text/plain body — a non-RSC response, NOT the stale-action marker.
// text/plain is deliberately the HARDER shape: Next uses the raw body ("Bad
// Gateway") as the thrown error's message, so no message signature can match
// and only the stamped __NEXT_ERROR_CODE identifies it as retriable.
async function armSwapWindow(page: Page) {
  let armed = false;
  await page.route("**/*", (route) => {
    const req = route.request();
    if (armed && req.method() === "POST" && req.headers()["next-action"]) {
      return route.fulfill({
        status: 502,
        contentType: "text/plain",
        body: "Bad Gateway",
      });
    }
    return route.fallback();
  });
  return {
    arm: () => {
      armed = true;
    },
    end: () => {
      armed = false;
    },
  };
}

// The saved row is the POINT of this test, so it cannot be avoided — but it must
// not outlive it. It lands on the shared profile dated TODAY, and Analyze's quick
// links give each kind exactly one slot, filled by that kind's most recent item
// (lib/analyze-view.ts, analyzeQuickLinks) — so a stranded Running pushes the
// seeded Cycling out of the strip for every later test in the same worker. That is
// what made ride-detail.spec.ts's Cycling quick link a ~50% flake on e2e-main (3):
// whether the two tests shared a worker was a per-run coin flip (#3930). Every
// other spec that saves an activity on profile 1 already deletes it — this one
// didn't. Swept in afterEach so a mid-test failure strands nothing either.
const SURVIVOR_TITLE = "Swap window survivor";

test.afterEach(() => {
  const db = new Database(workerDbPath());
  try {
    // Child rows (components, routes, videos) cascade off the activity — the same
    // one-statement cleanup the other activity-owning specs use.
    db.prepare("DELETE FROM activities WHERE title = ?").run(SURVIVOR_TITLE);
  } finally {
    db.close();
  }
});

test("a save that dies in the swap window retries itself to success — zero taps (#2866)", async ({
  page,
}) => {
  test.slow();
  const win = await armSwapWindow(page);
  await page.goto("/training?tab=log");
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();
  await expect(page.getByTestId("activity-form")).toBeVisible();

  const title = SURVIVOR_TITLE;
  await page.getByLabel("Activity name").fill(title);
  // A name alone is not savable (canSave needs a named part with content), so
  // build the minimal real entry: a known cardio activity plus its duration.
  await page.getByPlaceholder(/What did you do/).fill("Running");
  await page
    .getByRole("listbox")
    .getByRole("option", { name: "Running", exact: true })
    .click();

  // The window opens BEFORE the form turns savable: the duration below is the
  // edit whose debounced autosave — the FIRST persist this form can make —
  // dies on the 502 shape.
  win.arm();
  await page.getByTestId("cardio-duration").fill("30");

  // The honest state, not a bare triangle: the retry line renders while the
  // bounded backoff re-attempts on its own.
  await expect(page.getByTestId("autosave-retrying")).toBeVisible({
    timeout: 15_000,
  });
  // Not misclassified as a stale build: retrying can help here, so the manual
  // reload affordance never renders.
  await expect(page.getByTestId("stale-save-reload")).toHaveCount(0);

  // The swap completes; the next self-scheduled retry (≤45s away) must land the
  // save with no keystroke and no tap.
  win.end();
  await expect(page.getByTestId("autosave-retrying")).toHaveCount(0, {
    timeout: 60_000,
  });

  // The entry exists server-side: the feed's newest card carries the title.
  await page.reload();
  await expect(
    page.getByRole("main").getByText(title, { exact: true }).first() // first-ok: asserts the saved row exists — order-agnostic
  ).toBeVisible();
});
