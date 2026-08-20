import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import {
  awaitHydrated,
  hydratedClick,
  touchSwipe,
  touchSwipeFrom,
} from "./helpers";

// The #2774 convergence, from the outside: ModalShell's consumers now render the
// ONE responsive dialog primitive, so on a phone they are sheets that OWN THE
// VIEWPORT.
//
// THE DEFECT THIS RETIRES. ModalShell rendered `fixed inset-0 overflow-y-auto`
// and scrolled itself over an UNLOCKED body, so a drag its own scroller did not
// claim chained out to the document: the page slid around behind the dialog and
// on release sat somewhere other than where the dialog was opened from. That is
// what the first test pins, and it pins it the only way that means anything —
// by moving the page, not by reading a class off an element. A test that opened
// a dialog and asserted it rendered would answer a much cheaper question.
//
// Fixture hygiene (#868): every test here types and dismisses. Nothing is
// submitted, so the spec writes NOTHING and can share the seeded session at any
// parallelism.

const TITLE_FIELD = "Reason / title";
const DRAFT = "e2e dialog convergence visit";

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

async function bodyOverflow(page: Page): Promise<string> {
  return page.evaluate(() => document.body.style.overflow);
}

// Every gesture below is anchored to the DOCUMENT, not to an element: that is
// what a page scroll IS, and the scrim a drag starts on is a full-viewport
// sibling of the panel. Inline literals, per the e2e hygiene guard — a measured
// point would be the wrong tool for a gesture that is not aimed at anything.

/** Drag upward from low on the screen — the gesture that scrolls a page DOWN. */
async function dragPageUp(page: Page) {
  await touchSwipe(page, { x: 195, y: 480 }, { x: 195, y: 320 });
}

// WHERE THE PAGE IS, measured on the page itself rather than on `window.scrollY`.
// A locked page is parked (`position: fixed` with a top offset), so its scroll
// offset reads 0 the whole time it is held — true, and useless: it says nothing
// about whether the reader's place moved. The distance from the viewport top to a
// landmark ON the page is the thing a person would notice, so that is what gets
// asserted.
async function pageOffset(page: Page): Promise<number> {
  const box = await page.getByTestId("visits-upcoming").boundingBox();
  expect(
    box,
    "the landmark must be laid out to measure the page's place"
  ).not.toBeNull();
  return box!.y;
}

/** The dialog panel's top edge — where the sheet actually sits right now. */
async function panelTop(dialog: Locator): Promise<number> {
  const box = await dialog.boundingBox();
  expect(
    box,
    "the panel must be laid out to measure where it sits"
  ).not.toBeNull();
  return Math.round(box!.y);
}

// …once the panel has stopped moving. It SLIDES IN on open, so a reading taken
// the moment the dialog appears is a number it is still on its way past: this
// baseline read 180 and 194 on two runs whose true resting top was 172, and the
// comparison below then failed by the width of one animation frame. Asking the
// element whether it has any running animations left is exact — it covers the
// enter keyframe and the drag's settle transition alike, and under reduced
// motion there are none, so it returns at once.
async function restingPanelTop(dialog: Locator): Promise<number> {
  await expect
    .poll(() => dialog.evaluate((el) => el.getAnimations().length === 0), {
      message:
        "the panel must stop animating before its resting place can be measured",
    })
    .toBe(true);
  return panelTop(dialog);
}

