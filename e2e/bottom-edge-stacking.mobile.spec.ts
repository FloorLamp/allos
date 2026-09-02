import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { openCommandPalette } from "./nav";
import {
  comboboxRows,
  deleteActivityFromForm,
  dismissToast,
  settledAfterAnimation,
  settledBoxes,
  settledClick,
} from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { workerDbPath } from "./worker-env";

// The bottom edge stacks; it does not overlap (issue #1520 part B, #2651).
//
// FIVE fixed surfaces converge on the phone's bottom edge — the nav dock
// (navigation floor) and the workout dock (session bar), the toast stack and
// offline pill (notices), and the offline error panel (alerts). Each used to
// hand-write `bottom: max(1rem, safe-area)` in isolation, so a toast raised DURING
// a live workout landed on top of the dock: the confirmation covered the "still
// working out?" bar. They now share components/overlay's bottom-edge tokens, and
// each base layer publishes its own TOP EDGE into `--bottom-edge-offset` while
// mounted, so the notice layers clear whichever of them is up.
//
// #2651 put a permanent nav dock underneath all of it, which is the second
// instance of the same collision — hence the second test below. The first still
// owns the workout-dock case, and its tail now pins the RELEASE honestly: the edge
// does not become unclaimed when the session ends, it falls back to the nav dock.
//
// Asserted as GEOMETRY (bounding boxes), not pixels or classes: the toast's bottom
// edge must sit at or above the bar's top edge — read once the notice has finished
// arriving, since #3373 gave it an enter animation to arrive WITH.
//
// Fixture discipline (#868): create-and-clean on the admin profile — this spec
// starts its OWN live session (the same pattern workout-presence.spec.ts uses for
// its interactive case) and discards it, and the one body-metric row its toast
// comes from is deleted by value in the finally.

const DB_PATH = workerDbPath();
// Weights no seed or other spec logs, so the cleanup below can key on them. One
// per test, so neither owns the other's rows (#868).
const TOAST_WEIGHT = "77.3";
const NAV_TOAST_WEIGHT = "77.4";

function cleanupMetric(weight: string) {
  const h = new Database(DB_PATH);
  try {
    h.prepare("DELETE FROM body_metrics WHERE weight_kg = ?").run(
      Number(weight)
    );
  } finally {
    h.close();
  }
}

// Raise a real toast the ordinary way: the palette's inline quick-log writes a
// body metric and confirms it — the everyday "I just did something" notice.
async function toastFromQuickLog(page: Page, weight: string): Promise<Locator> {
  const input = await openCommandPalette(page);
  await input.fill(`weight ${weight}`);
  await expect(page.getByTestId("palette-quicklog")).toContainText(weight);
  await input.press("Enter");
  // Generous window: the toast follows a Server Action + revalidation round trip,
  // which on a loaded runner is comfortably past the default 5s assertion budget.
  const toast = page.getByTestId("toast");
  await expect(toast).toBeVisible({ timeout: 25_000 });
  return toast;
}

// The stacking rule, as geometry: the notice ends where the bar begins (or above
// it), instead of covering it.
async function expectStackedAbove(toast: Locator, bar: Locator) {
  // The notice ARRIVES now (#3373): it slides up from the bottom edge over
  // `--overlay-ms`, so a box read the instant it becomes visible is a box read
  // mid-flight — ~46px low, which reads exactly like a broken bottom-edge claim.
  // A wait on the element's own animation, not a widened tolerance.
  await settledAfterAnimation(toast);
  const toastBox = await toast.boundingBox();
  const barBox = await bar.boundingBox();
  expect(toastBox).not.toBeNull();
  expect(barBox).not.toBeNull();
  expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(barBox!.y + 1);
}

// Pick an activity in the editor's exercise combobox (the shape-tolerant matcher
// the training specs document — an exact typed match collapses the list to a
// single 'Use "…"' button).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await comboboxRows(page)
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

