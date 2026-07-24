import { test, expect, type Page } from "@playwright/test";

// Issue #1422: the two hardware affordances the phone-at-the-gym flow depends on —
// a screen wake lock while the live editor is on screen, and haptic cues for the two
// moments you're not looking at the phone. Both are progressive enhancement: absent
// APIs are silent no-ops and the visual timer stays the source of truth, so the specs
// install their OWN stub `navigator.wakeLock` / `navigator.vibrate` (headless Chromium
// won't grant a real screen lock) and assert what the app ASKED FOR.
//
//   1. Opening the live editor requests a screen wake lock.
//   2. Minimizing to the dock releases it (the editor stays MOUNTED there — the whole
//      reason an unmount-tied lock was wrong); restoring re-acquires.
//   3. Checking off a set fires the short set-logged tick.
//   4. prefers-reduced-motion suppresses the tick (the #1307 posture).
//   5. With BOTH APIs absent, the live flow still opens and the timer still runs.

type StubbedWindow = Window & {
  __wakeLock?: { requests: number; releases: number };
  __vibrations?: number[][];
};

// Shadow the real (permission-gated, unavailable-in-headless) APIs with recording
// stubs. Own properties on `navigator` shadow the prototype accessors, and the script
// runs before any app code on every navigation, so a spec's counters always start at 0
// for the page it just loaded.
async function stubHardware(page: Page) {
  await page.addInitScript(() => {
    const w = window as StubbedWindow;
    w.__wakeLock = { requests: 0, releases: 0 };
    w.__vibrations = [];
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          w.__wakeLock!.requests += 1;
          return {
            release: async () => {
              w.__wakeLock!.releases += 1;
            },
          };
        },
      },
    });
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: (pattern: number | number[]) => {
        w.__vibrations!.push(Array.isArray(pattern) ? [...pattern] : [pattern]);
        return true;
      },
    });
  });
}

// Remove both APIs entirely — the desktop-Firefox / iOS-Safari shape.
async function stripHardware(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: undefined,
    });
  });
}

const wakeLockCounts = (page: Page) =>
  page.evaluate(
    () => (window as StubbedWindow).__wakeLock ?? { requests: 0, releases: 0 }
  );

const vibrations = (page: Page) =>
  page.evaluate(() => (window as StubbedWindow).__vibrations ?? []);

// Pick an activity in the editor's exercise combobox (the shape-tolerant matcher
// entry-ergonomics documents, same as live-workout.spec.ts).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

// Open the live editor from the journal aside and wait for the control strip.
async function startLiveWorkout(page: Page) {
  await page.goto("/training");
  await page.getByRole("main").getByTestId("start-workout").click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
}

// Drive a complete first set so "+ Add set" (the check-off gesture) unlocks. This
// auto-saves a draft activity — every test that calls it OWNS that row and deletes it.
async function completeFirstSet(page: Page) {
  await pickActivity(page, "Barbell Bench Press");
  const weight = page.getByTestId("set1-weight");
  await weight.focus();
  await expect(weight).toHaveValue(/^\d/);
  // The Delete button appearing confirms the draft persisted (so it's ours to clean up).
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();
}

// Delete the draft this spec created, so the shared seed DB is left as found.
async function discardDraft(page: Page) {
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
}

test("the live editor takes a screen wake lock, drops it on minimize, and re-takes it on restore (#1422)", async ({
  page,
}) => {
  await stubHardware(page);
  await startLiveWorkout(page);

  // 1. Opening the live editor asks for the lock.
  await expect
    .poll(async () => (await wakeLockCounts(page)).requests)
    .toBeGreaterThanOrEqual(1);
  expect((await wakeLockCounts(page)).releases).toBe(0);

  // 2. Minimizing to the dock releases it. The panel is still MOUNTED (the rest timer
  //    keeps ticking behind the bar), so this is exactly the case a mount-tied release
  //    could never cover.
  await page.getByTestId("minimize-workout").click();
  await expect(page.getByTestId("workout-dock")).toBeVisible();
  await expect
    .poll(async () => (await wakeLockCounts(page)).releases)
    .toBeGreaterThanOrEqual(1);

  // 3. Restoring from the dock re-acquires.
  const beforeRestore = (await wakeLockCounts(page)).requests;
  await page.getByTestId("workout-dock-open").click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  await expect
    .poll(async () => (await wakeLockCounts(page)).requests)
    .toBeGreaterThan(beforeRestore);

  // No set was logged, so nothing auto-saved — close without a draft to clean up.
  await page.keyboard.press("Escape");
});

test("checking off a set fires the short haptic tick (#1422)", async ({
  page,
}) => {
  await stubHardware(page);
  await startLiveWorkout(page);
  await completeFirstSet(page);

  expect(await vibrations(page)).toEqual([]);

  // The check-off gesture: adding the next set. It starts the rest countdown AND
  // ticks — the pattern comes from lib/haptics, pinned in the pure tier.
  await page.getByRole("button", { name: "+ Add set" }).click();
  await expect(page.getByTestId("rest-toggle")).toHaveAttribute(
    "aria-label",
    "Pause rest timer"
  );
  await expect.poll(() => vibrations(page)).toEqual([[18]]);

  await discardDraft(page);
});

test("prefers-reduced-motion suppresses the check-off tick, but the set still lands (#1422)", async ({
  browser,
}) => {
  // A reduced-motion context (the #1307 spec's mechanism). Built off the project's
  // inherited options, so it keeps the admin storageState + baseURL without a second
  // login round-trip.
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  try {
    await stubHardware(page);
    await startLiveWorkout(page);
    await completeFirstSet(page);

    await page.getByRole("button", { name: "+ Add set" }).click();
    // The visual cue is untouched — vibration is additive only, so suppressing it
    // costs the flow nothing.
    await expect(page.getByTestId("rest-toggle")).toHaveAttribute(
      "aria-label",
      "Pause rest timer"
    );
    expect(await vibrations(page)).toEqual([]);

    await discardDraft(page);
  } finally {
    await ctx.close();
  }
});

test("the live flow works with no wake-lock and no vibration API at all (#1422)", async ({
  page,
}) => {
  await stripHardware(page);
  await startLiveWorkout(page);

  // The rest timer renders and runs — the whole surface degrades silently.
  const remaining = page.getByTestId("rest-remaining");
  await expect(remaining).toHaveText(/^\d+:\d\d$/);
  await page.getByTestId("rest-toggle").click();
  await expect(page.getByTestId("rest-toggle")).toHaveAttribute(
    "aria-label",
    "Pause rest timer"
  );

  await page.keyboard.press("Escape");
});