// Tap the scrim, and PROVE WHERE THE TOUCH LANDED (#2714's rule, applied to a
// tap).
//
// The y is a constant, and that is the fix rather than an accident. The panel is
// capped at `max-h-[85dvh]`, so on this 844px viewport its top can never sit
// above ~127px: the top band of the screen is scrim BY CONSTRUCTION, whatever
// the form's height does. A point computed from a measured panel top is not —
// it is "a fact about the past from the instant it is returned", and a
// bottom-anchored panel that gathers content grows UPWARD into it. The touch
// then lands on the panel, the scrim's handler never runs, and NOTHING HAPPENS,
// SILENTLY: dialog still mounted, form still dirty, no confirm. That is exactly
// the state CI reported, and it is why a 20x CPU throttle stayed green here — a
// throttle slows the race, not one side of it.
//
// Proving the landing is the second half. `touchSwipeFrom` re-aims and checks
// the touchstart target for the same reason; without it a miss is invisible and
// reads as a broken feature.
async function tapScrim(page: Page): Promise<void> {
  // WAIT FOR THE SCRIM TO BE LIVE BEFORE AIMING AT IT (#2742). A tap that lands
  // before React has claimed the node is swallowed with no error at all:
  // Playwright's actionability is satisfied, because the element is genuinely
  // there and genuinely hittable, and the click simply reaches no handler. CI
  // reported exactly that — `hit: modal-shell-backdrop`, form still dirty, no
  // confirm, dialog still open — three runs running, while the same tap from a
  // standing start passed on the same shard. The difference is that here a
  // confirm has just unmounted over this surface.
  await awaitHydrated(page.getByTestId("modal-shell-backdrop"));
  await page.evaluate(() => {
    const store = window as unknown as Record<string, unknown>;
    store.__scrimTapTarget = null;
    document.addEventListener(
      "touchstart",
      (e) => {
        store.__scrimTapTarget = e.target;
      },
      { capture: true, once: true, passive: true }
    );
  });
  await page.touchscreen.tap(195, 60);
  const landedOn = await page.evaluate(() => {
    const target = (window as unknown as Record<string, unknown>)
      .__scrimTapTarget;
    if (!(target instanceof Element)) return "nothing";
    return target.getAttribute("data-testid") ?? target.tagName;
  });
  expect(
    landedOn,
    "the tap must reach the scrim — if the panel has grown up into this point, the touch lands on the form and the dismissal silently does nothing"
  ).toBe("modal-shell-backdrop");
}

// ── THE LAST PROBE (#2774): is the tap finger #2? ────────────────────────────
//
// `touch-manipulation` on the scrim was tried and REVERTED: CI ran it and the
// click log was still empty after a full two-second wait, so the double-tap
// delay was not the reason. What survives is narrower and decides whether this
// is a PRODUCT defect at all.
//
// The flick goes through `touchSwipeFrom`, which opens its OWN CDP session and
// detaches it; the tap goes through `page.touchscreen.tap`, on the page's
// session. Input dispatched on two different CDP sessions is not ordered
// against each other. If the flick's lift has not been processed when the tap's
// press arrives, the tap is a SECOND touch point — and a browser synthesises no
// click for finger #2 of a multi-touch gesture, by definition. That would make
// this an artefact of synthetic input that no real hand can produce, not
// something a user ever meets.
//
// So log the touch sequence itself, from before the flick, and let the tap's own
// touchstart say how many fingers the page thinks are down:
//
//   tap's touchstart with `touches: 2`   -> finger #2. A DRIVER artefact. The
//                                           product is fine and the test must
//                                           stop depending on this click.
//   tap's touchstart with `touches: 1`   -> one finger, a live scrim, a
//     and still no click                    committed handler, and no click:
//                                           genuine browser gesture arbitration,
//                                           and a real dead tap for real hands.
//   no touchstart logged at the tap      -> the tap never reached the page, and
//                                           neither of the above is the story.
//
// If this comes back unidentified, we stop probing and the chain test stops
// depending on the browser dispatching that click (#3262 records the unknown).
async function installTouchLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as Record<string, unknown>;
    const log: unknown[] = [];
    store.__touchLog = log;
    // Moves are counted, not listed: ten steps per swipe would bury the two
    // readings that matter (the flick's lift, and the tap's press).
    let moves = 0;
    document.addEventListener(
      "touchmove",
      () => {
        moves += 1;
      },
      { capture: true, passive: true }
    );
    for (const type of ["touchstart", "touchend", "touchcancel"]) {
      document.addEventListener(
        type,
        (event) => {
          const touch = event as TouchEvent;
          log.push({
            type,
            // `touches` is every finger currently down INCLUDING this one, so a
            // press that reads 2 is the second finger of a gesture the page
            // still believes is in progress.
            touches: touch.touches.length,
            changed: touch.changedTouches.length,
            movesSoFar: moves,
          });
        },
        { capture: true, passive: true }
      );
    }
  });
}