test("a toast raised during a live workout stacks above the dock, never over it (#1520)", async ({
  page,
}) => {
  test.slow();
  try {
    // Start a live session from the sheet's Train segment, then log enough of
    // a set that the draft auto-saves — that INSERT is the presence the dock reads.
    await page.goto("/training?tab=log");
    const sheet = await openLogSheet(page);
    // SETTLED, NOT HYDRATED — the start POSTS, and its INSERT is the id every later
    // save in this flow has to carry. Left un-settled, the exercise pick below fires
    // while that create is still in the air, carries no id, and CREATES A SECOND
    // DRAFT. The editor then discards one of the two; the other stays live, so the
    // dock never goes and the failure reads as a broken discard — with a green
    // delete and an "Activity deleted." toast above it, which is why it costs a
    // whole diagnosis every time. The panel being visible (next line) was never
    // evidence of the write; it is client state.
    //
    // MEASURED, one reading rather than a sample: hold the start POST for 2s with
    // `page.route` and count live drafts on profile 1 the moment the first set is
    // in. Un-settled: 2, on 4 of 4 runs, all 4 red. Settled: 1, on 4 of 4 runs, all
    // 4 green. CPU throttling does NOT reproduce it — that slows the CLICKS too,
    // which closes the very window the race needs.
    await settledClick(page, await showLogRow(sheet, "live-workout"));
    await expect(page.getByTestId("live-workout-panel")).toBeVisible();
    await pickActivity(page, "Barbell Bench Press");
    await page
      .getByTestId("next-set-card")
      .getByRole("button", { name: "Use" })
      .click();
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeVisible();

    // Minimize and leave the training route (which hosts the inline editor instead
    // of the bar) — the app-wide dock is then up on every other page. Equipment is
    // deliberately the landing spot rather than the dashboard: the quick-log below
    // resolves only once its revalidation has re-rendered the CURRENT route, and the
    // dashboard is the app's heaviest render.
    await page.getByTestId("minimize-workout").click();
    await page.goto("/equipment");
    const dock = page.getByTestId("workout-dock");
    await expect(dock).toBeVisible();

    const toast = await toastFromQuickLog(page, TOAST_WEIGHT);
    await expectStackedAbove(toast, dock);

    // …and the workout dock is itself stacked, not stacked ON: it sits above the
    // nav dock, which is the #2651 half of the same rule. Two permanent bars
    // cannot share the same 56px, and the one that arrived second is the one that
    // moves.
    await expectStackedAbove(dock, page.getByTestId("mobile-dock"));

    // TAKE THE NOTICE DOWN BEFORE THE NEXT ROUND TRIP — the #2861 rule this file
    // had been getting away with. The stacking claim is made; from here the test
    // opens the editor and deletes through it, and a `fixed` notice still up over
    // that flow is a click interceptor. It got away with it while the notice was a
    // 288px card pinned to the RIGHT gutter, which happened to miss the editor's
    // footer controls; since #3373 the phone notice is a full-width bar and covers
    // the same band edge to edge. Measured: 2 of 3 repeats failed here with the
    // draft still live and no toast on screen at all. Dismissing is the fix the
    // helper exists for, and it removes the race instead of tolerating it.
    await dismissToast(page, TOAST_WEIGHT);

    // Discard the session: the workout dock goes, and with it ITS claim on the
    // bottom edge. The edge does not become unclaimed, though — the nav dock is
    // still there and still claims it, so the published offset falls back rather
    // than clearing. (Above `md`, where no nav dock renders, it does clear; that
    // is the desktop path and not this project's.)
    await page.getByTestId("workout-dock-open").click();
    // Scope the discard to the editor's own footer — the page BEHIND the editor
    // (Equipment) carries its own per-row Delete controls.
    await deleteActivityFromForm(page, {
      trigger: page
        .getByTestId("activity-form-footer")
        .getByRole("button", { name: "Delete", exact: true }),
    });
    try {
      await expect(dock).toHaveCount(0);
    } catch (e) {
      // KEEP THIS — it is not scaffolding any more. A bare "expected 0, got 1"
      // here says the discard did not land and nothing about WHY; the answer,
      // both times this failed, was a `fixed` notice still up over the editor's
      // footer intercepting the Delete. Naming what is on screen at the moment of
      // the red turns the next occurrence into a diagnosis instead of a hunt.
      // (The timing marks that sat beside this during the investigation are gone:
      // they read the wall clock, which the e2e hygiene guard forbids for good
      // reason, and the question they answered is answered.)
      console.log(
        "[DIAG] toasts on screen: " +
          JSON.stringify(await page.getByTestId("toast").allInnerTexts())
      );
      throw e;
    }
    const navBox = (await page.getByTestId("mobile-dock").boundingBox())!;
    await expect
      .poll(() =>
        page.evaluate(() =>
          parseFloat(
            document.documentElement.style.getPropertyValue(
              "--bottom-edge-offset"
            ) || "0"
          )
        )
      )
      // Released down to the nav dock's own claim — no longer the taller
      // workout-dock figure, and never zero while a bar is still on screen.
      .toBeCloseTo(navBox.height, 0);
  } finally {
    cleanupMetric(TOAST_WEIGHT);
  }
});