/** Drag downward from high on the screen — with a sheet open, that is its scrim. */
async function dragScrimDown(page: Page) {
  await touchSwipe(page, { x: 195, y: 90 }, { x: 195, y: 420 });
}

async function openAddVisit(page: Page) {
  await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
  const dialog = page.getByRole("dialog", { name: "Add visit" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the page behind an open record dialog does not move, and moves again once it closes", async ({
  page,
}) => {
  test.slow();
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  // The dialog is opened from the TOP of the page, deliberately. A version of
  // this test scrolled first, and it was flaky for two reasons that are both
  // about the fixture rather than the fix: a touch drag FLINGS, so the page is
  // still decelerating when the next line reads it, and clicking a control that
  // scrolling has pushed near the viewport edge makes Playwright scroll it back
  // into view — a legitimate movement that the assertion cannot tell from the
  // defect. Neither happens from a standing start, and the defect is just as
  // visible: what is being pinned is that a drag under an open dialog moves the
  // page AT ALL.
  const dialog = await openAddVisit(page);
  // The phone presentation is the sheet: bottom-anchored, with the drag handle
  // that makes a surface read as one (the owner decision in #2774).
  await expect(page.getByTestId("modal-shell")).toHaveAttribute(
    "data-presentation",
    "dialog"
  );
  await expect(dialog.getByTestId("sheet-drag-handle")).toBeVisible();
  const held = await pageOffset(page);

  // THE PIN. A drag the dialog does not consume — one that starts on the scrim,
  // which scrolls nothing — used to chain straight out to the document, and the
  // page ended up somewhere other than where it was opened from.
  await dragPageUp(page);
  expect(
    await pageOffset(page),
    "the page must not move behind an open dialog"
  ).toBe(held);
  await dragScrimDown(page);
  expect(await pageOffset(page)).toBe(held);
  // And the mechanism is on: the surface holds the page still while it is open.
  expect(await bodyOverflow(page)).toBe("hidden");

  // The other half — the page is released where it was, not left frozen.
  await hydratedClick(page, dialog.getByRole("button", { name: "Close" }));
  await expect(dialog).toHaveCount(0);
  expect(await bodyOverflow(page)).toBe("");
  expect(
    await pageOffset(page),
    "closing must leave the reader where they were"
  ).toBe(held);

  // CONTROL, last: the very same gesture DOES scroll this page. Without it every
  // "it did not move" above would be satisfied by a page that cannot move at all
  // — the classic green that proves nothing.
  await dragPageUp(page);
  expect(
    await pageOffset(page),
    "the page must scroll again once the dialog has closed"
  ).toBeLessThan(held);
});

test("the page behind an open quick-entry sheet does not move either", async ({
  page,
}) => {
  test.slow();
  // The quick-entry overlay reached by url (#1424) — the OTHER half of #2774's
  // acceptance: one converged record form and one quick-entry form. This one was
  // already a sheet, so it is the regression half rather than the fix half.
  await page.goto("/?quick=log-stool");
  await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
  expect(await bodyOverflow(page)).toBe("hidden");

  const before = await scrollY(page);
  await dragScrimDown(page);
  await dragPageUp(page);
  expect(
    await scrollY(page),
    "the dashboard must not move under the sheet"
  ).toBe(before);
  expect(before, "a held page cannot be scrolled away from its parked 0").toBe(
    0
  );
});