test("with no session at all, a toast still clears the nav dock (#2651)", async ({
  page,
}) => {
  // The second instance of #1520's collision class, and the common one: there is
  // no workout, just the permanent bottom bar every phone route now carries. A
  // toast confirming a log used to land ON the bar the log was tapped from.
  try {
    await page.goto("/equipment");
    const nav = page.getByTestId("mobile-dock");
    await expect(nav).toBeVisible();
    // No session — this is the plain state, not the #1520 one.
    await expect(page.getByTestId("workout-dock")).toHaveCount(0);

    const toast = await toastFromQuickLog(page, NAV_TOAST_WEIGHT);
    await expectStackedAbove(toast, nav);
  } finally {
    cleanupMetric(NAV_TOAST_WEIGHT);
  }
});

// ── THE SHEET IS A BOTTOM-EDGE SURFACE TOO (#4334) ───────────────────────────
//
// The two tests above are about BARS. This one is about the surface a person is
// looking AT when the notice arrives: an open bottom sheet is `fixed`,
// bottom-anchored and base-layer exactly as the docks are, and until #4334 it did
// not claim. So a toast raised BY a row inside the sheet came to rest ON that row
// and the next tap went to the notice — three quick taps logging two servings,
// with a confirmation on screen saying it worked.
//
// TWO CONTENT HEIGHTS, ONE SENTENCE. #4323 bought the same safety with padding
// derived from the notice band; it held for the one list it was measured against
// and nothing more, and its own comment says so. So the sequence runs over a SHORT
// sheet and over one at its `85dvh` ceiling — a ~500px difference in where the
// panel's top edge sits — and the assertion does not change. The `rows` parameter
// on the gesture fixture exists for that (there is no product caller that lets a
// spec choose a sheet's height).
//
// The tall case is also where the owner's ruling is visible: over a tall sheet the
// notice lands near the TOP of the viewport. That is not a bug to tune away, it is
// what "never over the surface it was tapped from" costs.
const CLAIM_HEIGHTS = [
  { rows: 2, why: "a short sheet, its top edge low in the viewport" },
  {
    rows: 40,
    why: "a sheet at its 85dvh ceiling, its top edge near the status bar",
  },
];

/** The published claim in px — 0 when nothing claims the edge. */
function claimedOffset(page: Page): Promise<number> {
  return page.evaluate(() =>
    parseFloat(
      document.documentElement.style.getPropertyValue("--bottom-edge-offset") ||
        "0"
    )
  );
}

/**
 * What a tap at this control's centre would ACTUALLY hit — the issue's own probe,
 * and the only one that answers the reported bug directly. "The notice's box misses
 * the control's box" and "the control owns its own centre" are different claims,
 * and a thumb only ever experiences the second.
 */