// The dirty-discard guard (#2774, consequence B), in three tests rather than one
// chain. The chained version — flick, refuse, then tap the scrim, then reopen —
// was green here ten times over and red on CI, and a test whose failure cannot be
// reproduced is a test nobody can act on. Each guarantee now starts from a dialog
// in a known state, which is also the only way to tell WHICH of them broke.

test("a flick on a dirty form asks first, and keeping the edit brings the whole form back", async ({
  page,
}) => {
  test.slow();
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  const dialog = await openAddVisit(page);
  const title = dialog.getByLabel(TITLE_FIELD);
  await expect(title).toBeVisible();
  await title.fill(DRAFT);
  // Measured after the typing as well as after the animation: what has to come
  // back is the panel as it stands when the flick starts.
  const atRest = await restingPanelTop(dialog);

  // A flick on the handle is the sheet's discard gesture (#1428). Right for a
  // half-typed weight; wrong for a form somebody has been filling in.
  await touchSwipeFrom(page, dialog.getByTestId("sheet-drag-handle"), {
    dy: 260,
  });
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toBeVisible();

  // KEEPING THE EDIT PUTS THE FORM BACK — all of it, not just the text. The
  // flick has already dragged the panel most of the way off the bottom edge by
  // the time the question is asked, so a refused dismissal has to bring it home;
  // the first version of this feature did not, and left the dialog parked at
  // translateY(672px) with the typing safe inside a surface nobody could see.
  // Asserted as GEOMETRY because the obvious assertion does not catch that:
  // `toBeVisible()` passes on a panel with 0.06px left on screen.
  await hydratedClick(
    page,
    confirm.getByRole("button", { name: "Keep editing" })
  );
  await expect(confirm).toBeHidden();
  await expect
    .poll(() => panelTop(dialog), {
      message:
        "keeping the edit must settle the form back to rest, not leave it parked off the bottom edge",
    })
    .toBe(atRest);
  await expect(title).toHaveValue(DRAFT);

  // And the guard is not spent: the SAME gesture asks again, and this time the
  // answer is discard. Refusing a dismissal must not disarm the surface.
  await touchSwipeFrom(page, dialog.getByTestId("sheet-drag-handle"), {
    dy: 260,
  });
  await expect(confirm).toBeVisible();
  await hydratedClick(page, confirm.getByRole("button", { name: "Discard" }));
  await expect(dialog).toHaveCount(0);
});

test("a scrim tap on a dirty form asks first too", async ({ page }) => {
  test.slow();
  // The other accidental dismissal. Its own test, from its own clean dialog: the
  // scrim is a full-viewport sibling of the panel, so this is the one gesture
  // whose landing spot depends on nothing that happened earlier.
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  const dialog = await openAddVisit(page);
  const title = dialog.getByLabel(TITLE_FIELD);
  await expect(title).toBeVisible();
  await title.fill(DRAFT);

  await tapScrim(page);
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toBeVisible();
  await hydratedClick(page, confirm.getByRole("button", { name: "Discard" }));
  await expect(dialog).toHaveCount(0);
});