async function testIdAtCentre(control: Locator): Promise<string> {
  const box = (await control.boundingBox())!;
  return control.page().evaluate(
    ([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return (
        hit?.closest<HTMLElement>("[data-testid]")?.dataset.testid ??
        hit?.tagName ??
        "none"
      );
    },
    [box.x + box.width / 2, box.y + box.height / 2]
  );
}

for (const { rows, why } of CLAIM_HEIGHTS) {
  test(`a notice raised inside an open sheet clears it — ${why} (#4334)`, async ({
    page,
  }) => {
    await page.goto(`/e2e-fixtures/bottom-sheet?rows=${rows}`);
    const panel = page
      .getByTestId("gesture-contract-sheet")
      .locator("[data-sheet-panel]");
    await expect(panel).toBeVisible();
    // The panel ARRIVES on a `translateY`, and a box read mid-flight is the edge it
    // is leaving rather than the one it comes to rest on — the same reading error
    // the claim itself had to be taught about.
    await settledAfterAnimation(panel);

    // THE CLAIM IS THE PANEL'S OWN TOP EDGE. Asserted as the relationship, not as a
    // number: a constant here would pass on the tall sheet and the short one for
    // two different wrong reasons.
    const [panelBox] = await settledBoxes([panel]);
    const viewport = page.viewportSize()!.height;
    expect(await claimedOffset(page)).toBeCloseTo(viewport - panelBox.y, 0);

    // A notice raised by a control INSIDE the sheet, sitting at the foot of its
    // content — which is the band the notice used to land in.
    const raise = page.getByTestId("fixture-raise-notice");
    await raise.click();
    const toast = page.getByTestId("toast");
    await expect(toast).toBeVisible();
    await expectStackedAbove(toast, panel);

    // …so the control still owns its own centre, and three more taps all land.
    // SEQUENTIAL, not a `Promise.all` burst: what makes a tap land is the HIT
    // TEST, not the interval between taps, and Playwright refuses a click whose
    // point another element intercepts — so a notice resting on this control fails
    // here rather than being timed around.
    expect(await testIdAtCentre(raise)).toBe("fixture-raise-notice");
    await raise.click();
    await raise.click();
    await raise.click();
    await expect(page.getByTestId("fixture-notice-count")).toHaveText("4");
    expect(await testIdAtCentre(raise)).toBe("fixture-raise-notice");
  });
}

// Long enough that the panel is still painting its slide when the assertion
// below reads it, on any machine: the shipped arrival is 240ms (`--overlay-ms`)
// and the read follows two CDP round-trips after the sheet's body renders.
const ARRIVAL_HOLD_MS = 10_000;

test("the quick-log sheet claims while its body is still arriving, and releases on close (#4334)", async ({
  page,
}) => {
  test.slow();
  // The real surface the bug was reported on, and the window it lived in: the
  // sheet's body loads behind a Server Action, so the panel is still growing after
  // it opens and the rows sit lower while it does. A claim measured once on mount
  // would be correct only after everything settled — which is not when the taps
  // happen. The panel's SLIDE is the tail of that window, and the longer half:
  // sampled frame by frame on 2026-09-02, the body's height was already final by
  // the time `food-log-bar` rendered, and the arrival still had 195ms to run.
  await page.goto("/nutrition");
  const logSheet = await openLogSheet(page);
  const logFood = await showLogRow(logSheet, "log-food");
  // HOLD THE NEXT ARRIVAL OPEN, so the read below lands inside it every run
  // (#4796). At the shipped `--overlay-ms` (240ms) this was a race the local box
  // always won: measured 2026-09-02, the panel still had 195ms of its enter
  // animation left on the frame `food-log-bar` became visible, and the two CDP
  // round-trips that followed landed AFTER it ended — so the half named SETTLING
  // only ever examined the settled state, and it went red the three times CI was
  // slow enough to land inside the arrival. Nothing else reads this token, and
  // `usePresence` times the unmount from lib/motion's JS constant, so the
  // sheet's lifecycle is untouched — only how long the panel paints its slide.
  //
  // LAND WHAT IS ALREADY ON SCREEN IN THE SAME TURN. Growing the token retimes
  // keyframes that have already FINISHED — a non-filling animation whose duration
  // now exceeds its current time is running again — so this sheet's own slide
  // replays over the new duration and the click below waits out Playwright's
  // stability check on it. Measured: `settledClick` took the hold plus ~120ms, at
  // both 3s and 10s.
  await page.evaluate((ms) => {
    document.documentElement.style.setProperty("--overlay-ms", `${ms}ms`);
    for (const animation of document.getAnimations()) animation.finish();
  }, ARRIVAL_HOLD_MS);
  await settledClick(page, logFood);
  const sheet = page.getByTestId("quick-entry-sheet");
  const panel = sheet.locator("[data-sheet-panel]");
  await expect(sheet.getByTestId("food-log-bar")).toBeVisible();

  const viewport = page.viewportSize()!.height;
  // SETTLING: ONE observation, not two statements apart. The published claim,
  // where the panel actually is, and whether it is still moving all come from
  // the same synchronous turn — so the assertions below the settle describe one
  // instant rather than three, which is what the old pair of reads a CDP
  // round-trip apart could not do.
  const arriving = await panel.evaluate((el) => ({
    top: el.getBoundingClientRect().top,
    claimed: parseFloat(
      document.documentElement.style.getPropertyValue("--bottom-edge-offset") ||
        "0"
    ),
    animating: el.getAnimations().length > 0,
  }));

  // Release the hold and land the panel where ten seconds of waiting would have
  // put it — the slowdown exists only so the read above can happen inside the
  // arrival, and the rest of this case is about the settled state.
  await panel.evaluate((el) => {
    document.documentElement.style.removeProperty("--overlay-ms");
    for (const animation of el.getAnimations()) animation.finish();
  });
  // SETTLED: and now it is the panel's top edge exactly.
  const [settled] = await settledBoxes([panel]);
  expect(await claimedOffset(page)).toBeCloseTo(viewport - settled.y, 0);
  // The reading above really was taken mid-flight — a running keyframe, and the
  // panel still BELOW where it comes to rest. Both halves of that, because a
  // keyframe can be running with the panel already there.
  expect(arriving.animating).toBe(true);
  expect(arriving.top).toBeGreaterThan(settled.y);
  // …and the claim was ALREADY the settled top edge at that moment. THIS is what
  // the SETTLING half was reaching for, and what a threshold derived from a
  // second read taken a CDP round-trip later could never say: the claim is the
  // panel's RESTING edge from its first frame, not a number that catches up when
  // the animation ends. Before #4796 it read the edge the panel was sliding up
  // FROM — 505.04 here — and a notice raised in that window came to rest on the
  // sheet.
  //
  // THE DEPARTING SHEET IS A SEPARATE, OPPOSITE CASE, and it is unchanged: the
  // quick-log sheet is still playing its exit here, and its own resting claim
  // (582) stays in the map until it unmounts, because nothing re-measures a
  // panel that is only being translated away. That direction is SAFE — it
  // over-states how much edge is spoken for, so a notice clears more than it
  // needs to rather than landing on something. It is why 582 was byte-identical
  // in every CI red: it was the max while the arriving panel under-reported at
  // 505.04. With the arriving panel honest at 615 it simply loses the max.
  expect(arriving.claimed).toBeCloseTo(viewport - settled.y, 0);

  // Closing RELEASES the claim down to the nav dock — the same shape the
  // workout-dock test pins for a session ending, and the half that a claim which is
  // never withdrawn would pass without.
  // ESCAPE, not the scrim: at `85dvh` the panel covers the backdrop's own centre,
  // so a scrim click is intercepted by the very surface it would dismiss.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  const navBox = (await page.getByTestId("mobile-dock").boundingBox())!;
  await expect.poll(() => claimedOffset(page)).toBeCloseTo(navBox.height, 0);
});