test("a clean converged form dismisses in one gesture, with no question", async ({
  page,
}) => {
  test.slow();
  // Nothing typed, nothing to lose. Without this the guard could be a confirm on
  // EVERY dismissal, which is the click-through it must not become.
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  const dialog = await openAddVisit(page);
  await expect(dialog.getByLabel(TITLE_FIELD)).toBeVisible();
  await touchSwipeFrom(page, dialog.getByTestId("sheet-drag-handle"), {
    dy: 260,
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
});

test("a refused flick leaves the scrim tap still guarded — the whole chain, end to end", async ({
  page,
}) => {
  test.slow();
  // THE SEQUENCE THAT FAILED IN CI, kept deliberately (#2774).
  //
  // The three tests above each start from a dialog in a known state, which is the
  // better structure and how they should be read. This one exists because
  // splitting them removed the only coverage of the sequence that actually broke:
  // flick, refuse, then tap the scrim. It was green locally ten times over —
  // including at 20x CPU throttling, instrumented, with the tap landing on
  // `modal-shell-backdrop` and the form still dirty every run — and red on CI,
  // while the scrim tap from a STANDING START passed there. That difference says
  // state left by the refusal round-trip is implicated, and deleting the sequence
  // would guarantee we never find out.
  //
  // So it is written with every synchronisation this file has learned — settled
  // animation before any measurement, the panel proven back at rest before the
  // tap — and no shortcut past them. If it goes red again, that is evidence of a
  // real race rather than a flaky fixture, and the assertions below are ordered
  // to say WHICH race it is.
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  const dialog = await openAddVisit(page);
  const title = dialog.getByLabel(TITLE_FIELD);
  await expect(title).toBeVisible();
  await title.fill(DRAFT);
  const atRest = await restingPanelTop(dialog);

  // Armed BEFORE the flick, because the reading that matters is whether the
  // flick's LIFT was processed before the tap's press (see installTouchLog).
  await installTouchLog(page);
  await touchSwipeFrom(page, dialog.getByTestId("sheet-drag-handle"), {
    dy: 260,
  });
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toBeVisible();
  await hydratedClick(
    page,
    confirm.getByRole("button", { name: "Keep editing" })
  );
  await expect(confirm).toBeHidden();
  // The panel is proven home BEFORE the tap is aimed, so the tap cannot be
  // chasing a moving target and a red below cannot be blamed on one.
  await expect
    .poll(() => panelTop(dialog), {
      message: "the form must be back at rest before the scrim is aimed at",
    })
    .toBe(atRest);

  // ── THE THREE-WAY PROBE (#2774) ───────────────────────────────────────────
  //
  // CI says the touch lands on a hydrated scrim with the form dirty and nothing
  // happens. That is inferred from the ABSENCE of both effects, which cannot
  // tell "the handler never ran" from "the handler ran and did nothing". These
  // four readings separate every case that survives a code read:
  //
  //   no click logged at all          -> the browser never dispatched one, and
  //                                      this is gesture arbitration, not us
  //   click logged, handler present   -> React had the prop and did not route it
  //   handler prop MISSING at tap     -> the node was replaced between the
  //                                      hydration wait and the dispatch
  //   a page error                    -> the handler ran and threw, which looks
  //                                      exactly like never running from outside
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message ?? e)));
  const handlerBefore = await page
    .getByTestId("modal-shell-backdrop")
    .evaluate((node) => {
      const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
      const props = key
        ? (node as unknown as Record<string, { onClick?: unknown }>)[key]
        : undefined;
      return props ? typeof props.onClick : "no-react-props";
    });
  await page.evaluate(() => {
    const store = window as unknown as Record<string, unknown>;
    store.__clickLog = [];
    document.addEventListener(
      "click",
      (e) => {
        const t = e.target;
        (store.__clickLog as unknown[]).push({
          target:
            t instanceof Element
              ? (t.getAttribute("data-testid") ?? t.tagName)
              : "none",
          defaultPrevented: e.defaultPrevented,
        });
      },
      { capture: true }
    );
  });

  // The tap NAMES THE SCRIM and proves it landed there. It used to aim at
  // `atRest / 2` — a point derived from a boundingBox taken before the flick —
  // which is the #2714 trap: the panel is bottom-anchored, so anything that
  // grows it upward slides the form under a coordinate a settled measurement had
  // just certified, and the touch lands on the form instead of the scrim.
  await tapScrim(page);

  // WHAT THE PAGE LOOKED LIKE AT THE TAP, carried into the failure message. This
  // sequence has never failed here — not in ten runs, not at 20x CPU throttling —
  // so CI is the only place the evidence exists, and a bare "element not found"
  // from it is a symptom with no mechanism attached. If the landing proof above
  // passes and this still goes red, the touch reached the scrim and the surface
  // did not answer, which is a different bug and this says so.
  // Wait for a click rather than snapshotting for one. Reading the log the
  // instant `tap()` returns cannot see a LATE dispatch, so an empty array proved
  // "no click yet" when the claim being made was "no click ever" — a different
  // sentence, and the weaker one. Two seconds is far longer than the ~300ms a
  // browser withholds a tap for while it waits out a possible double-tap.
  const atTap = await page.evaluate(async () => {
    const store = window as unknown as Record<string, unknown>;
    // Counted, not clocked: forty 50ms turns is two seconds without reading a
    // wall clock, which this suite pins to its frozen instant (and its hygiene
    // guard rightly refuses in a spec, deadline or not).
    for (let turn = 0; turn < 40; turn += 1) {
      if ((store.__clickLog as unknown[]).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const panel = document.querySelector("[data-sheet-panel]");
    return {
      clicks: store.__clickLog,
      // The whole touch sequence, flick and tap together. The LAST entry is the
      // tap's own press: `touches: 2` there means the tap was finger #2 and the
      // missing click is a driver artefact, not a defect.
      touches: store.__touchLog,
      hit:
        document.elementFromPoint(195, 60)?.getAttribute("data-testid") ??
        "nothing",
      dirty:
        document
          .querySelector('[data-testid="dirty-form-registry"]')
          ?.getAttribute("data-dirty") ?? "?",
      panelTop: panel ? Math.round(panel.getBoundingClientRect().top) : -1,
      confirmMounted: document.querySelectorAll(
        '[data-testid="confirm-dialog"]'
      ).length,
    };
  });

  // ORDERED TO DIAGNOSE. If the guard failed OPEN, the dialog is already gone and
  // the typing with it — a dirty form silently discarded by a scrim tap, which is
  // the precise harm this feature exists to prevent. That is a different bug from
  // a tap the surface merely swallowed, and a future red should not leave the
  // reader guessing which one they are looking at.
  await expect(
    dialog,
    "a scrim tap must never discard a dirty form silently"
  ).toHaveCount(1);
  await expect(
    confirm,
    `a scrim tap on a dirty form must raise the confirm, even after an earlier flick was refused (onClick before the tap: ${handlerBefore}; page errors: ${JSON.stringify(
      pageErrors
    )}; at that moment: ${JSON.stringify(atTap)})`
  ).toBeVisible();
  await hydratedClick(page, confirm.getByRole("button", { name: "Discard" }));
  await expect(dialog).toHaveCount(0);
});

test("a dialog stacked over a sheet leaves the page held until the last one closes", async ({
  page,
}) => {
  test.slow();
  // The nesting invariant #2774 made mandatory before the body-scroll lock could
  // gain thirty-odd new holders. The count's ORDER-BLINDNESS is pinned at the
  // pure tier (lib/__tests__/scroll-lock.test.ts, both closing orders); this is
  // the real stack, in the browser, with two surfaces genuinely mounted at once.
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();
  expect(await bodyOverflow(page)).toBe("");

  const dialog = await openAddVisit(page);
  await dialog.getByLabel(TITLE_FIELD).fill(DRAFT);
  expect(await bodyOverflow(page)).toBe("hidden");

  // The discard confirm opens a SECOND surface over the first.
  await tapScrim(page);
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toBeVisible();
  expect(await bodyOverflow(page)).toBe("hidden");

  // The INNER surface closes. The page must still be held — a save/restore lock
  // released it here, and the page underneath started moving with a dialog still
  // on screen.
  await hydratedClick(
    page,
    confirm.getByRole("button", { name: "Keep editing" })
  );
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeVisible();
  expect(
    await bodyOverflow(page),
    "the outer dialog is still open, so the page is still held"
  ).toBe("hidden");

  // Only the LAST surface releases it.
  await hydratedClick(page, dialog.getByRole("button", { name: "Close" }));
  await expect(dialog).toHaveCount(0);
  expect(await bodyOverflow(page)).toBe("");
});
