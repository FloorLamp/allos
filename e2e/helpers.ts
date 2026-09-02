import {
  expect,
  type CDPSession,
  type ElementHandle,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { AUTO_RELOAD_KEY } from "@/lib/sw-update";
import { MONTHS_LONG } from "@/lib/date";
import {
  CONTROL_BOX_PX,
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
} from "@/lib/tap-floor-tokens";
import { roundControlBoxExtraLines } from "./control-box-lines";

// The blessed e2e interaction module (issue #868, fix b2).
//
// The suite had reinvented "wait until the interaction actually took effect" per
// spec — a zoo of `waitForLoadState("networkidle")` gates, `waitForTimeout(...)`
// sleeps, and `toPass()` re-click loops. They disagree about WHAT they wait for,
// so the same class of race (a Server-Action POST whose revalidated re-render
// detaches elements mid-interaction, or a pre-hydration click that gets
// swallowed — #730/#830) leaks through in whichever spec picked the weaker gate.
// This module is the ONE home for settled interactions; new specs use it, and the
// hygiene guard (`lib/__tests__/e2e-hygiene.test.ts`) freezes the legacy
// `networkidle`/`waitForTimeout` offenders and fails any NEW one.
//
// ── Decision tree: how to wait for an interaction to take effect ──────────────
//
// 1. The click fires a Server Action (a `<form action>` submit, a dose-confirm
//    button, a create/delete) and you want to assert the RESULT:
//        → settledClick(page, locator)
//    It awaits the action's POST response before returning, so the assertion that
//    follows can't run against a half-applied state. (You still assert with an
//    auto-retrying `expect(...)` — settledClick guarantees the action COMPLETED
//    server-side; React then applies the revalidated RSC, which the retry catches.)
//
// 1b. …and the very next thing you assert is that REVALIDATED RENDER — a marker
//    that exists only once the router has applied the new tree:
//        → settledClickApplied(page, locator, marker)
//    The action's own resolution and the router's apply are two different events
//    with wildly different latencies (#1964: 0.03–0.39s vs 0.47–3.33s throttled,
//    with 7× run-to-run spread), and settledClick only ever promised the first.
//    This helper waits for both, under ONE named ceiling, so the call site declares
//    which guarantee it needs instead of ceiling-patching the assertion below it.
//
// 1c. The interaction is a FILE PICK whose `onChange` fires a Server Action (there
//    is no click to drive — the input is hidden behind a label):
//        → settledUpload(page, input, files)  — the pick STAGES, the confirm posts
//    Same guarantee, same correlated predicate as settledClick — they share
//    armActionPost, because "did this interaction's action complete?" is one
//    question and a helper family must not answer it two ways (#1952).
//
// 1d. …and the action is the ACTIVITY EDITOR'S DELETE, behind a confirm:
//    → deleteActivityFromForm(page)
//    Two clicks and a settle, spelled once. The row is gone when the "Activity
//    deleted." toast lands, never when the dock or the panel stops rendering —
//    #3267 is the whole cost of confusing those, and it is a shared-fixture leak
//    rather than a red in the spec that leaks (see the helper).
//
// 2. The click is a NAVIGATION to another route (a Next `<Link>`/tab `<a href>`)
//    and the flake is the pre-hydration swallow (#500/#830):
//        → followLink(page, locator, /destination-url/)
//    It retries the click until the client router commits (and HOLDS) the URL.
//    Do NOT reach for networkidle "to let it hydrate first" — followLink already
//    tolerates the un-hydrated window by retrying.
//
// 2b. …but the control's navigation is RELATIVE — a pager's Next/Prev, a stepper,
//    anything whose handler reads the CURRENT state and moves one from it:
//        → hydratedClick(page, locator), then assert the destination URL.
//    followLink is for an IDEMPOTENT navigation: re-clicking a `<Link>` that
//    already committed asks for the same URL again, so its retry is free. A
//    relative control is the toggle case in navigation clothing — every extra
//    click moves the target one further, and once the URL passes the destination
//    the retry can never converge, so it clicks until the budget dies (#2437: a
//    pager's `p_medical_records=2` guard observed at `=11`, ten compounded
//    advances). hydratedClick closes the pre-hydration window WITHOUT a retry
//    loop, which is exactly what a non-idempotent control needs.
//
// 2c. The click must open the browser's NATIVE FILE CHOOSER (a camera/upload
//    trigger whose handler ends in a synchronous `input.click()`):
//        → primeCameraFallback(page) before the goto, then
//          capturePhotoFile(page, trigger, file)
//    A chooser is an EVENT, so the listener is armed and the tap taken under one
//    `Promise.all` — never armed with its own short timeout inside a retry loop,
//    which does not lengthen the window, it just re-runs the same too-short one.
//    The helper walks MediaInput's dialog to the button that opens the chooser,
//    so a caller no longer has to stage a camera precondition to reach it (#3286
//    made the file path reachable from every state; before it, the tap only
//    opened the picker synchronously for a session that already knew the camera
//    was unusable, and #2662 was filed about the modal that appeared otherwise).
//
// 3. Everything else — a pure client toggle, a value that settles in place, a
//    toast that appears — needs NO settle on the network. Assert it with a plain
//    auto-retrying `expect(locator).toBeVisible()` / `.toHaveText(...)`. Playwright
//    retries the assertion for you; that IS the wait. Reaching for a helper here
//    only hides which state you actually depend on.
//        → hydratedClick(page, locator) when the CLICK ITSELF can be lost — a
//          disclosure/chip/menu whose handler React may not have attached yet, and
//          which a retry loop would toggle back. Then assert what it revealed.
//        → openConfirm(page, trigger) for the specific case where that handler calls
//          `useConfirm()`. Same primitive, named for the thing it returns, and the
//          one home for why a confirm may NEVER be re-clicked: the hook settles an
//          in-flight request as CANCELLED when a second replaces it, so the retry
//          can cancel the dialog it is waiting for (#2729).
//    Do NOT reach for settledClick here. A client toggle posts nothing, so there is
//    nothing to settle on; before #1952 it appeared to work only because it accepted
//    a bystander's POST, which is the silent-green failure that issue is about.
//
// 3b. …but the write you just made TOASTED, and the next thing you click is in the
//    viewport's BOTTOM-RIGHT (a row's ⋯ trigger, a right-aligned actions cell):
//        → dismissToast(page, "…") first.
//    The toast stack is `fixed` down there and intercepts that click for its whole
//    auto-dismiss window — silently before #2859, as a named 15s timeout since
//    (#2861). Waiting it out is not a fix and neither is a bigger budget.
//
// 3c. The route draws LAZY CHARTS (`next/dynamic(ssr:false)`) above what you are
//    about to measure or drive:
//        → chartsSettled(scope, card, …) after the goto, before the first
//          boundingBox()/drag or the first portaled ⋯ menu round trip.
//    Chunk evaluation grows the layout under a test that already started; that is
//    #2839's hang (a fixed menu panel stranded off-viewport) and #2714's stale
//    coordinates, from one cause (#2862). settledBoxes is NOT this: it makes a
//    measurement atomic, it does not decide WHICH layout gets measured.
//
// 3d. The control is a row's ⋯ OVERFLOW MENU TRIGGER (`overflow-menu-trigger`, or
//    an "… actions" / "Actions for …" accessible name):
//        → hydratedClick(page, trigger), always — never a bare `.click()`.
//    The trigger is a pure client TOGGLE with no POST and no URL to watch, and it
//    is very often the first interaction after a navigation, so a tap that lands
//    pre-hydration is discarded in silence and the failure surfaces later as the
//    MENU ITEM not being found — which reads as "the menu is broken" rather than
//    "the trigger was never pressed" (#2942). The menu ITEM needs no such gate:
//    the panel only renders while `open` is true, so an item exists only because a
//    trigger click already landed, which is itself the proof that React attached.
//
// 4. toPass() is the LAST resort — only for a genuinely non-atomic condition that
//    none of the above expresses (e.g. re-open a flaky palette until its input
//    shows, `openCommandPalette` in nav.ts). Every toPass() MUST carry a comment
//    saying WHY a single expect can't express the wait; an un-commented toPass()
//    is a smell the guard's doc calls out.
//
// Anti-patterns this module retires:
//   • `waitForLoadState("networkidle")` as a readiness gate — it settles on a
//     quiet page but NOT on one with a long-poll/SSE/streaming request, and it
//     waits for the WRONG thing (network silence, not "my interaction landed").
//   • `waitForTimeout(ms)` as a settle — a fixed sleep is either too short (flakes
//     under CI contention) or too long (slows the suite); it asserts nothing.
//     (The ONE legitimate `waitForTimeout` is proving the ABSENCE of an effect —
//     e.g. "no autosave fired within the 700ms window"; those stay, allowlisted.)
//
// ── This module deliberately stays ONE file — insert ALPHABETICALLY (issue #1511) ─
// It is the settle-primitive CHOKEPOINT: splitting it would give the same wait two
// homes, which is exactly the drift it exists to prevent. What it does NOT have to
// be is an append magnet — every PR adding a helper used to land at the bottom, so
// unrelated PRs conflicted on the same trailing lines. The functions below are
// therefore ordered ALPHABETICALLY by name (private helpers included). Add a new
// one at its alphabetical position, never at the end.

// Change a control that AUTOSAVES, and return only once that write is DURABLE.
//
// The Settings convention (#794) is autosave-on-blur/change, and #1462 §6 folded the
// last explicit-Save settings card (the notification mega-card) into it. That removes
// the "click Save, then wait for Saved" idiom, and each obvious replacement is wrong
// on its own:
//
//   • Waiting for the `Saved` check: it LINGERS three seconds, so after two quick
//     edits it can still be showing from the FIRST save while the second is in flight
//     — and a following `page.reload()` aborts that write (the PR #586 class: the
//     value is LOST, not merely late). It is also absent entirely when the
//     interaction was a NO-OP (a checkbox already at its target value fires no change
//     event, so nothing saves and nothing confirms).
//   • Waiting for one same-origin POST (settledClick's arm): settledSelect and
//     settledCheck RETRY their interaction until React has hydrated, so one call can
//     fire several saves — and the next call's wait then resolves on a leftover
//     response while its own write is still open.
//
// What is actually reliable is the SPINNER's absence, scoped to the card: SaveStatus
// renders `Saving` for exactly as long as useSaveStatus' transition is pending, and
// that transition stays pending until the Server Action has RETURNED. So "no spinner
// in this card" means "no write outstanding" — and it is correct for a no-op too.
// The one hazard is looking before React has committed the pending render; two
// animation frames is that commit boundary (a real event, not a sleep).
async function awaitAutosaveSettled(scope: Locator): Promise<void> {
  await scope.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await expect(scope.getByLabel("Saving")).toHaveCount(0);
}

// Wait until React has ATTACHED to this node — the one hydration probe, shared.
//
// React tags every host node it owns with `__reactFiber$…`/`__reactProps$…`. Their
// presence is the difference between server HTML that merely looks right and a live
// tree with handlers on it, and it is the signal `hydratedClick` gates on. Kept in
// one place so a second caller cannot invent a slightly different probe — this is a
// TRUTH about React's DOM, and two spellings of it would drift.
// Wait until React has claimed this node — the probe behind hydratedClick.
//
// Exported because a coordinate TAP cannot go through hydratedClick: that clicks
// an element's centre, and a full-viewport scrim's centre is covered by the panel
// it dims, so the click would be refused for interception. The wait is the half
// that matters (#2742: a tap landing before the handler is live is swallowed with
// no error), so it is shared rather than copied into the spec.
export async function awaitHydrated(
  el: Locator,
  timeout = 10_000
): Promise<void> {
  await expect(el).toBeVisible();
  await expect(async () => {
    const hydrated = await el.evaluate((node) =>
      Object.keys(node).some(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")
      )
    );
    expect(hydrated, "element not hydrated yet").toBe(true);
  }).toPass({ timeout }); // topass-ok: polls for React's hydration markers on this node — a state, not an interaction; nothing is dispatched inside the loop
}

// Tap a <PhotoCapture> trigger and hand the native file chooser its bytes.
//
// ONE tap, no retry loop — and the reason is the whole of issue #2662.
//
// PhotoCapture's tap decision (`cameraStartDecision`) is not a constant, and an
// unprimed page does not sit on the easy side of it by construction:
// `navigator.mediaDevices.getUserMedia` EXISTS on this runner (localhost is a
// secure context) — what is missing is the camera — so a tap with
// `knowledge: "unknown"` takes `try-camera`, getUserMedia rejects, and the
// FALLBACK DIALOG opens instead of the chooser. Hence primeCameraFallback below:
// state the precondition before the goto instead of racing it.
//
// Re-driving this trigger is NOT free, which is what made the old
// `toPass`-around-a-1s-`waitForEvent` loop worse than no loop at all. The losing
// branch opens PhotoCapture's fallback MODAL, and ModalShell's `fixed inset-0`
// backdrop then intercepts pointer events on the trigger — Playwright's call log
// says so verbatim — so every later attempt is blocked on actionability, the
// listener it armed one second earlier rejects with nobody awaiting it, and the
// run dies on that unhandled rejection long before the loop's own 20s ceiling.
// A retry cannot converge on a control whose first attempt covers it up. Nor
// would a bigger per-attempt budget help: the branch that fails never opens a
// chooser at all, at any budget. Decision-tree case 2b — a non-idempotent
// control, so hydratedClick, which closes the pre-hydration window WITHOUT a
// retry loop.
// Hand files to a <MediaInput> through its real input and COMMIT them (#3286).
//
// `setInputFiles` alone is no longer the whole interaction: the shared surface
// stages what it was given, shows it per file, and waits for a confirm — which is
// what makes a batch a list of named things and a bad file nameable. A spec that
// only sets the files is asserting against a dialog that is still open.
export async function stageMediaFiles(
  page: Page,
  inputTestId: string,
  files: Parameters<Locator["setInputFiles"]>[0]
): Promise<void> {
  await page.getByTestId(inputTestId).setInputFiles(files);
  await hydratedClick(page, page.getByTestId("media-input-submit"));
}

export async function capturePhotoFile(
  page: Page,
  trigger: Locator,
  file: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
  await hydratedClick(page, trigger);
  // The trigger opens the DIALOG, not the chooser (#3286). Which stage it lands
  // on is the ordering decision — a phone-width viewport or a granted camera
  // gets the viewfinder — so step off it when that is where we are. Both stages
  // reach the file path; that is the property this walk depends on.
  const useFile = page.getByTestId("media-input-use-file");
  if (await useFile.isVisible()) await useFile.click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("media-input-choose").click(),
  ]);
  await chooser.setFiles(file);
}

// The centre of an element, in viewport coordinates — the natural place for a
// finger to land on it — measured only once the element has STOPPED MOVING.
//
// The settling is the whole point. Every surface a gesture spec wants to grab
// arrives on a 240ms slide, and a `boundingBox()` taken mid-animation is a
// position the element has already left: the coordinates go to CDP, the touch
// lands wherever the panel has since moved to, and the gesture is delivered to
// some other element entirely (a heading, the backdrop) with no error — the test
// just fails to do anything. Polling until two consecutive reads agree costs a
// few frames and removes the whole class.
//
// NOT EXPORTED, since #2714 — and that is the ratchet, not tidiness. Settling
// proves the element held still across ONE 50ms window; it cannot prove the
// element will not move AGAIN, so the point it returns is a fact about the past
// from the instant it is returned. A spec holding such a point and handing it to
// `touchSwipe` owns that staleness silently. The point therefore never leaves
// this file: an element-anchored gesture goes through `touchSwipeFrom`, which
// re-aims and then PROVES where the finger landed before it moves.
async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  let previous: string | null = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const box = await locator.boundingBox();
    const key = box
      ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`
      : null;
    if (box && key === previous) {
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    previous = key;
    await locator.page().waitForTimeout(50);
  }
  throw new Error("element never settled into a stable position");
}

// The chart-mount GATE: return only once a lazy-chart route's layout is done growing.
//
// SETTLING A READ IS NOT GATING A MOUNT, and #2862 exists because the two look alike.
// `settledBoxes` repeats a group of boxes until two consecutive reads AGREE — that
// makes every box come from one layout, which is the right cure for a torn relative
// measurement (#2437). It says nothing about WHICH layout. A lazy chart card sitting
// in its Suspense fallback is perfectly still: two reads 50 ms apart agree, the helper
// returns, and the caller measures a page that is still one card short. Quiescence is
// not the terminal state, and on a loaded worker the gap between them is tens of
// seconds. sleep-page already spells the division out at its own call site — the mount
// is behind `gotoSleepLogSettled`, and `settledBoxes` only keeps the measurement atomic.
// This is that gate, lifted out of sleep-page so every other lazy-chart route can have it.
//
// Every chart in the app is `next/dynamic(ssr: false)` behind a Suspense fallback
// (components/ChartLoading.tsx, "Loading chart…"). That is THREE renders of the same
// box, not one: nothing at SSR, the fallback at hydration, the chart itself at chunk
// evaluation. Each step changes the height of everything below it. Two different tests
// get hurt by that, and this is the one gate for both:
//
//   • A GEOMETRY read — a boundingBox() pair fed to a drag, an adjacency claim, a
//     height comparison — measures a layout that is still one card short. #2714's
//     class with a chart-mount trigger: the coordinates were true when they were read.
//   • A portaled ⋯ MENU round trip. OverflowMenu's panel is `position: fixed` and
//     glued to its trigger's rect; growth above the trigger slides it off-viewport,
//     `scrollIntoViewIfNeeded` cannot move a fixed element, and the pending click on
//     the menu item retries against `<html>` until the budget dies (#2839's hang; with
//     #2859's 15s actionTimeout it now fails NAMED instead, which is not the same as
//     fixed).
//
// WHY A POSITIVE SIGNAL PER CARD, and not just "no fallback on the page". The
// fallback's absence is true BEFORE hydration too — the server renders NOTHING in an
// `ssr:false` box — so an absence-only gate settles on the pre-hydration paint, which
// is the bystander false-settle (#1437) wearing a chart costume. So the caller NAMES
// at least one card this route really does draw, and `.recharts-wrapper` (the element
// recharts mounts around every chart it renders, and the signal sleep-page's own gate
// used) is waited for INSIDE it. That one positive proof establishes that hydration
// AND chunk evaluation happened; the scope-wide sweep for a remaining fallback
// afterwards then covers the route's OTHER lazy boxes without making the caller
// enumerate them.
//
// Name a card that DRAWS. A chart card with no data in the fixture renders an empty
// state and never mounts a wrapper, so naming it gates on something that will not
// happen and burns the full budget; pick a populated one — which is also the card
// whose mount moves the layout.
//
// A GRID of sparklines is one card for this purpose: pass the grid as BOTH the scope
// and the named card (`chartsSettled(grid, grid)`). One mounted wrapper anywhere in it
// proves the chunk evaluated, and the sweep then covers every remaining tile — which
// is what a grid whose populated members are fixture-dependent actually needs.
//
// WHEN NO CARD IS NAMEABLE — a route whose only chart widget draws or doesn't
// depending on the fixture's data — pass a LOCATOR scope and no cards. The helper
// then establishes the same precondition directly, by waiting for React's hydration
// markers on the scope element (the shared probe every settled interaction uses)
// before believing an absent fallback. What it will NOT accept is a Page scope with
// no card: there would be nothing to probe and nothing to wait for, and the call would
// return true against the server's first paint.
//
// The 20s budget is declared per hygiene pitfall 17: chunk evaluation under
// contention is exactly the latency the 5s default loses.
const CHART_MOUNT_TIMEOUT = 20_000;

export async function chartsSettled(
  scope: Page | Locator,
  ...cards: Locator[]
): Promise<void> {
  if (cards.length === 0) {
    if (!("first" in scope)) {
      throw new Error(
        "chartsSettled: a Page scope needs at least one named chart card — the " +
          "absence of a loading fallback is also true before hydration. Pass a " +
          "Locator scope instead to gate on that element's hydration."
      );
    }
    await awaitHydrated(scope, CHART_MOUNT_TIMEOUT);
  }
  for (const c of cards) {
    await expect(
      c.locator(".recharts-wrapper").first() // first-ok: proves THIS card mounted its chart at all; a card that draws two still takes one mount step
    ).toBeVisible({ timeout: CHART_MOUNT_TIMEOUT });
  }
  // The precondition above (a mounted chart, or a hydrated scope) is what makes this
  // an answer rather than a pre-hydration coincidence: any box still loading is still
  // showing ChartLoading's text.
  await expect(scope.getByText(/Loading chart/)).toHaveCount(0, {
    timeout: CHART_MOUNT_TIMEOUT,
  });
}

// Take a toast down before the next round trip, and prove it is gone (#2861).
//
// The toast layer is `fixed` on the viewport's bottom edge (components/Toast.tsx —
// `w-72` cards at the bottom-RIGHT from `md` up, one full-width bar below it since
// #3373; auto-dismiss at 6s for a success and 10s for an error). That is where a
// table's right-aligned actions cell lives and where an OverflowMenu panel opens, so
// the very next click after a write that toasted lands UNDER a card that is still
// up. Playwright's actionability then blocks on it — before #2859 the unbounded
// click simply absorbed the whole auto-dismiss window in silence (the sleep-page
// delete test was losing ~10s of every run, green CI included), and with the run-wide
// 15s actionTimeout the same collision fails NAMED:
//
//   locator.click: Timeout 15000ms exceeded … <p>…deleted.</p> from
//   <div class="fixed bottom-…"> subtree intercepts pointer events
//
// Never wait it out and never widen the budget: a click blocked by
// `<div class="fixed bottom-…">` is the toast, and the fix is to dismiss it.
//
// SCOPED BY TEXT, always. Toasts stack from `md` up, so "the toast" is not a thing —
// dismissing by testid alone would take down whichever card happened to be on top,
// which on an undo path is the one the NEXT assertion is about. Below `md` only the
// head of the queue is on screen, so the same filter is what tells you whether the
// toast you meant has had its turn yet. The filter also documents at the call
// site which write the test just made.
//
// The Dismiss button is a pure client control: it posts nothing, so this is
// `hydratedClick` and not `settledClick` (decision-tree case 3). The count assertion
// afterwards is the actual guarantee — the card is out of the DOM, not merely on its
// way out — and it is what makes this safe to call before a geometry read too.
//
// `timeout` budgets the ARRIVAL only. A toast a write raises is not up until that
// write has come back, so a caller whose action is slow under contention says how
// long it is prepared to wait for it — `deleteActivity` plus its revalidate on the
// dashboard routinely runs past the 5s default on a loaded shard (the receipt is in
// e2e/workout-presence.spec.ts, run 30663146216). The dismissal below keeps the
// default: once the card is on screen, taking it down is client-only work.
export async function dismissToast(
  page: Page,
  text: string | RegExp,
  opts: { timeout?: number } = {}
): Promise<void> {
  const toast = page.getByTestId("toast").filter({ hasText: text });
  await expect(toast).toBeVisible({ timeout: opts.timeout });
  await hydratedClick(page, toast.getByRole("button", { name: "Dismiss" }));
  await expect(toast).toHaveCount(0);
}

// Open the Upcoming page's display aggregates (issue #1504).
//
// The planning page folds a band's scheduled doses into one disclosure, its
// interaction + PGx notes into another, and its goal deadlines into a third
// (#2579-A), collapsed on every visit. A spec that asserts on an individual dose /
// interaction / PGx / goal ROW has to open the fold first — the rows are real and
// unchanged, they are just behind a <details>.
//
// Native <details>, so this needs no hydration and no server round-trip; it is
// idempotent (an already-open disclosure is skipped) and tolerant of a page with
// no aggregate at all, so a spec may call it unconditionally after navigating.
// Pass a `kind` to open only that class.
export type UpcomingAggregateKind = "dose" | "med-safety" | "goal";

export async function expandUpcomingAggregates(
  scope: Page | Locator,
  kind?: UpcomingAggregateKind
): Promise<void> {
  // Exact testids, never a `^=` prefix: the summary INSIDE each disclosure is
  // `upcoming-aggregate-summary-<kind>`, which a prefix match would also select —
  // and a <summary> has no <summary> of its own, so the loop would hang on it.
  const kinds: UpcomingAggregateKind[] = kind
    ? [kind]
    : ["dose", "med-safety", "goal"];
  const selector = kinds
    .map((k) => `[data-testid="upcoming-aggregate-${k}"]`)
    .join(", ");
  const aggregates = scope.locator(selector);
  const count = await aggregates.count();
  for (let i = 0; i < count; i++) {
    const disclosure = aggregates.nth(i);
    const open = await disclosure.evaluate(
      (el) => (el as HTMLDetailsElement).open
    );
    if (open) continue;
    const summary = disclosure.locator("summary");
    // Centre it before clicking. Opening one disclosure grows the page under the
    // next one, and at phone width the mobile shell's fixed bottom bar can sit over
    // wherever it lands — Playwright's own minimal auto-scroll then never reaches an
    // actionable hit target. Centring clears both bars at every viewport.
    await summary.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await summary.click();
    await expect(disclosure).toHaveJSProperty("open", true);
  }
}

// Open EVERY day group in a provider's sync history (#1991).
//
// The history is grouped by day and every day but the NEWEST renders collapsed, so a
// spec asserting on an individual run has to open the day it lives in first. Which
// day a fixture's UTC stamp lands on depends on the run's pinned timezone
// (e2e/pinned-timezone.ts), so open them all rather than naming one — and skip the
// already-open newest, because clicking that would CLOSE it.
export async function openAllSyncDays(scope: Page | Locator): Promise<void> {
  const days = scope.locator('details[data-testid^="sync-day-"]');
  const count = await days.count();
  for (let i = 0; i < count; i++) {
    const disclosure = days.nth(i);
    const open = await disclosure.evaluate(
      (el) => (el as HTMLDetailsElement).open
    );
    if (open) continue;
    const summary = disclosure.locator("summary");
    await summary.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await summary.click();
    await expect(disclosure).toHaveJSProperty("open", true);
  }
}

// Mobile clipped-content guard (issues #1063, #4534). The app shell deliberately
// clips horizontal overflow (`<main className="… overflow-x-clip">` in
// app/(app)/layout.tsx), so broken phone-width layouts never page-scroll — they
// render as INVISIBLE, unreachable content (copy/token buttons pushed off-screen).
// That also defeats the naive `document.scrollWidth > clientWidth` check: it
// reads 0 overflow on every page.
//
// WHAT IS PAINTED, NOT WHERE A BOX ENDS (#4534). The first cut of this asked only
// whether an element's right edge cleared the viewport, and "fits the viewport" is
// not "is visible": every `truncate` cluster in the tree is an `overflow: hidden`
// ancestor that cuts its children without moving their boxes, so a child sitting
// entirely inside the viewport can be painted at a third of its width while the
// box arithmetic looks fine. That is the #4394 shape — a silent cut inside a
// fitting box — and the guard covering it could not fail on it. So each element's
// box is intersected with every horizontally CLIPPING ancestor and with the
// viewport, and a failure reports PAINTED against BOX, naming the element that did
// the cutting: `right=563 vs viewport=320` is the right input for a box guard and
// reads as "243px is off-screen" on a page where the cluster had already cut it
// far shorter, which is how #4394's merge argument got inverted.
//
// WHAT IS EXCUSED, three different sentences:
//   * A WORKING SCROLLER that itself fits — the AGENTS.md "wide content scrolls
//     inside its own container" rule, made mechanical. The reader can move it, so
//     nothing is lost. A scroller that overflows only moves the problem up a level
//     and is reported in its own right.
//   * A SUBTREE THE LAYOUT GAVE NO ROOM. `width === 0` is a flex item starved to
//     nothing by its own shrink negotiation (`shrink-[999]` cells do this on
//     purpose); `<= 1` is the `sr-only` idiom, a 1px box with `overflow: hidden`.
//     Both are the existing "not rendered" skip read one level up — the layout
//     withheld the space, rather than a paint going wrong inside space it had.
//   * OFF-CANVAS BY DESIGN on either side — drawers and toasts parked outside the
//     viewport entirely, which is why the box is there at all.
//
// Call it AFTER the page's content is visible (assert a page-specific element
// first), with the viewport already at phone width. e2e/mobile-clipping.mobile.spec.ts
// forges each shape above and proves this can still see the cut and stay quiet on
// the rest.
export async function expectNoClippedContent(page: Page): Promise<void> {
  const offenders = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const TOL = 2;
    const bad: string[] = [];
    const name = (el: Element): string => {
      const id = el.getAttribute("data-testid");
      const cls = typeof el.className === "string" ? el.className : "";
      return (
        `<${el.tagName.toLowerCase()}${id ? ` data-testid="${id}"` : ""}` +
        `${cls ? ` class="${cls.slice(0, 80)}"` : ""}>`
      );
    };
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // not rendered
      if (r.left >= vw || r.right <= 0) continue; // fully off-canvas by design
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.opacity === "0") continue;
      // ONE ancestor walk: it both excuses the element and narrows what is left of
      // it. `lo`/`hi` are the surviving painted span, `cutBy` the nearest ancestor
      // that took part of it away — the thing a failure has to name.
      let lo = r.left;
      let hi = r.right;
      let cutBy: Element | null = null;
      let excused = false;
      for (let a = el.parentElement; a; a = a.parentElement) {
        const ar = a.getBoundingClientRect();
        if (ar.width <= 1) {
          excused = true;
          break;
        }
        const o = getComputedStyle(a).overflowX;
        if ((o === "auto" || o === "scroll") && ar.right <= vw + TOL) {
          excused = true;
          break;
        }
        if (o === "hidden" || o === "clip") {
          if (!cutBy && (ar.left > lo + TOL || ar.right < hi - TOL)) cutBy = a;
          lo = Math.max(lo, ar.left);
          hi = Math.min(hi, ar.right);
        }
      }
      if (excused) continue;
      const painted = Math.max(0, Math.min(hi, vw) - Math.max(lo, 0));
      if (painted >= r.width - TOL) continue;
      bad.push(
        `${name(el)} paints ${Math.round(painted)}px of its ` +
          `${Math.round(r.width)}px box (${Math.round(r.left)}→${Math.round(
            r.right
          )}), cut by ${cutBy ? name(cutBy) : `the viewport (${vw}px)`}`
      );
    }
    // Belt-and-braces: the PR #1249 document-level check too, for surfaces
    // outside the clipping app shell (share pages, print views).
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + TOL) {
      bad.push(
        `document scrollWidth=${doc.scrollWidth} vs clientWidth=${doc.clientWidth}`
      );
    }
    return bad.slice(0, 20);
  });
  expect(offenders, offenders.join("\n")).toEqual([]);
}

// The SVG half of the containment guard (issue #1573).
//
// `expectNoClippedContent` above walks DOM boxes, and that is exactly why it did
// not catch this: an SVG `<text>` that paints past its own plot is still inside a
// `<svg>` element whose box fits the viewport, so the element-level walk sees
// nothing wrong. #1573 was found by measuring — an annotation label at the right
// SIZE (10px, the #1445 floor) whose right edge landed at 449px against a 390px
// viewport, and same-row labels stacking into a smear.
//
// So every rendered `<text>` inside a chart is measured against BOTH bounds that
// matter: its own owning `<svg>` (the plot it belongs to) and the viewport. The
// layout that keeps them inside is computed in `lib/chart-svg.ts` (clampLabel /
// placeRowLabels); this is the browser-side proof.
//
// Call it after the charts are visible, at whatever viewport the case is about.
export async function expectSvgTextInsidePlot(page: Page): Promise<void> {
  const offenders = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const TOL = 2;
    const bad: string[] = [];
    for (const text of Array.from(document.querySelectorAll("svg text"))) {
      const box = text.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue; // not rendered
      const style = getComputedStyle(text);
      if (style.visibility === "hidden" || style.opacity === "0") continue;
      const owner = text.closest("svg");
      if (!owner) continue;
      const plot = owner.getBoundingClientRect();
      if (plot.width === 0) continue;
      const label = (text.textContent ?? "").trim().slice(0, 40);
      const id =
        owner.getAttribute("data-testid") ??
        owner.parentElement?.getAttribute("data-testid") ??
        owner.tagName;
      if (box.right > plot.right + TOL || box.left < plot.left - TOL) {
        bad.push(
          `"${label}" paints outside its plot (${id}): ` +
            `[${Math.round(box.left)}, ${Math.round(box.right)}] vs ` +
            `plot [${Math.round(plot.left)}, ${Math.round(plot.right)}]`
        );
      }
      if (box.right > vw + TOL || box.left < -TOL) {
        bad.push(
          `"${label}" paints outside the viewport (${id}): ` +
            `right=${Math.round(box.right)} left=${Math.round(box.left)} vs ` +
            `viewport=${vw}`
        );
      }
    }
    return bad.slice(0, 20);
  });
  expect(offenders, offenders.join("\n")).toEqual([]);
}

// The other half of #1573's sibling issue (#1518): a chart label at the right
// PLACE is still unreadable at 3.5px. Asserts every rendered chart `<text>` is at
// least `minPx` of real type — which for a scaled viewBox means measuring what the
// browser actually painted, not the number in the source.
export async function expectSvgTextLegible(
  page: Page,
  minPx = 9
): Promise<void> {
  const sizes = await page.evaluate(() => {
    const out: { label: string; px: number; owner: string }[] = [];
    for (const text of Array.from(document.querySelectorAll("svg text"))) {
      const box = text.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const owner = text.closest("svg");
      if (!owner) continue;
      const plot = owner.getBoundingClientRect();
      const viewBox = owner.getAttribute("viewBox");
      const units = viewBox ? Number(viewBox.split(/\s+/)[2]) : 0;
      // A viewBox font size is in USER UNITS; what it PAINTS at is that size
      // times the container ratio. Measure the painted size, which is the only
      // number a reader experiences.
      const declared = Number.parseFloat(getComputedStyle(text).fontSize);
      const px =
        units > 0 && plot.width > 0
          ? (declared * plot.width) / units
          : declared;
      out.push({
        label: (text.textContent ?? "").trim().slice(0, 30),
        px: Math.round(px * 100) / 100,
        owner: owner.getAttribute("data-testid") ?? owner.tagName,
      });
    }
    return out;
  });
  expect(sizes.length, "the page should be drawing chart text").toBeGreaterThan(
    0
  );
  const tooSmall = sizes.filter((s) => s.px < minPx);
  expect(
    tooSmall,
    `chart text below ${minPx}px effective size:\n` +
      tooSmall.map((s) => `"${s.label}" (${s.owner}) at ${s.px}px`).join("\n")
  ).toEqual([]);
}

// Follow a Next.js <Link> reliably, retrying the click until the client router
// actually commits the navigation.
//
// Root cause (issue #500): a click dispatched in the window AFTER React attaches
// the anchor's onClick handler (which calls preventDefault) but BEFORE the App
// Router transition is wired is SWALLOWED — the native navigation is cancelled and
// no soft navigation runs, so the URL never changes and the page stays put. That
// hydration window is normally sub-100ms, but under the CPU contention of a
// parallel run (`--workers>1`, and CI) it widens enough that a `click()` fired
// right after `goto()` intermittently lands in it. When it does, the URL never
// advances (verified: it stays on the source page indefinitely, not merely slow),
// so any assertion about the destination — e.g. the biomarker detail page's
// `derived-note` element, which simply never renders because the page never
// navigated there — fails. This is not a data/render race in the page itself; the
// destination renders correctly the moment the navigation lands.
//
// Guard the click behind a URL check and retry until the navigation sticks. The
// caller then asserts the destination's contents exactly as before — this makes
// the navigation robust without touching a single content assertion. This is the
// blessed replacement for the "networkidle-then-click" hydration gate: followLink
// tolerates the un-hydrated window by retrying, so no networkidle is needed.
export async function followLink(
  page: Page,
  link: Locator,
  destination: RegExp
): Promise<void> {
  await expect(link).toBeVisible();
  // Remember the most recent click failure so a navigation that never commits
  // reports the REAL underlying error (a broken selector, an overlay
  // intercepting the click) instead of a bare, causeless URL-match timeout
  // (#890). The blanket `.catch(() => {})` this replaced masked every click
  // failure as if it were the one benign race, so a genuinely-broken click
  // spent 25s retrying and then failed with no trace of why.
  let lastClickError: Error | undefined;
  // The URL the click is being retried FROM. Re-clicking is only ever justified
  // while the page is still standing on it: the two races this helper absorbs —
  // a swallowed pre-hydration click, and a transition that commits and then
  // unwinds — both leave the page on the source URL, so both are still covered.
  // A url() that is neither the source nor the destination means the click LANDED
  // and went somewhere else, and clicking again cannot walk it back. Before
  // #2437 the loop kept clicking anyway: on a RELATIVE control (a pager's Next)
  // every extra click moved the target one further, so a single overshoot past
  // the destination spent the whole 25 s budget compounding — a pager guarded on
  // page 2 was observed at page 11 — and reported it as a bare URL-match timeout,
  // which reads as latency and is why #2437's diagnosis came out as "the
  // transition did not commit in time" when the clicks had in fact all landed.
  //
  // Captured lazily, at the first click rather than here, because a page can
  // move its OWN url at hydration — `RangeFilterSelect` restores a remembered
  // `range` param from sessionStorage in a mount effect — and a baseline taken
  // before that lands would read as a departure the helper never caused, and
  // refuse to click at all. The guard is about "did MY click move the page", so
  // it may only arm once a click has actually been issued.
  //
  // "Departed" is judged WITHOUT the fragment. A hash-only move is not a
  // navigation at all: same document, same tree, and the pre-hydration swallow
  // this helper exists for is still live, so re-clicking is still both safe and
  // necessary. Pages here write their own hash — `/training` lands on
  // `/training#day-2026-08-09` — and comparing whole URLs treated that as a
  // departure and refused to click a ride link that had never been clicked
  // (shard 5, e2e (5), the first CI run of this change). A pager step moves the
  // SEARCH and a route change moves the PATHNAME, so both still register; only
  // the one case where nothing navigated is forgiven. (A stepper that advances
  // purely in the fragment would slip through this — none exists here, and it
  // would be a strange thing to build.)
  let source = page.url();
  let clicked = false;
  let departedTo: string | undefined;
  const withoutHash = (url: string): string => url.split("#")[0];
  try {
    await expect(async () => {
      if (!destination.test(page.url())) {
        if (clicked && withoutHash(page.url()) !== withoutHash(source)) {
          // Left the source for a third URL: stop clicking, keep waiting. A
          // redirect chain or a slow multi-hop transition still converges on its
          // own; anything else fails at the ceiling with both URLs named below.
          departedTo = page.url();
        } else {
          // Back on the source URL (or never left it) — the click is live again,
          // so a departure recorded by an earlier iteration is stale.
          departedTo = undefined;
          // Re-baseline until the first click: everything up to here is the
          // page moving itself, which this guard has no opinion about.
          if (!clicked) source = page.url();
          try {
            clicked = true;
            await link.click({ timeout: 2000 });
          } catch (err) {
            lastClickError =
              err instanceof Error ? err : new Error(String(err));
            // The ONE benign, expected race is a click on a link a PRIOR
            // iteration already navigated away from: the old element is
            // detached, and this same iteration's URL check below will observe
            // the destination and pass — so swallow it and fall through. EVERY
            // other click failure (a wrong/ambiguous selector, an overlay
            // intercepting the click, a disabled or pointer-events:none target,
            // a stubborn click timeout) is rethrown into toPass. toPass still
            // retries — tolerating a genuine transient — but its final timeout
            // now carries this error, and the catch below names it explicitly,
            // so a broken click fails with a useful message rather than
            // masquerading as a URL-match timeout.
            if (!isDetachedElementError(lastClickError)) throw lastClickError;
          }
        }
      }
      // The navigation must have STUCK, not merely flipped. The same hydration
      // race can commit the client transition optimistically — the URL advances
      // to the destination — and then unwind back to the source route as
      // hydration finishes, so a single url() check can pass on a navigation
      // that reverts and leave the caller asserting against the source page.
      // Require the destination URL to hold across a short settle; a revert
      // fails the recheck and toPass re-clicks. (The waitForTimeout here is
      // INSIDE the helper — the one blessed home for it — never in a spec.)
      expect(page.url()).toMatch(destination);
      await page.waitForTimeout(500);
      expect(page.url()).toMatch(destination);
    }).toPass({ timeout: 25000, intervals: [300, 700, 1500, 3000] });
  } catch (err) {
    // The navigation never committed within the budget. Say WHICH of the two
    // shapes it was, so the failure names its own cause instead of leaving the
    // reader to infer latency from a bare "url never matched" (#890/#2437).
    const wrapped = err instanceof Error ? err : new Error(String(err));
    if (departedTo) {
      // The click landed and took the page somewhere that is not the
      // destination. Not latency: no amount of waiting or re-clicking reaches
      // the destination from here, and on a relative control (a pager step) the
      // re-clicking is what carried it past.
      wrapped.message =
        `${wrapped.message}\n\n[followLink] the click LANDED but the page left ` +
        `${source} for ${departedTo} instead of ${destination}, so the link was ` +
        `not re-clicked. If this control's navigation is RELATIVE (a pager's ` +
        `Next/Prev, a stepper), followLink is the wrong helper — it may only ` +
        `retry an idempotent navigation; use hydratedClick + a URL assertion.`;
      throw wrapped;
    }
    // If a click failed along the way, surface it — otherwise the caller sees
    // only "url never matched", which is exactly the causeless timeout #890 is
    // about.
    if (lastClickError) {
      wrapped.message =
        `${wrapped.message}\n\n[followLink] navigation to ${destination} never ` +
        `committed; the last click on the link failed with:\n${lastClickError.message}`;
      throw wrapped;
    }
    throw err;
  }
}

// Click a pure CLIENT TOGGLE exactly once, after React has hydrated it — the
// button analog of settledFill/settledCheck.
//
// Decision-tree case 3 covers most client-only clicks: assert the effect with a
// retrying `expect` and you're done. This helper is for the sub-case where the
// click itself can be LOST: a tap dispatched before React attaches the button's
// `onClick` (the #500/#830 hydration window, widened under `--workers>1`/CI load)
// does nothing at all, and there is no POST to await and no URL to watch, so a
// following `expect` just times out.
//
// openMobileDrawer solves that by RE-TAPPING until the drawer mounts, which is
// only safe because its More slot sets `open` TRUE and never toggles. A real
// TOGGLE (the #1455 "Custom…" pill, the digest's "Show all N") flips state, so a
// second tap UNDOES the first — a retry loop there is a coin flip. Instead: wait
// for the hydration markers React attaches to the DOM node, then click ONCE.
//
// WORKS for a client-state button whose effect is a re-render (a disclosure, an
// expander). For a click that fires a Server Action use settledClick; for one that
// navigates use followLink.
//
// DOES NOT WORK ON A FULL-VIEWPORT SCRIM, and the reason is structural rather
// than incidental: this clicks the element's CENTRE, and an overlay's backdrop is
// dimming a panel that sits over its own middle, so the click is refused for
// interception by whatever it dims. Reach for `awaitHydrated` (exported just
// above) and then dispatch the tap at a coordinate the panel cannot cover — the
// wait is the half that matters, and it is the half this shares. #2774's
// e2e/dialog-convergence.mobile.spec.ts is the worked example: the same tap,
// unwaited, was swallowed in CI three runs running with the scrim proven under
// the finger and the handler never firing.
export async function hydratedClick(
  page: Page,
  button: Locator,
  opts: { timeout?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 10_000;
  // The probe retries; the click below runs ONCE, after the handler is attached, so
  // the toggle can never be double-fired.
  await awaitHydrated(button, timeout);
  await button.click();
}

/** Opens the dashboard's remembered exhaustive remainder when it exists. */
export async function openDashboardAll(page: Page): Promise<void> {
  const details = page.getByTestId("dashboard-all");
  await expect(details).toHaveCount(1);
  if ((await details.getAttribute("open")) == null) {
    await hydratedClick(page, details.locator("summary"));
  }
  await expect(details).toHaveAttribute("open", "");
}

// Playwright surfaces a click on a link that a prior iteration already navigated
// away from as an "element is not attached to the DOM" / "detached" error. That
// is the ONE race followLink is allowed to swallow (the next URL check passes);
// every other click failure must reach the caller.
function isDetachedElementError(err: Error): boolean {
  return /not attached|is detached|element was detached/i.test(err.message);
}

// Open one of Care › Overview's <details> disclosures and return it (issue #2231).
//
// The four sections are native `<details>` (#1804), so a spec that wants anything
// inside one has to open it — and each save revalidates the server tree, which comes
// back CLOSED, so it has to re-open it every time.
//
// The hazard is that "is this section open?" has TWO writers. Besides the summary,
// CareOverviewDisclosure opens the section the URL hash names, imperatively, from an
// effect that runs at HYDRATION. So a spec that reads `open` once and then clicks is
// racing that effect: the read says closed, the effect flips `open` true while the
// click is still running its actionability checks, and the click's native toggle then
// CLOSES what the effect just opened. The spec is left asserting against a collapsed
// section for the whole timeout — the #2231 flake, which hit two unrelated branches
// ~14h apart, neither of which touched the spec.
//
// No POST and no navigation, so there is nothing to settle on: decision-tree case 4,
// the visibility-guarded retry loop (openMobileDrawer's shape). A `<details>` is a
// real TOGGLE, so the loop is only safe BECAUSE it is guarded on the element's own
// `open` — an already-open section is never clicked shut. The hydration effect is
// one-shot, so losing that race can cost at most one extra iteration.
export async function openCareOverviewSection(
  page: Page,
  testId: string
): Promise<Locator> {
  const section = page.getByTestId(testId);
  await expect(section).toBeVisible();
  await expect(async () => {
    const open = await section.evaluate(
      (el) => (el as HTMLDetailsElement).open
    );
    if (!open) await section.locator("summary").click();
    await expect(section).toHaveJSProperty("open", true, { timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-toggle a <details> whose hash-reveal effect races the click — a native disclosure with no POST and no navigation to settle on; guarded on `open`, so an already-open section is never clicked shut
  return section;
}

// Tap a control whose handler calls `useConfirm()`, and return the confirm dialog
// (issue #2729).
//
// A confirm is opened by a DISCRETE onClick with nothing to settle on: no Server
// Action POST, no navigation, no URL. So a tap that lands in the #500/#830
// pre-hydration window is swallowed in silence — Playwright's actionability checks
// all pass, because the ELEMENT is fine — and the `expect(dialog).toBeVisible()`
// below it fails as `element(s) not found`.
//
// Five call sites answered that with a `toPass` loop that re-clicked the trigger
// until the dialog appeared. The premise was right and the repair was not. What is
// wrong with it was MEASURED, under a CDP CPU throttle (docs/internals/e2e-hygiene.md,
// "slow the CPU, not the neighbours"), and it is not what #2729 assumed:
//
//   • The loop spends its whole BUDGET on the window it exists to survive. A
//     pre-hydration click is swallowed, so it changes nothing — which also means it
//     cannot converge and cannot be retried into working. Every iteration before
//     hydration is therefore a click into the void plus the inner guard's 2 s wait,
//     and the 15 s ceiling is consumed by attempts that could not have worked. At a
//     60× throttle on `/import/908` that loop failed 5/5; given a 60 s ceiling and
//     nothing else changed it passed 5/5, converging in 10.8–23.9 s. Its failure is
//     the CEILING. Waiting for a STATE spends the budget on the thing being waited
//     for, which is why this helper converges where the loop cannot.
//   • The destructive branch is a HAZARD, not the observed cause, and the difference
//     matters. `useConfirm` settles an in-flight request as CANCELLED when a second
//     replaces it (`prev?.resolve(false)`, components/ConfirmDialog.tsx) and remounts
//     the panel on a fresh `retained.nonce`; the disclosure twins of this loop are
//     `setOpen((v) => !v)` and a native `<details>`. So a click that LANDS and then
//     renders slower than the inner guard is torn down by the iteration waiting for
//     it. That is real by inspection — but across 15 throttled trials it was never
//     observed: a MutationObserver on the disclosure's `aria-expanded` recorded a
//     single `false → true` transition every time, never a flip back. It is a live
//     hazard because it needs only a landed click and a slow render, and it is not
//     the thing that has been failing.
//
// A third reason is not about the race at all: the loop SWALLOWS its own diagnosis.
// Whatever goes wrong inside the predicate — the trigger missing, a backdrop
// intercepting the tap, the click throwing — is reported as one line, `Timeout
// 15000ms exceeded while waiting on the predicate`, naming neither the click nor the
// dialog. That is the causeless-timeout shape #890 is about, and it is what the two
// failures in #2729 were read through. Clicking once lets the click's own error, or
// the dialog locator, name the failure.
//
// So: hydratedClick — poll for React's markers on the node, click ONCE — then wait
// for the dialog on its own ceiling. No re-click, at any point. The marker probe is a
// reliable enough hydration signal to make that single click safe and a fallback
// unnecessary, on two separate pieces of evidence. The direct one is this issue's own
// measurement: the disclosure twin of this helper passed 5/5 at a 60× CPU throttle at
// its shipped budget, where the loop it replaced passed 1/5. The precedent — a
// DIFFERENT spec, not one of these call sites — is #2742's tap, which the same probe
// carried from a deterministic throttled failure to 5/5.
//
// The two ceilings are separate because they are separate waits, and 15 + 15 is
// deliberately the whole per-test budget: `playwright.config.ts` sets no `timeout`,
// so a test gets Playwright's default 30 s unless it declares `test.slow()`. Past
// that the test dies whatever this helper says, so a bigger number here would only
// look generous. The one real lever is `test.slow()` at the call site, which triples
// the budget — declined for the four long portal tests, because all it buys is a
// better cell in a rate-60 table that is already past CI-realistic (the table is in
// docs/internals/e2e-hygiene.md). Do not re-derive this: the ceiling IS the budget.
//
// Returns the dialog by its `confirm-dialog` testid rather than `getByRole("dialog")`
// — a page may carry another modal, and this helper promises THE confirm.
export async function openConfirm(
  page: Page,
  trigger: Locator,
  opts: { hydrationTimeout?: number; dialogTimeout?: number } = {}
): Promise<Locator> {
  await hydratedClick(page, trigger, {
    timeout: opts.hydrationTimeout ?? 15_000,
  });
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: opts.dialogTimeout ?? 15_000 });
  return dialog;
}

// Delete the activity the form is holding, and do not return until the SERVER has
// done it (issue #3267).
//
// THE DOCK GOING AWAY IS NOT THE ROW GOING AWAY, and that gap is the whole defect.
// Every call site used to spell the discard the same way — click Delete, click the
// confirm's Delete, then assert a CLIENT fact: `workout-dock` reaches count 0, or the
// live panel unmounts, or nothing at all. None of those observe the write. The dock
// clears from `leaveDeletedActivityPage`, a `setState` in
// components/ActivityEditorProvider.tsx, so `toHaveCount(0)` is satisfied by the
// browser alone and says nothing about whether `deleteActivity` has run — or, on a
// loaded shard, whether it has even been DISPATCHED yet.
//
// That is what #3267 is. The shared-profile guard (e2e/shared-profile-guard.ts) reads
// the worker DATABASE in teardown, so it sees the row the client had already stopped
// drawing, and it fails the spec that started the session — correctly. The failure
// therefore arrives with a GREEN BODY: the decisive CI sighting (PR #3269, whose diff
// is a JSON data file and an orchestration script, `e2e (2)`) reported `1 failed`
// with the only annotation at `fixtures.ts:248` and every assertion in the spec
// passed. There was no timed-out click to find, which is why reading the guard's own
// advice — "dispose the draft from a `finally`" — would have silenced a guard that
// was telling the truth and left the race running.
//
// MEASURED, by holding every Server Action response for 2s with `page.route` and
// tracing the writes against the worker DB (`workout-resume.mobile.spec.ts`):
//
//   +2525ms  the confirm is clicked            rows on profile 1: []
//   +3720ms  the create-at-start POST returns  rows: [216]      ← the draft exists
//   +4272ms  `expect(dock).toHaveCount(0)` passes — THE SPEC ENDS HERE TODAY
//   +5780ms  the deleteActivity POST is issued  (id=216)
//   +7824ms  it returns                        rows: []
//
// The spec finished a second and a half before its own delete left the browser. On a
// quiet box those five lines collapse into ~400ms and everything is green, which is
// exactly why this failed only on loaded CI shards and only on other people's PRs.
//
// THE SETTLE IS THE TOAST, and it is a server fact rather than a proxy for one:
// `useUndoableDelete` (components/useUndoableDelete.ts) announces "Activity deleted."
// only after `await action(fd)` has resolved, so the card being on screen means the
// row is gone. Taking it down again is the #2861 rule — a `fixed` bottom-right card
// intercepts the next click — and it is free for a caller that ends right after.
//
// A `waitForURL(/\/training/)` after the discard is the same guarantee by a different
// route (`leaveDeletedActivityPage` navigates only once `onDeleted` has fired) and
// stays where specs already have it. It is not AVAILABLE everywhere: a discard driven
// from the app-wide dock leaves the URL where it was, so those call sites had no
// server-side signal at all. This one works at every call site, which is what makes it
// the shared spelling rather than a sixth local pair of clicks.
//
// `trigger` scopes the Delete affordance for a page that carries its own per-row
// Delete controls behind the editor (e2e/bottom-edge-stacking.mobile.spec.ts opens the
// dock over Equipment); it defaults to the editor footer's, which is the only Delete
// on screen everywhere else.
export async function deleteActivityFromForm(
  page: Page,
  opts: { trigger?: Locator } = {}
): Promise<void> {
  const trigger =
    opts.trigger ?? page.getByRole("button", { name: "Delete", exact: true });
  const dialog = await openConfirm(page, trigger);
  // The confirm's own button is React-rendered the moment the dialog mounts, so it
  // is hydrated by construction — openConfirm already spent the hydration wait on
  // the trigger, which is the control that could have been server HTML.
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dismissToast(page, "Activity deleted.", { timeout: 30_000 });
}

// Open MobileNav's slide-in drawer and return it (issue #1420 — the `mobile`
// Playwright project's one shared interaction). The drawer is the phone shell's
// only route to the app's navigation: below `md` the desktop sidebar is hidden and
// the drawer's <aside> isn't even MOUNTED until the dock's More slot is tapped
// (components/MobileNav.tsx renders it behind `{open && …}`), so a mobile spec that
// needs a nav link has to open it first.
//
// The tap fires NO Server Action and NO navigation — it's a pure `setOpen(true)`
// client toggle — so neither settledClick nor followLink applies, and a tap landing
// in the pre-hydration window (#500/#830) is silently swallowed with nothing to
// await. This is decision-tree case 4: re-tap until the drawer mounts, guarded on
// its visibility. Re-tapping is safe because More only ever sets `open`
// TRUE (it never toggles), so a late tap can't close what a prior one opened.
export async function openMobileDrawer(page: Page): Promise<Locator> {
  // The drawer <aside> is identified by the close (✕) button that ONLY it renders
  // (SidebarContent's `onClose` prop is set for the drawer, not the desktop
  // sidebar), so this can never resolve to the hidden desktop sidebar.
  const drawer = page.locator("aside", {
    has: page.getByRole("button", { name: "Close menu" }),
  });
  await expect(async () => {
    if (!(await drawer.isVisible())) {
      await page.getByTestId("dock-slot-more").click();
    }
    await expect(drawer).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap More past the pre-hydration swallow — a pure client toggle with no POST/navigation to settle on; set-true-only, so a late tap can't re-close it
  return drawer;
}

// Open one of the "Log measurements" form's disclosure groups (issue #2014).
//
// The form shows exactly ONE group on mount — chosen by the entry point — so a spec
// that fills a field in another group has to open it first. Opening is a pure client
// toggle with no POST and no navigation, and it is a real TOGGLE (a second click
// closes it), so a retry loop would be a coin flip: this is the hydratedClick case —
// wait for React's markers on the button, click ONCE, then assert.
//
// Idempotent by inspection, not by re-clicking: an already-open group is left alone,
// so a spec can call it without knowing which group its entry point opened.
export async function openMeasurementGroup(
  page: Page,
  form: Locator,
  group: "vitals" | "body" | "sleep"
): Promise<void> {
  const fields = form.locator(`#measurements-group-${group}-fields`);
  if (await fields.isVisible()) return;
  await hydratedClick(
    page,
    form.getByTestId(`measurements-group-${group}-toggle`)
  );
  await expect(fields).toBeVisible();
}

// Stage this browsing context as one with NO camera API at all, BEFORE the page
// loads — the device class MediaInput's own header names first ("PWA-safe, CI,
// older devices").
//
// Two specs used to ASSUME this ("No getUserMedia in CI") and it was false:
// `navigator.mediaDevices.getUserMedia` exists on a headless runner because
// localhost is a secure context — what is missing is the camera. Staging the
// device removes the question rather than narrowing it: `mediaStartStage` reads
// `hasGetUserMedia` SYNCHRONOUSLY at tap time, from a value this init script has
// already fixed before any document script ran, so the opening stage is decided
// with no async input anywhere. The `knowledge: "failed"` route to the same
// stage is a true statement about the runner too, but its precondition arrives
// from a mount effect (a sessionStorage read, then a
// `navigator.permissions.query` promise), and "that effect has flushed" is not
// something a tap can prove.
//
// SINCE #3286 THIS IS A CONVENIENCE, NOT A PRECONDITION, and the difference
// matters when reading a spec that calls it. The file path is reachable from
// every stage now — an unprimed desktop tap lands on the chooser, and even the
// viewfinder offers "Choose a file instead" — so priming buys determinism about
// WHICH stage opens, not access. `mediaStartStage`'s full matrix is unit-covered
// in lib/__tests__/camera-fallback.test.ts, and the camera-attempt shapes
// (denied → recovery guidance under the camera option, no hardware → its own
// line) have their own browser test in progress-photos.spec.ts, which stages
// `navigator.mediaDevices` the same way.
//
// Call it before the navigation that renders the capture surface — an init script
// applies to every subsequent navigation on the page, not to the current
// document. A spec that wants the OPPOSITE state simply does not call it.
export async function primeCameraFallback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
  });
}

// The identity bar's view-set readout (issue #1801).
//
// The multi-profile view used to be asserted through ProfileViewStrip's chips;
// the strip is gone and the identity bar carries the same information, so the
// strip-era assertions moved onto this helper. `data-view-count` is how many
// profiles are currently IN VIEW, acting included — 1 is the single-view default
// every session starts in.
//
// ONE mount, since #4102. There used to be two — `profile-identity-bar` in the
// desktop sidebar and `profile-identity-bar-mobile` in the phone top bar — and the
// helper picked between them. The top bar retired; the bar now sits at the top of
// the More drawer and is the SAME sidebar-surface mount, so there is nothing to
// choose any more.
//
// `within` scopes the lookup, and below `md` it is required rather than tidy: the
// desktop sidebar is hidden by a breakpoint but still in the DOM, so at phone width
// the bare testid resolves to two elements and an unscoped locator is a strict-mode
// violation. Pass the open drawer.
export async function expectInView(
  page: Page,
  count: number,
  opts: { within?: Locator } = {}
): Promise<void> {
  await expect(
    (opts.within ?? page).getByTestId("profile-identity-bar")
  ).toHaveAttribute("data-view-count", String(count));
}

// Wait out an element's OWN CSS animations before measuring it (#3373).
//
// This is `settledBoxes`' rule for a different source of motion. Since the toast
// bar joined the overlay motion convergence it ARRIVES — `overlay-slide-up-in`
// over `--overlay-ms` — so a box read the instant it becomes visible is a box read
// mid-flight. Measured, not theorised: `bottom-edge-stacking.mobile` read the bar
// ~46px low and reported a bottom edge of 833 against a dock top of 787, which is
// indistinguishable from the bottom-edge claim being broken. It failed sometimes
// and by the SAME amount every time — the signature of a real quantity measured at
// an unstable moment, not of noise.
//
// It waits on the ANIMATION rather than widening a tolerance, so an element that
// genuinely does sit over the bar still fails. An element with nothing running
// (reduced motion, or a keyframe that has already finished) resolves immediately,
// and a cancelled animation rejects `finished` — caught, because a cancelled
// animation is also "not running any more".
export async function settledAfterAnimation(target: Locator): Promise<void> {
  await target.evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})))
  );
}

// Measure SEVERAL elements as ONE consistent layout snapshot — the group analog of
// centerOf, and the only honest way to assert a RELATIVE geometry (this card sits
// one gap below that one, these two columns share an x).
//
// `await Promise.all([a.boundingBox(), b.boundingBox(), …])` looks atomic and is
// not: each box is a separate CDP round-trip, and the page keeps laying out
// between them. So a card whose chart sizes itself after mount can be measured
// SHORT while the card below it is measured at its FINAL, lower y — and the gap
// computed from those two reads belongs to no layout that ever existed. It is
// then handed to a plain numeric `expect(...)`, which cannot retry, so the run
// fails on a measurement rather than on the product. That is #2437's
// `sleep-page:246`: a 20–28 px gap window read as wider than 28 while the
// duration card was still growing, on a shard where two workers competed for the
// CPU that lays it out.
//
// Two consecutive passes that agree is centerOf's rule, applied to the whole
// group: it costs a few frames, it returns as soon as the page is quiet, and
// every box it returns comes from the same settled layout. A null box (the
// element is detached or `display:none`) is never a settled reading — it throws,
// so callers get non-null boxes and need no `!`.
export async function settledBoxes(
  locators: Locator[],
  opts: { timeout?: number } = {}
): Promise<{ x: number; y: number; width: number; height: number }[]> {
  const deadline = Date.now() + (opts.timeout ?? 10_000);
  const page = locators[0].page();
  let previous: string | null = null;
  for (;;) {
    // Each read is bounded by THIS helper's remaining budget and a never-attaching
    // locator degrades to null instead of throwing, so the deadline below stays
    // authoritative: without the bound, `boundingBox()` on a locator that resolves
    // to nothing waits at the action default and the named diagnosis under it is
    // never reached (#2839 — the deadline check only ran between reads, so a read
    // that never returned made the "deadline" a fiction).
    const remaining = Math.max(100, deadline - Date.now());
    const boxes = await Promise.all(
      locators.map((l) =>
        l.boundingBox({ timeout: remaining }).catch((err: Error) => {
          // Only the never-attached shape becomes null (the deadline check below
          // names it); a closed page or crashed target keeps its own error.
          if (err.name === "TimeoutError") return null;
          throw err;
        })
      )
    );
    const key = boxes
      .map((b) =>
        b
          ? `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`
          : "none"
      )
      .join("|");
    if (boxes.every((b) => b !== null) && key === previous) {
      return boxes as { x: number; y: number; width: number; height: number }[];
    }
    if (Date.now() > deadline) {
      const missing = boxes
        .map((b, i) => (b ? null : i))
        .filter((i) => i !== null);
      throw new Error(
        missing.length > 0
          ? `[settledBoxes] locator(s) at index ${missing.join(", ")} have no ` +
              `bounding box (detached or not displayed) after ${opts.timeout ?? 10_000}ms`
          : `[settledBoxes] the layout never held still: last two reads were\n` +
              `${previous}\n${key}`
      );
    }
    previous = key;
    await page.waitForTimeout(50);
  }
}

// The per-side reach a coarse pointer actually got around each target, READ BACK
// FROM THE BROWSER rather than inferred from a class list (#3938). The reach lives
// under `@media (pointer: coarse)`, so whether it arrived is a rendered fact; and a
// `<select>` or `<input>` renders no pseudo-element at all, which is why the floor
// is stated as effective and some targets legitimately return 0.
//
// PER AXIS, because one axis is where a tiled control's reach lives (#3954). A
// segmented track's options and a calendar's day cells sit shoulder to shoulder
// with no gap to spend, so their reach is block-only — reading `top` and calling
// it the reach on both axes would credit a tiled control with 12px of inline
// target it does not have, which is the flattering direction.
type Reach = { block: number; inline: number };
async function renderedReach(targets: Locator[]): Promise<Reach[]> {
  return Promise.all(
    targets.map((target) =>
      target.evaluate((el) => {
        const after = getComputedStyle(el, "::after");
        if (after.content === "none") return { block: 0, inline: 0 };
        const side = (raw: string) => {
          const inset = Math.abs(Number.parseFloat(raw));
          return Number.isFinite(inset) ? inset : 0;
        };
        return { block: side(after.top), inline: side(after.left) };
      })
    )
  );
}

// THE CONTROL BOX IS A FLOOR PLUS WHOLE LINE BOXES, NOT AN IDENTITY (#3938).
//
// The box spends what the element's OWN line box leaves over
// (`padding-block: calc((--control-box - 1lh - 2 * --control-border) / 2)`), and
// that one derivation has two consequences a straight equality gets wrong in
// opposite directions:
//
//   * the line box is the CEILING on the tallest child a control can hold — an
//     18px badge or a 20px glyph inside a 16px line grows the control past 34,
//     which shipped as a 40px button beside its 34px neighbours;
//   * the line box is also the QUANTUM by which a control grows — a summary that
//     WRAPS at 768 renders 54, which is 34 + one more 20px line, and that is the
//     construction working rather than a defect.
//
// So a control that can wrap (`whitespace-normal`, a long label in a narrow
// column) is asserted as the box plus a WHOLE NUMBER of its own line boxes. That
// still reds on a stray `py-*`, a rogue `min-h-11` or any ad-hoc padding —
// everything the equality was protecting — and only stops calling a second line a
// failure. A control that is single-line by construction (`whitespace-nowrap`, an
// `<input>`) passes `lines: 0` and keeps the stronger claim.
export async function expectControlBoxHeight(
  target: Locator,
  name: string,
  opts: { lines?: 0 | "any" } = {}
): Promise<void> {
  await expect(target, name).toBeVisible();
  const measured = await target.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight),
  }));
  expect(
    Number.isFinite(measured.lineHeight) && measured.lineHeight > 0,
    `${name} has no resolvable line box, so the control box cannot be derived`
  ).toBe(true);
  const extra = (measured.height - CONTROL_BOX_PX) / measured.lineHeight;
  const lines = roundControlBoxExtraLines(extra);
  const detail =
    `${name} renders ${measured.height}px with a ${measured.lineHeight}px line box: ` +
    `${CONTROL_BOX_PX} + ${extra.toFixed(3)} line boxes`;
  expect(
    Math.abs(extra - lines) <= 0.02 && lines >= 0,
    `${detail}. A control is the control box plus a WHOLE number of its own line ` +
      "boxes — a fraction of one means ad-hoc padding or a height a call site set " +
      "itself, which is the drift the box exists to close."
  ).toBe(true);
  if (opts.lines === 0)
    expect(
      lines,
      `${detail}, so it is on ${lines + 1} lines. This control is single-line by ` +
        "construction, so a second line is the defect and not the wrap."
    ).toBe(0);
}

// A compact rendered-geometry assertion for primitive-owned phone targets. It
// reads one settled layout snapshot, checks the actual boxes (not class names),
// and optionally proves adjacent boxes do not overlap.
//
// THE FLOOR IT CHECKS IS EFFECTIVE, NOT RENDERED (owner ruling #3938). Every
// control renders the 34px box; a coarse pointer gets the rest of the 44 back as
// reach around it. So the height/width assertions add the measured reach, while
// VIEWPORT CONTAINMENT stays on the rendered box — a hit region may hang over the
// page edge, a visible control may not — and DISJOINTNESS moves to the effective
// box, because two hit regions owning the same point is the defect the gap floor
// (twice the reach) exists to prevent.
//
// AND THE FLOOR IT DEMANDS DEPENDS ON THE POINTER, WHICH IS READ FROM THE PAGE
// RATHER THAN ASSUMED. 44 is a THUMB's floor; the reach that supplies it lives in
// `@media (pointer: coarse)`. Most callers here set a phone viewport in the
// desktop project, where Chromium reports a FINE pointer and no reach exists — so
// demanding 44 there would fail every correct control in the app for a reason
// that has nothing to do with the control. On a fine pointer the claim is the one
// the ruling actually makes: the control renders the box.
export async function expectPhoneTapTargets(
  page: Page,
  name: string,
  targets: Locator[],
  opts: { disjoint?: boolean } = {}
): Promise<void> {
  expect(
    targets.length,
    `${name} must name at least one target`
  ).toBeGreaterThan(0);
  for (const target of targets) {
    await expect(target, name).toBeVisible();
    await target.scrollIntoViewIfNeeded();
  }
  const boxes = await settledBoxes(targets);
  const reach = await renderedReach(targets);
  const coarse = await page.evaluate(
    () => window.matchMedia("(pointer: coarse)").matches
  );
  const floor = coarse ? TAP_FLOOR_PX : CONTROL_BOX_PX;
  const effective = boxes.map((box, index) => {
    const r = reach[index] ?? { block: 0, inline: 0 };
    return {
      x: box.x - r.inline,
      y: box.y - r.block,
      width: box.width + 2 * r.inline,
      height: box.height + 2 * r.block,
    };
  });
  const viewport = page.viewportSize();
  expect(viewport, `${name} requires a fixed viewport`).not.toBeNull();

  for (const [index, box] of boxes.entries()) {
    expect(
      effective[index]!.width + TAP_FLOOR_FLOAT_EPSILON_PX,
      `${name} target ${index} width: ${box.width} rendered + 2x${reach[index]?.inline} inline reach, against the ${coarse ? "coarse-pointer" : "fine-pointer"} floor`
    ).toBeGreaterThanOrEqual(floor);
    expect(
      effective[index]!.height + TAP_FLOOR_FLOAT_EPSILON_PX,
      `${name} target ${index} height: ${box.height} rendered + 2x${reach[index]?.block} block reach, against the ${coarse ? "coarse-pointer" : "fine-pointer"} floor`
    ).toBeGreaterThanOrEqual(floor);
    expect(box.x, `${name} target ${index} left edge`).toBeGreaterThanOrEqual(
      0
    );
    expect(box.y, `${name} target ${index} top edge`).toBeGreaterThanOrEqual(0);
    expect(
      box.x + box.width,
      `${name} target ${index} right edge`
    ).toBeLessThanOrEqual(viewport!.width + TAP_FLOOR_FLOAT_EPSILON_PX);
    expect(
      box.y + box.height,
      `${name} target ${index} bottom edge`
    ).toBeLessThanOrEqual(viewport!.height + TAP_FLOOR_FLOAT_EPSILON_PX);
  }

  if (!opts.disjoint) return;
  for (let left = 0; left < effective.length; left += 1) {
    for (let right = left + 1; right < effective.length; right += 1) {
      const a = effective[left]!;
      const b = effective[right]!;
      const overlapX =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(
        overlapX > TAP_FLOOR_FLOAT_EPSILON_PX &&
          overlapY > TAP_FLOOR_FLOAT_EPSILON_PX,
        `${name} targets ${left} and ${right} own the same point once their reach is counted`
      ).toBe(false);
    }
  }
}

// WHAT IS SITTING BETWEEN TWO ELEMENTS IN FLOW, not just how far apart they are.
// KEEP THIS even while the assertion it annotates is green — a reviewer will read
// an unused-looking diagnostic as dead weight and it is the opposite.
//
// `expect(bar.y).toBeCloseTo(shell.y + shell.height)` is a number with no author.
// On CI it has now said "Expected: 57  Received: 187" three times, on three
// different PRs, none of whose diffs render on the route (#3364) — and 130px of
// unexplained band cost a separate full diagnosis every time, because the failure
// names no element. It could be a banner, a spacer, a mis-collapsed margin or a
// wrapper that grew; those need different fixes, and the message cannot tell them
// apart.
//
// This walks UP from `below` to the nearest ancestor that also contains `above`,
// listing at each level the preceding siblings that stand between them, so the
// next red arrives with the inserted element attached instead of a bare integer.
// The walk follows the DOM's own flow relationship rather than hit-testing a
// pixel band, because an inserted element is by construction a preceding sibling
// of something on `below`'s ancestor chain — that is what "in flow above it"
// means — and a rect-intersection sweep would also name every fixed/sticky
// overlay merely passing through the band.
//
// Reports each occupant's own outer height INCLUDING margins (`mb-5` on a banner
// is part of what it displaces) and, at the end, the residue the named elements
// do not account for, which is the signature of a padding/margin change rather
// than an insertion.
export async function bandStory(
  above: Locator,
  below: Locator
): Promise<string> {
  const [aboveHandle, belowHandle] = await Promise.all([
    above.elementHandle({ timeout: 1_000 }).catch(() => null),
    below.elementHandle({ timeout: 1_000 }).catch(() => null),
  ]);
  if (!aboveHandle || !belowHandle) {
    return "[bandStory] one of the two elements is not attached — nothing to compare";
  }
  return below.page().evaluate(
    ([top, bottom]) => {
      const topRect = top.getBoundingClientRect();
      const bottomRect = bottom.getBoundingClientRect();
      const gap = bottomRect.top - topRect.bottom;
      if (gap <= 0.5)
        return `nothing sits between them (gap ${Math.round(gap)}px)`;

      const describe = (el: Element): string => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const outer =
          rect.height +
          parseFloat(style.marginTop || "0") +
          parseFloat(style.marginBottom || "0");
        // Every data-* attribute, not just the testid: the travel banner stamps
        // the DEVICE zone it read onto itself, and that one attribute is the
        // difference between "a banner appeared" and "this profile's day is
        // running somewhere the device is not" (#3364's leading hypothesis).
        const attrs = Array.from(el.attributes)
          .filter((a) => a.name.startsWith("data-"))
          .map((a) => `${a.name}="${a.value}"`)
          .join(" ");
        return (
          `<${el.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ""}> ` +
          `${Math.round(outer)}px tall (box ${Math.round(rect.height)}px + margins)`
        );
      };

      const occupants: string[] = [];
      let accounted = 0;
      let node: Element | null = bottom;
      // Stop at the first ancestor that also contains `above`: everything above
      // that point is shared chrome, not an insertion between the two.
      while (node && !node.contains(top)) {
        for (
          let sibling = node.previousElementSibling;
          sibling;
          sibling = sibling.previousElementSibling
        ) {
          if (sibling.contains(top) || sibling === top) continue;
          const rect = sibling.getBoundingClientRect();
          // Only what actually occupies the band. A `sr-only` heading, a script
          // tag or a portal root measures ~0 and would bury the real occupant.
          if (rect.height < 1) continue;
          const style = getComputedStyle(sibling);
          if (style.position === "fixed" || style.position === "absolute")
            continue;
          accounted +=
            rect.height +
            parseFloat(style.marginTop || "0") +
            parseFloat(style.marginBottom || "0");
          occupants.push(describe(sibling));
        }
        node = node.parentElement;
      }

      const residue = Math.round(gap - accounted);
      return (
        `${Math.round(gap)}px between them; ` +
        (occupants.length > 0
          ? `${occupants.join(" | ")}; ${residue}px unaccounted (padding/margins)`
          : `NO element sits between them — the gap is padding, margin or a grown ` +
            `wrapper, not an insertion`)
      );
    },
    [aboveHandle, belowHandle] as const
  );
}

// Toggle a checkbox so the change durably lands in React STATE — the checkbox analog
// of settledFill.
//
// Root cause (same family as settledFill): a `.check()`/`.uncheck()` dispatched before
// React hydrates a CONTROLLED checkbox (`checked={…} onChange={…}`) clicks the box but
// no `onChange` is wired, so state never flips and hydration REVERTS the box. Playwright
// then reports `check: Clicking the checkbox did not change its state` (the click didn't
// stick) — or, worse, the click sticks in the DOM but not state and a later save reads
// the stale value. It was the `food-telegram` line-26 `enableTelegram.check()` flake.
//
// Wait until React has hydrated THIS element (the `__reactFiber$…`/`__reactProps$…`
// markers, as settledFill/followLink do) BEFORE toggling, so the click fires `onChange`
// and the state flips; then confirm it holds. `setChecked(checked)` is idempotent (a
// no-op when already in the target state), so this also replaces a
// `if (!await box.isChecked()) await box.check()` guard.
export async function settledCheck(
  page: Page,
  box: Locator,
  checked: boolean,
  opts: { timeout?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 10_000;
  await expect(box).toBeVisible();
  await expect(async () => {
    const hydrated = await box.evaluate((el) =>
      Object.keys(el).some(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")
      )
    );
    // Not hydrated yet → toPass retries (the toggle would be reverted). Once React has
    // attached, the click fires onChange and the state sticks.
    expect(hydrated, "checkbox not hydrated yet").toBe(true);
    await box.setChecked(checked);
    await expect(box).toBeChecked({ checked, timeout: 2_000 });
  }).toPass({ timeout });
}

export async function settledCheckSave(
  page: Page,
  box: Locator,
  checked: boolean,
  scope: Locator,
  opts: { timeout?: number } = {}
): Promise<void> {
  await settledCheck(page, box, checked, opts);
  await awaitAutosaveSettled(scope);
}

// ── The correlated Server-Action POST wait (#1952) ───────────────────────────
//
// Next App Router Server Actions POST to the CURRENT route URL (same origin) — a
// `<form action={serverAction}>` submit posts natively before hydration and via a
// `fetch` POST after, and either way the response completes only once the action
// AND its `revalidatePath` have run server-side (the revalidate is what puts the
// re-rendered tree in that very response — see
// docs/internals/server-action-refresh.md). So "the interaction's action landed"
// is answerable from outside the browser: arm a `waitForResponse` for that POST
// BEFORE the interaction (a fast action must not resolve in the gap), drive the
// interaction, await the response.
//
// THE WAIT IS CORRELATED WITH THE INTERACTION. It used to accept ANY same-origin
// POST, which is not a contract at all: it cannot tell this interaction's action
// from a bystander's, and the failure mode is SILENT — a spec pointed at a control
// that posts NOTHING passes on somebody else's traffic, and only goes red when that
// traffic disappears. That is exactly what happened: both completion toasters used
// to observe through a read Server Action (a POST) every few seconds on every
// authenticated page, ~22 specs were coasting on it, and moving that poll to a
// `fetch` GET (#1949) turned all of them red at once. Two filters replace "any
// POST":
//
//   1. The request must have STARTED AFTER the interaction. We collect
//      `page.on("request")` from the instant before the click/`setInputFiles`, so a
//      poll already in flight when it landed can no longer satisfy the wait. That
//      is the #1437 false-settle (settle on a bystander, then `goto` aborts the
//      real write).
//   2. The request must be a SERVER ACTION, which Next marks with a `next-action`
//      header carrying the action id. A route-handler POST (`/api/…`) has no such
//      header and is by construction not the interaction's action — which is what
//      excludes the offline queue's `/api/offline-replay` flush, the one background
//      POST a page can still fire (`lib/__tests__/chrome-refresh-scan.test.ts`).
//
//      This started life as "must target this page's route", which is true of a
//      Server Action — Next posts one to the current document URL — but pinning
//      that route when the wait is ARMED turned out to be brittle in exactly the
//      way `followLink` documents above: the App Router can commit a destination
//      and then UNWIND to the source route while the interaction is still running.
//      When it does, the interaction's own action posts from the route the page has
//      unwound to, the arm-time pin rejects it, and the timeout blames the call
//      site for a navigation that happened underneath it (measured on
//      `illness-episode-followups`, where the Save action and both toaster polls
//      all posted to `/` after an unwind off `/medical/episodes/2`). Keying on the
//      header identifies the same class of request without caring which route it
//      leaves from, so it is both tighter (a same-route `/api` POST no longer
//      qualifies) and immune to the unwind.
//
//      The one Server Action WITHOUT that header is a pre-hydration native `<form>`
//      submit, which carries its action id in the body instead — that one is still
//      matched on the route, which it necessarily posts to, being a document
//      navigation. `opts.url` overrides both for an interaction that posts
//      elsewhere.
//
// WHAT THIS DOES NOT GUARANTEE, said plainly: two Server Actions are
// indistinguishable from outside the browser unless you pin their action ids, which
// are build-generated hashes no spec should hard-code. So a background actor that
// posts an action AFTER the interaction can still satisfy this wait. Nothing in the
// app does that today (#1949 left the toasters on `fetch` GETs), and adding one
// would be visible in the chrome-actor list above — but the guarantee is "a Server
// Action POST, caused no earlier than this interaction", not "this interaction's
// action". Where that residue matters (a settled interaction followed by a
// NAVIGATION), keep asserting the durable server-rendered marker the completed
// mutation produces before navigating — the rule this module's #1437 note already
// states, and the wellbeing card's `mood-server-logged` precedent.
//
// ONE predicate, shared by settledClick and settledUpload, because they ask ONE
// question. settledUpload kept the old "any same-origin POST" body when
// settledClick stopped accepting it (#1958), so the identical silent-green defect
// survived under the other helper's name — and its two call sites had each grown a
// 45s `toPass` loop whose comment says exactly that ("settledUpload's POST arm
// matches ANY same-origin POST … a satisfied settle doesn't prove the UPLOAD
// landed"). A helper family cannot hold two different answers to one question.
//
// Usage: arm before the interaction; call `begin()` in the SAME synchronous turn as
// it; await `settled`; `release()` in a `finally`.
function armActionPost(
  page: Page,
  here: URL,
  opts: { timeout: number; url?: RegExp }
): {
  settled: Promise<unknown>;
  begin: () => void;
  release: () => void;
  /** Wall-clock instant the wait was armed, for reading the interaction ledger. */
  armedAt: number;
  /** Same-origin POSTs the browser has ISSUED since `begin()`, answered or not. */
  issuedCount: () => number;
  /** A line the failure message must carry (the #3359 re-dispatch record). */
  note: (line: string) => void;
  diagnose: (err: unknown, helper: string, advice: string) => Error;
} {
  // Requests observed from the moment the interaction is dispatched. A WeakSet keyed
  // on Playwright's own Request object is exact identity — no URL/timing heuristics
  // — and `response.request()` returns that same object.
  const caused = new WeakSet<Request>();
  let collecting = false;
  // Same-origin POSTs ISSUED after the interaction, answered or not. waitForResponse
  // can only see requests the server ANSWERED, so before this list a hung response
  // and a page that dispatched nothing produced the same "no traffic" diagnosis —
  // which is exactly how #3029's CI stall got read as "the page produced no
  // traffic" when the helper had no way to know whether it had. The request event
  // fires when the browser issues the request, so recording it here lets the
  // timeout say WHICH of the two happened.
  const armedAt = Date.now();
  const issued: string[] = [];
  const onRequest = (request: Request) => {
    if (!collecting) return;
    caused.add(request);
    if (request.method() !== "POST") return;
    try {
      const target = new URL(request.url());
      if (target.origin === here.origin)
        issued.push(`${target.pathname} (issued +${Date.now() - armedAt}ms)`);
    } catch {
      // A malformed URL can't be same-origin.
    }
  };
  // Every same-origin POST seen during the wait, with the reason it was refused.
  // A timeout here is nearly always a question about WHICH post happened, so the
  // failure answers it instead of making the next reader re-instrument (#1952).
  const rejected: string[] = [];
  page.on("request", onRequest);
  const settled = page.waitForResponse(
    (resp) => {
      const request = resp.request();
      if (request.method() !== "POST") return false;
      let target: URL;
      try {
        target = new URL(resp.url());
      } catch {
        return false;
      }
      if (target.origin !== here.origin) return false;
      if (!caused.has(request)) {
        rejected.push(`${target.pathname} (already in flight at that moment)`);
        return false;
      }
      // Next stamps every hydrated Server Action with the id it is dispatching;
      // a pre-hydration native form submit has no header and is matched on the
      // route it necessarily posts to.
      const isServerAction = request.headers()["next-action"] != null;
      const matches = opts.url
        ? opts.url.test(resp.url())
        : isServerAction || target.pathname === here.pathname;
      if (!matches) {
        rejected.push(
          `${target.pathname} (started in time, but ` +
            (opts.url
              ? `does not match ${opts.url}`
              : `carries no next-action header and is not this page's route`) +
            `)`
        );
      }
      return matches;
    },
    { timeout: opts.timeout }
  );
  // Things the helper DID on the failure path that the reader must be told about —
  // today only the #3359 re-dispatch, which would otherwise be invisible in a
  // message that says "no POST" after two clicks.
  const notes: string[] = [];
  return {
    settled,
    begin: () => {
      collecting = true;
    },
    release: () => page.off("request", onRequest),
    armedAt,
    issuedCount: () => issued.length,
    note: (line) => {
      notes.push(line);
    },
    diagnose: (err, helper, advice) => {
      // The old helper's timeout said only "waiting for event response", which reads
      // as a slow server on a control that was never going to post. Name the real
      // question instead — #1952's whole lesson is that this timeout usually means
      // the call site is wrong, not the app.
      const wrapped = err instanceof Error ? err : new Error(String(err));
      if (!wrapped.message.includes("waitForResponse")) return wrapped;
      wrapped.message +=
        `\n\n[${helper}] armed on ${here.pathname}; page is now ${new URL(page.url()).pathname}.` +
        `\n[${helper}] no correlated Server Action POST started after this ` +
        `interaction. ${advice}` +
        (rejected.length
          ? `\n[${helper}] same-origin POSTs seen while waiting:\n  - ${rejected.join("\n  - ")}`
          : issued.length
            ? // The three-way split #3029 needed: answered-and-refused (above),
              // issued-but-never-answered (here), and never-issued (below) are
              // three different culprits, and the old message collapsed the last
              // two into "the page produced no traffic".
              `\n[${helper}] same-origin POST(s) WERE issued after this ` +
              `interaction but NO response arrived before the deadline:` +
              `\n  - ${issued.join("\n  - ")}` +
              `\n[${helper}] the page dispatched its action; suspect the server ` +
              `or network leg (a wedged worker app server, a response stalled ` +
              `past the budget), not this call site or the page.`
            : `\n[${helper}] NO same-origin POST was even ISSUED during the wait — ` +
              `not even a background one. The page dispatched nothing, so the old ` +
              `"any POST" helper would have timed out here too; suspect a stalled ` +
              `or navigated page rather than this contract.`) +
        notes.map((line) => `\n[${helper}] ${line}`).join("");
      return wrapped;
    },
  };
}

// How long settledClick waits before it will believe a form submit was LOST.
//
// MEASURED, not chosen. On #3359's own control (the "Log a use" submit button of
// TrackSubstanceControl) under a CDP `Emulation.setCPUThrottlingRate`, timing the
// two things a click can produce — the `submit` EVENT and the Server Action POST:
//
//   throttle   click → submit event        click → POST issued
//   rate 20    1, 1, 4, 11, 23 ms          551, 556, 659, 662, 833 ms
//   rate 100   112, 192 ms                 4015, 4913 ms
//   rate 200   224 ms                      8022 ms
//
// (rate 20 throttles the whole flow; rates 100 and 200 throttle only across the
// click, because at rate 60 and above the page's own navigation stops fitting in
// Playwright's 15 s navigationTimeout and there is no click left to measure.)
//
// Read the two columns against each other, because that comparison is the whole
// design: the submit event is EARLY and TIGHT and the POST is LATE and LOOSE. At a
// 200× squeeze — an order of magnitude past anything a loaded CI runner produces —
// the submit event still lands inside a quarter-second, while the POST it leads to
// is still 8 s away. So 3 s is ~13× the worst submit-event latency ever measured
// here, and simultaneously FAR TOO SHORT to prove anything about the POST: at rate
// 100 and 200 a POST that was certainly coming had not been issued at 3 s, twice.
//
// That is exactly why the re-dispatch below rests on the ABSENCE OF A SUBMIT EVENT
// and never on the absence of a POST alone — see proof 2 there.
const LOST_SUBMIT_PROOF_MS = 3_000;

// ── The DOM interaction ledger (#3359) ───────────────────────────────────────
//
// `armActionPost` watches the NETWORK, and a network ledger cannot tell a click
// that never reached a handler from a handler that ran and returned without
// posting. Both print as "NO same-origin POST was even ISSUED", both leave the
// control idle and enabled, and they need opposite investigations — one is a lost
// interaction, the other a client-side guard in the app's own submit handler.
// #3359 was exactly that fork, on a `<form onSubmit>` whose handler refuses an
// invalid name BEFORE reaching the Server Action, and nothing in the failure could
// say which side of it the run was on.
//
// So the page keeps a small ledger of the DOM events that stand BETWEEN a click and
// a POST. Three listeners, all passive:
//
//   • `click` (capture, on window) — did the click reach the document at all, and
//     on which element. Capture on `window` runs before anything React registers.
//   • `submit` (capture, on window) — did the browser run the form's ACTIVATION
//     behaviour. A submit button that produced no submit event was swallowed.
//   • `submit` (bubble, on window) — read AFTER React. In the App Router React
//     hydrates the whole document, so its delegated listener sits on `document`;
//     an init-script listener on `document` would register FIRST and read
//     `defaultPrevented === false` even when the handler ran. `window` is strictly
//     downstream of `document`, so this one answers the real question: a handler
//     that ran called `preventDefault`, and one that never ran did not.
//
// Installed once per page (init script + the live document, so it also covers a page
// that has already navigated), and it survives every later navigation. It pins
// nothing and backs no assertion, and it will therefore look deletable to a reviewer
// — read #3029 and #3359 first: BOTH of those diagnoses came from making the failure
// say more, and the ledger is the half that was missing the second time.
//
// TIMESTAMPED WITH `performance.now()`, NEVER `Date.now()`. Every context in this
// suite has its system time set to the run's frozen instant (e2e/fixtures.ts), so a
// page's `Date.now()` and the test process's differ by however long the run has
// been going — a wall-clock "since I armed" filter drops every entry and reports a
// ledger that recorded nothing. `performance.now()` is document-relative and
// unaffected by the clock patch, and because the fixture uses `setSystemTime` (not
// `setFixedTime`) elapsed durations still agree on both sides, so the reader asks
// for a WINDOW rather than an instant.
type InteractionLedgerEntry = {
  p: number;
  kind: "click" | "submit" | "submit-after-react";
  target: string;
  extra: string;
  // The event's own target NODE. Kept for IDENTITY comparison inside the page —
  // `clickLandedOnControl` below asks "did this click land on THIS element", and a
  // testid string cannot answer that (two controls can share one, and a retargeted
  // click lands on an ancestor that has none). It never leaves the page: every
  // reader projects the serializable fields explicitly, because handing a DOM node
  // back through `page.evaluate` throws.
  node: EventTarget | null;
};

// The serializable half of an entry, which is all a reader in the test process
// ever sees.
type LedgerReading = Omit<InteractionLedgerEntry, "node"> & { ago: number };

const LEDGER_INSTALLED = new WeakSet<Page>();

function installInteractionLedgerScript(): void {
  const w = window as unknown as {
    __allosInteractionLedger?: InteractionLedgerEntry[];
  };
  if (w.__allosInteractionLedger) return;
  const entries: InteractionLedgerEntry[] = [];
  w.__allosInteractionLedger = entries;
  const describe = (node: EventTarget | null): string => {
    const el = node as Element | null;
    if (!el || typeof el.getAttribute !== "function") return "(non-element)";
    const testId = el.getAttribute("data-testid");
    return testId ? `[${testId}]` : `<${el.tagName.toLowerCase()}>`;
  };
  const record = (
    kind: InteractionLedgerEntry["kind"],
    node: EventTarget | null,
    extra: string
  ): void => {
    entries.push({
      p: performance.now(),
      kind,
      target: describe(node),
      extra,
      node,
    });
    // A bounded ring: a long spec must not grow this without limit, and only the
    // events around the failing interaction are ever read.
    if (entries.length > 40) entries.shift();
  };
  window.addEventListener(
    "click",
    (event) => record("click", event.target, ""),
    true
  );
  window.addEventListener(
    "submit",
    (event) => record("submit", event.target, ""),
    true
  );
  window.addEventListener("submit", (event) =>
    record(
      "submit-after-react",
      event.target,
      event.defaultPrevented
        ? "HANDLED — a React onSubmit ran and called preventDefault"
        : "NOT HANDLED — no preventDefault, so this was a native form submit"
    )
  );
}

async function installInteractionLedger(page: Page): Promise<void> {
  if (LEDGER_INSTALLED.has(page)) return;
  LEDGER_INSTALLED.add(page);
  // Best-effort on both halves: a page that cannot take the script still runs the
  // interaction, it just reports less when it fails.
  await page.addInitScript(installInteractionLedgerScript).catch(() => {});
  await page.evaluate(installInteractionLedgerScript).catch(() => {});
}

// Everything recorded in the last `windowMs` — see the note above for why this
// takes a window rather than an instant.
//
// `null` means the ledger could not be READ AT ALL: the page is closed, navigating,
// refusing to run JS, or the init script never landed in this document. An EMPTY
// ARRAY is a completely different answer — the ledger is installed, the renderer is
// answering, and it saw nothing. Collapsing the two is not a cosmetic error: the
// empty array IS the evidence in the shape this file exists for, because a click
// that never activated its control may leave no DOM event whatsoever (Chromium
// dispatches NO mouse events at all for a `disabled` control — measured here, and
// it is why the re-dispatch below no longer demands a non-empty window).
async function readInteractionLedger(
  page: Page,
  windowMs: number
): Promise<LedgerReading[] | null> {
  return await page
    .evaluate((ms: number) => {
      const w = window as unknown as {
        __allosInteractionLedger?: InteractionLedgerEntry[];
      };
      if (!w.__allosInteractionLedger) return null;
      const now = performance.now();
      return (
        w.__allosInteractionLedger
          .filter((e) => e.p >= now - ms)
          // Field by field ON PURPOSE: an entry carries its target NODE, and
          // returning that from `evaluate` throws rather than serializing.
          .map((e) => ({
            ago: Math.round(now - e.p),
            p: e.p,
            kind: e.kind,
            target: e.target,
            extra: e.extra,
          }))
      );
    }, windowMs)
    .catch(() => null);
}

// Did any click in the window land ON the clicked control — on the element itself
// or on a descendant of it? `null` means the question could not be asked (no
// handle, no ledger, a page that will not run JS), which every caller treats as
// "unanswered" rather than as either answer.
//
// This is the question that separates the two ways a click can produce no submit
// event, and no string comparison can answer it: a click that was RETARGETED —
// because the DOM moved between mousedown and mouseup, or because the control was
// momentarily `disabled`, both of which make the browser dispatch the click to the
// nearest common ancestor instead — lands on an element that usually has no testid
// at all. Identity against the very node Playwright clicked is the only honest test.
async function clickLandedOnControl(
  probeHandle: ElementHandle<SVGElement | HTMLElement> | null,
  windowMs: number
): Promise<boolean | null> {
  if (!probeHandle) return null;
  return await probeHandle
    .evaluate((el, ms: number) => {
      const w = window as unknown as {
        __allosInteractionLedger?: InteractionLedgerEntry[];
      };
      const entries = w.__allosInteractionLedger;
      if (!entries) return null;
      const now = performance.now();
      return entries.some(
        (e) =>
          e.kind === "click" &&
          e.p >= now - ms &&
          e.node instanceof Node &&
          (el === e.node || el.contains(e.node))
      );
    }, windowMs)
    .catch(() => null);
}

async function interactionLedgerReport(
  page: Page,
  probeHandle: ElementHandle<SVGElement | HTMLElement> | null,
  armedAt: number
): Promise<string> {
  const windowMs = Date.now() - armedAt;
  const entries = await readInteractionLedger(page, windowMs);
  if (entries === null)
    return (
      `\n[settledClick] the DOM interaction ledger could not be read, so whether ` +
      `the click reached a handler is UNANSWERED — the page is closed, navigating, ` +
      `or not running JS.`
    );
  if (entries.length === 0)
    return (
      `\n[settledClick] the DOM interaction ledger is installed and answering, and ` +
      `it recorded NOTHING since this wait was armed — not one click event. ` +
      `Playwright reported the click as done, so the browser DROPPED it rather ` +
      `than delivering it: Chromium dispatches no mouse events at all for a ` +
      `\`disabled\` control, so a control that went disabled between mousedown and ` +
      `mouseup produces exactly this. The control was never activated, so no ` +
      `handler of its ran and nothing it writes was written (#3359).`
    );
  const lines = entries
    .map(
      (entry) =>
        `+${Math.max(0, windowMs - entry.ago)}ms ${entry.kind} on ${entry.target}` +
        `${entry.extra ? ` — ${entry.extra}` : ""}`
    )
    .join("\n  - ");
  const landed = await clickLandedOnControl(probeHandle, windowMs);
  const aim =
    landed === null
      ? `\n[settledClick] whether any of those clicks landed on the control ITSELF ` +
        `could not be read.`
      : landed
        ? `\n[settledClick] a click DID land on the clicked control (or inside it), ` +
          `so the interaction reached its target and something downstream of the ` +
          `click stopped it.`
        : `\n[settledClick] NO click landed on the clicked control — every click ` +
          `above went to some other element. The browser RETARGETED it, which is ` +
          `what it does when the DOM moves between mousedown and mouseup, or when ` +
          `the control is \`disabled\` at mouseup. The control was never activated, ` +
          `so no handler of its ran (#3359).`;
  return (
    `\n[settledClick] DOM interaction ledger since the wait was armed:\n  - ${lines}` +
    aim +
    `\n[settledClick] read it as the fork the POST census cannot see: a ` +
    `\`submit-after-react\` line saying HANDLED means the app's own onSubmit RAN ` +
    `and returned WITHOUT posting — look at that handler's client-side guards, not ` +
    `at the network. A click on the control with NO submit line beside it means the ` +
    `browser never ran the form's activation behaviour: the submit was LOST (#3359).`
  );
}

// What the clicked control looks like at the moment a settledClick timeout is
// being diagnosed, plus whether the page answered the read at all (#3029).
//
// Probed through an ElementHandle captured BEFORE the click, never through the
// caller's locator: a SubmitButton swaps its accessible name to the pending
// label while the action is in flight, so re-resolving "the button named X" is
// exactly what fails in the state this probe exists to see. The handle is the
// same DOM node whatever it now says.
//
// Bounded and never-throwing: it runs only on the failure path, and a diagnosis
// must not replace the error it is explaining with one of its own. The answers
// separate the hypotheses a bare "no POST" left open:
//   • aria-busy/disabled with a pending label → React DID dispatch the action;
//     the stall is downstream of the page (pairs with the issued-POST list).
//   • an idle, enabled control → the click landed but the submit/action handler
//     never ran (or returned synchronously without posting) — look at the form's
//     client-side guards, not at the network.
//   • connected:false → the node left the DOM (a remount or an applied render).
//   • a destroyed execution context → the page NAVIGATED under the wait.
//   • no answer inside the probe's own budget → the renderer is not running JS
//     at all (a starved worker, a wedged main thread); THAT is the finding.
async function clickedControlState(
  handle: ElementHandle<SVGElement | HTMLElement> | null
): Promise<string> {
  if (!handle) return "";
  const started = Date.now();
  try {
    const state = await Promise.race([
      handle
        .evaluate((el) => ({
          text: (el.textContent ?? "").trim().slice(0, 80),
          disabled: el instanceof HTMLButtonElement ? el.disabled : null,
          ariaBusy: el.getAttribute("aria-busy"),
          connected: el.isConnected,
        }))
        .catch(
          (probeErr: unknown) =>
            `probe threw: ${String(probeErr).slice(0, 200)} — a destroyed ` +
            `execution context here means the page navigated under the wait.`
        ),
      new Promise<"probe-timeout">((resolve) =>
        setTimeout(() => resolve("probe-timeout"), 2_000)
      ),
    ]);
    if (state === "probe-timeout")
      return (
        `\n[settledClick] the page did not answer a 2s read of the clicked ` +
        `control's state — the renderer is not running JS (or is starved); that, ` +
        `not the missing POST, is the finding.`
      );
    if (typeof state === "string") return `\n[settledClick] ${state}`;
    return (
      `\n[settledClick] the clicked control at diagnosis time: ` +
      `${JSON.stringify(state)} (read in ${Date.now() - started}ms). ` +
      `aria-busy/disabled means the action was dispatched and is still pending; ` +
      `an idle control means the handler never posted.`
    );
  } catch {
    return "";
  }
}

// ── The lost-submit rescue (#3359) ───────────────────────────────────────────
//
// A `<form>` submit button was clicked, Playwright reported no click error, and the
// page then produced NOTHING: no POST, and — proven by the ledger above — no submit
// event either. Twice in one day on the same control: #3338 saw it as a refusal
// message that never rendered (that handler refuses BEFORE posting, so the missing
// paragraph proved the handler never ran), and #3359 saw it as a settledClick
// timeout on the sibling spec.
//
// ── WHAT THE CI EVIDENCE NARROWS IT TO ───────────────────────────────────────
//
// #3359's annotation is unusually complete, and reading it against
// TrackSubstanceControl closes every branch but one:
//
//   • the control read `{"text":"Log a use","disabled":false,"connected":true}`, so
//     `pending` was false — the handler had not reached its Server Action;
//   • `NO same-origin POST was even ISSUED`, so it had not posted;
//   • the handler's OTHER exit is `setError` on an invalid name, which renders the
//     refusal paragraph — and `settledFill` had already asserted `toHaveValue` on an
//     UNCONTROLLED input, so the name was valid and stayed valid;
//   • the node was still `connected`, so the form had not been replaced, and the
//     page had not navigated — which also rules out a NATIVE submit by an
//     unhydrated form (that would have navigated).
//
// So the handler never ran, which means the browser never ACTIVATED the control.
// There are exactly two ways that happens to a click Playwright reports as done,
// and both were measured here against a forged control:
//
//   • RETARGETED — the DOM moved between mousedown and mouseup, so Chromium fires
//     the click on the nearest common ancestor instead. A click event exists, on
//     some other element.
//   • DROPPED — the control was `disabled` at mouseup. Chromium dispatches NO mouse
//     events at all for a disabled form control; it does not retarget them. There
//     is no click event anywhere.
//
// The second one is not a guess: forging it is what corrected this comment, which
// until it was measured claimed a click always fires somewhere. Both shapes answer
// `clickLandedOnControl` with FALSE, and that is the proof this rescue turns on.
//
// NOT REPRODUCED LOCALLY. Five trials at CPU throttle 20, plus throttled runs at
// 100 and 200 across the click alone, all produced a submit event and a POST. The
// chain above is a deduction from the annotation, not an observation, and the
// ledger exists so the NEXT sighting is an observation instead.
//
// ── WHY A RE-DISPATCH IS SAFE HERE, WHICH IT IS NOT IN GENERAL ────────────────
//
// settledClick's own note says, correctly, that it is NOT a retry: a Server Action
// click is rarely idempotent and clicking twice is the #2437 defect. The control
// this fires on WRITES — "Log a use" logs a use — so a naive retry would double-log,
// and a double-logged use is a wrong number in somebody's record. This is not a
// naive retry. It re-clicks only under proofs that the first click had NO EFFECT AT
// ALL, and it fails CLOSED on every one of them — every proof must come back
// positively, and "could not tell" is treated as "do not touch it":
//
//   1. NO same-origin POST has been ISSUED since the click. The only way this page
//      writes is a Server Action, and invoking one necessarily issues a POST.
//      Playwright's `request` event fires when the browser issues the request,
//      answered or not, so an empty census is evidence rather than silence. Taken
//      twice: once up front, and again in the same turn as the second click, so a
//      POST that appears while the other proofs are being read still cancels it.
//   2. NO `submit` event was recorded, by a ledger that ANSWERED — the read proves
//      the init script landed in this document and the renderer is running JS right
//      now. An empty window is a positive answer, not a missing one: in the DROPPED
//      shape above there is no DOM event to record at all, so demanding a non-empty
//      window would switch the rescue off in half the cases it exists for. A form's
//      handler cannot run without a submit event, and the listener is a CAPTURE
//      listener on `window`, so it sees the event before any handler can stop its
//      propagation. This is the load-bearing proof, and the measurement above is
//      why: the submit event is the early, tight signal (≤224 ms at a 200× CPU
//      squeeze) where the POST is the late, loose one (still absent at 3 s in the
//      same trials).
//   3. The control is a form-owned `type="submit"` that is IDLE — neither `disabled`
//      nor `aria-busy`. The form-owned half matters because a `<button onClick>`
//      dispatching through `useTransition` produces no submit event EVER, so proof 2
//      would be vacuous for it; those keep the old single-dispatch contract. The
//      idle half closes the one case where proof 1 could be a lie: a control already
//      mid-action has `pending` set and its POST merely not issued YET.
//   4. NO click landed on the control or inside it. This is what makes proof 2 sound
//      rather than merely suggestive. A submit-button click with no submit event has
//      two causes, and only one of them is safe: the browser never ACTIVATED the
//      control (retargeted or dropped — nothing ran, nothing was written), or it
//      activated it and something suppressed the submit, which on a `type="submit"`
//      button means an `onClick` that called `preventDefault` and may have posted on
//      its own schedule. Proof 4 admits only the first. It also means the rescue does not
//      rest on a census of the app: as of this change no `type="submit"` button in
//      `app/` or `components/` carries an `onClick` that preventDefaults (72 submit
//      sites, one `onClick`, in ProfileSwitcherPanel, which only calls a callback) —
//      but a future one would be handled by construction rather than by that count
//      staying true.
//
// Under 1–4 the control was never activated, so no handler of its ran and nothing
// was written; a second click cannot be a second write. If ANY proof is unavailable,
// the old single-dispatch behaviour stands and the failure reports the ledger.
//
// The probe itself spends nothing on the happy path — it resolves the moment the
// wait settles — and it sits INSIDE settledClick's one declared deadline (#1858), so
// a rescue can never widen the ceiling the call site asked for.
async function redispatchLostSubmit(
  page: Page,
  locator: Locator,
  probeHandle: ElementHandle<SVGElement | HTMLElement> | null,
  wait: ReturnType<typeof armActionPost>,
  click: { error: Error | null },
  rest: number
): Promise<void> {
  // Not enough budget left for a probe AND a real second attempt: leave the single
  // dispatch alone rather than spend the caller's ceiling on half a rescue.
  if (rest < LOST_SUBMIT_PROOF_MS * 2) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    // Both outcomes mean "stop probing": settled is the happy path, and a rejection
    // is the deadline expiring, which the catch below already reports.
    wait.settled.then(
      () => "done" as const,
      () => "done" as const
    ),
    new Promise<"probe">((resolve) => {
      timer = setTimeout(() => resolve("probe"), LOST_SUBMIT_PROOF_MS);
    }),
  ]);
  clearTimeout(timer);
  if (raced === "done") return;

  // Proof 0: the click Playwright made actually happened. If it failed there is
  // nothing to rescue, and the catch reports the click's own error instead.
  if (click.error) return;
  // Proof 1: nothing left the browser.
  if (wait.issuedCount() > 0) return;
  // Proof 3, first because it is the cheap local read. The label comes back on the
  // same round trip because the announcement below needs it and the failure path
  // must not pay for a second one.
  const control = await probeHandle
    ?.evaluate((el) => {
      const c = el as HTMLButtonElement | HTMLInputElement;
      const testId = c.getAttribute("data-testid");
      return {
        formSubmit: c.form != null && c.type === "submit",
        idle: !c.disabled && c.getAttribute("aria-busy") !== "true",
        label: testId
          ? `[${testId}]`
          : `<${c.tagName.toLowerCase()}> "${(c.textContent ?? "").trim().slice(0, 40)}"`,
        // A spec that LOSES A CLICK ON PURPOSE says so on the page it forged it on.
        forged:
          (window as unknown as { __allosForgedLostSubmit?: boolean })
            .__allosForgedLostSubmit === true,
      };
    })
    .catch(() => null);
  if (!control?.formSubmit || !control.idle) return;
  const windowMs = Date.now() - wait.armedAt;
  // Proof 2: the ledger answered — so it is installed and the renderer is running
  // JS right now — and it holds no submit event. An EMPTY window is a positive
  // answer here, not an absent one; see readInteractionLedger's note.
  const entries = await readInteractionLedger(page, windowMs);
  if (entries === null) return;
  if (entries.some((entry) => entry.kind === "submit")) return;
  // Proof 4: the click was retargeted off the control, so it never activated it.
  if ((await clickLandedOnControl(probeHandle, windowMs)) !== false) return;
  // Proof 1 again, in the same turn as the click below — the three reads above are
  // round trips to the page, and this is the only proof that can go stale in them.
  if (wait.issuedCount() > 0) return;

  // Name WHICH of the two lost shapes this was, because they point at different
  // things in the page: a click that went somewhere else means the DOM moved under
  // the interaction, and no click at all means the control was disabled at mouseup.
  const shape = entries.some((entry) => entry.kind === "click")
    ? `was RETARGETED off this control onto another element`
    : `was DROPPED before any DOM event — which Chromium does for a \`disabled\` ` +
      `control, so this control was disabled at mouseup`;
  wait.note(
    `the first click ${shape}, and produced no submit event and no request ` +
      `within ${LOST_SUBMIT_PROOF_MS}ms, so the form was never activated and ` +
      `nothing could have been written; the click was re-dispatched ONCE (#3359). ` +
      `This message means the SECOND one was lost too — that is a finding about ` +
      `the page, not about this contract.`
  );
  // A RESCUE THAT SUCCEEDS MUST STILL ANNOUNCE ITSELF. Do not remove this line, and
  // do not make it conditional on the test failing.
  //
  // `wait.note` only reaches a reader if the SECOND click is lost too, because it
  // is printed by the timeout's diagnosis. So without this log a WORKING rescue is
  // completely silent — and this helper runs in several hundred specs. If the app
  // ever genuinely starts losing submits, every one of those specs would quietly
  // retry past it and stay green, and the suite would be answering "does a second
  // click work?" when the question asked was "does a click work?". That is the same
  // shape as an absence assertion whose bug's window has closed: the check still
  // passes, against the very defect it exists to catch, and nothing on screen says
  // so.
  //
  // The economics only work if it is loud in exactly one direction. A rescue that
  // never fires costs nothing and prints nothing; a rescue that fires puts the
  // control, the page and the shape into the run's output, so ONE grep over a CI
  // run answers "is the app losing submits, and where" — which is the question this
  // instrumentation exists for and the question silence forecloses.
  //
  // MARKING THE DELIBERATE ONE IS NOT DECORATION. `substance-use.spec.ts` forges a
  // lost click on purpose, to pin that a rescue still logs exactly one use — and it
  // forges it on THE VERY CONTROL AND ROUTE #3359 was seen on, so its line would
  // otherwise be character-for-character identical to a real sighting. Three
  // deliberate hits per run would then sit in the grep output looking exactly like
  // the thing the grep is for, and the one signal this instrumentation exists to
  // give would arrive pre-buried. A page that forged its own loss declares it, so
  // the two are never confusable and the reader has nothing to subtract by hand.
  //
  // AND DO NOT TURN THE MARK INTO AN EXEMPTION. The obvious next step from here is
  // to make this log conditional on `__allosForgedLostSubmit` being UNSET, so a
  // forged run prints nothing and a grep over CI comes back clean. Do not.
  //
  // Those forged lines are the ONLY execution this announcement path gets in CI.
  // Suppress them and it becomes untested code that runs for the first time on the
  // day it matters — which is the #3260 shape exactly: an opt-out whose stated
  // reason had gone false, nothing anywhere checking that it was still true, and
  // main red three hours a day for weeks before anyone noticed. Their ABSENCE from
  // a run is itself the thing worth investigating, so the silence carries
  // information an exemption would destroy.
  //
  // If the output ever needs quieting, the answer is a BETTER MARKER, never a
  // suppressed one.
  const provenance = control.forged
    ? `This page set __allosForgedLostSubmit, so the loss was FORGED BY A SPEC on ` +
      `purpose and proves only that the rescue works.`
    : `NOT forged: if this line is in a GREEN run, the app lost a submit and the ` +
      `spec only passed because of the retry.`;
  console.log(
    `[settledClick] LOST-SUBMIT RESCUE (#3359): re-dispatching a click on ` +
      `${control.label} at ${new URL(page.url()).pathname} — the first one ` +
      `${shape}. ${provenance}`
  );
  await locator.click({ timeout: LOST_SUBMIT_PROOF_MS }).catch(() => {
    // A second click that cannot land adds nothing to the diagnosis the caller is
    // about to throw, and must not replace it.
  });
}

// Click `locator` and await the Server Action POST it fires before returning.
//
// When it resolves the mutation is durably applied; the follow-up `expect(...)`
// asserts the re-rendered UI (React applies the revalidated payload on the next
// tick — the assertion's own retry absorbs that sub-tick). For a click whose
// assertion needs the router to have APPLIED that payload, use
// settledClickApplied.
//
// WORKS when: the click definitely triggers exactly one same-origin POST (form
// submit, action button). PREFER this over networkidle/waitForTimeout/toPass for
// those.
//
// DOES NOT WORK when: the click fires NO action (a pure client toggle, an
// `<a href>` navigation with no action) — there is no POST to await and this will
// time out. Use followLink for navigations and hydratedClick/a plain `expect` for
// client-only state (decision tree above). If a click fires an action AND
// navigates, this still resolves on the action POST.
//
// The wait is correlated with the click; see armActionPost above for what that
// does and does not guarantee.
//
// ── Why it waits for hydration first (#2599, sighting 2) ─────────────────────
//
// A `<form action={serverAction}>` submit is swallow-proof by construction: before
// React attaches, the form still carries a real `action` attribute and the click
// posts natively (armActionPost matches exactly that case by route, since a
// pre-hydration submit carries no `next-action` header). A `<button onClick>` that
// calls a Server Action through `useTransition` — ReprocessDiffPanel's "Preview
// changes", every Family create/grant button — has NO such fallback: a click
// dispatched in the hydration window does nothing at all, and this helper then
// waits its whole budget for a POST that was never going to happen. Under a 20×
// CPU throttle that reproduces 4/4 on `import-records-browser.spec.ts`'s preview
// click, with the un-hydrated probe reading `false` at the moment of the click.
//
// So the click is gated on React's own hydration markers — the same probe
// settledFill and hydratedClick use — and then dispatched ONCE. This is not a
// retry: a Server Action click is rarely idempotent, and clicking twice is the
// #2437 defect. It is the pre-hydration window closed at the one chokepoint every
// action click already goes through, so no call site has to know which of the two
// shapes above it is holding.
export async function settledClick(
  page: Page,
  locator: Locator,
  opts: { timeout?: number; url?: RegExp } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 15_000;
  const here = new URL(page.url());
  // ONE ceiling, honoured by BOTH halves (#1858). This pre-assert used to run at
  // Playwright's 5s expect default and ignore `opts.timeout` entirely, so a caller
  // that widened the ceiling because the PREVIOUS interaction's revalidated render
  // is slow still lost here — the target of the click is itself part of that
  // re-render (`wellness-practices`' post-create card, the census row that named
  // this). The budget is a shared DEADLINE rather than two independent ceilings, so
  // `{ timeout: 20_000 }` can never consume 40s and re-open the >30s trap the
  // "declared ceiling above 30s" section of docs/internals/e2e-hygiene.md is about;
  // the response wait gets whatever the pre-assert did not spend (floored, so it
  // always gets a real attempt and can report its own diagnosis, not a 0ms expiry).
  const deadline = Date.now() + timeout;
  await expect(locator).toBeVisible({ timeout });
  // The hydration gate (see the note above). Inside the SAME deadline, so it can
  // never widen the ceiling the call site declared.
  await expect(async () => {
    const hydrated = await locator.evaluate((el) =>
      Object.keys(el).some(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")
      )
    );
    expect(hydrated, "action control not hydrated yet").toBe(true);
  }).toPass({ timeout: Math.max(1_000, deadline - Date.now()) }); // topass-ok: polls for React's hydration markers on this node — a state, not an interaction; the click stays outside the loop so a non-idempotent action is never fired twice
  const rest = Math.max(1_000, deadline - Date.now());

  // The diagnosis probe's stable reference to the node about to be clicked (#3029)
  // — resolved NOW because the failure state it reads (a pending SubmitButton) is
  // one the caller's locator may no longer match. Best-effort: the element is
  // already visible, so this is one cheap round-trip, and a null just means the
  // failure path reports less.
  const probeHandle = await locator
    .elementHandle({ timeout: 1_000 })
    .catch(() => null);
  // Once per page, and a no-op on every later call (see the ledger's note above).
  await installInteractionLedger(page);

  const wait = armActionPost(page, here, { timeout: rest, url: opts.url });
  // Held outside the try so the CATCH can tell "the app fired no POST" from "the
  // click never landed" — see the catch below. A one-field holder rather than a
  // bare `let`, because the assignment happens inside a `.catch()` callback and
  // TypeScript's flow analysis narrows such a `let` back to `null` for the catch
  // clause, which is precisely where it has to be readable.
  const click: { error: Error | null } = { error: null };
  try {
    // Set INSIDE the same synchronous turn as the click: the wait is already
    // listening (a fast action cannot resolve in the gap), and the browser cannot
    // have issued the click's request before the click.
    wait.begin();
    // The click and the wait share one deadline, so a click that never becomes
    // actionable (a disabled Save, a button under a closing popover) expires at the
    // same moment as the response wait — and `Promise.all` then reports whichever
    // rejected first, which is usually the wait. That would blame "no POST" for a
    // click that never happened. Hold the click's failure and report it alongside,
    // the same way followLink surfaces `lastClickError` (#890).
    const clicked = locator.click({ timeout: rest }).catch((err: unknown) => {
      click.error = err instanceof Error ? err : new Error(String(err));
    });
    await Promise.all([
      wait.settled,
      clicked,
      redispatchLostSubmit(page, locator, probeHandle, wait, click, rest),
    ]);
    // The response landed, but the click behind it did not: something else on the
    // page produced that POST, so the caller's premise is already false.
    if (click.error) throw click.error;
  } catch (err) {
    // The hold above only worked when the WAIT succeeded. When both halves fail —
    // which is the normal shape of a click that never lands, since they share one
    // deadline — `Promise.all` rejects with whichever lost the coin flip, and the
    // "NO same-origin POST was seen at all" diagnosis then blamed a page that was
    // never asked to post. That misdirection cost a whole session in #2599: the
    // real cause was a cancelled confirm's overflow-menu backdrop covering the
    // button, i.e. a click Playwright refused to dispatch. The click's own failure
    // is the more proximate fact, so it leads.
    if (click.error) {
      click.error.message +=
        `\n\n[settledClick] the CLICK ITSELF failed, so no Server Action POST ` +
        `was ever going to follow it — the response wait's timeout is a ` +
        `CONSEQUENCE of this, not an independent symptom. Look at what is ` +
        `covering or disabling this control, not at the app's traffic.`;
      throw click.error;
    }
    throw wait.diagnose(
      err,
      "settledClick",
      `If this control is a pure CLIENT toggle (a disclosure, a chip, an overflow ` +
        `menu, a dialog opener) it never posts: use hydratedClick and assert what ` +
        `it reveals. If it navigates, use followLink. If it posts somewhere other ` +
        `than this route, pass { url }.` +
        (await clickedControlState(probeHandle)) +
        (await interactionLedgerReport(page, probeHandle, wait.armedAt))
    );
  } finally {
    wait.release();
  }
}

// Click a Server-Action control AND return only once the router has APPLIED the
// revalidated tree, proven by a marker that tree renders (issue #1858).
//
// WHY THIS IS A SECOND HELPER. `settledClick` guarantees exactly one thing: the
// action completed SERVER-SIDE. The router applying the revalidated payload is a
// separate, much slower event, and the two were being spelled the same way at
// hundreds of call sites — click, then assert the re-rendered DOM on the plain 5s
// expect default. #1964 measured the gap end to end: the action's own resolution
// lands 0.03–0.39s after `settledClick` returns even under a 20× CPU throttle,
// while the apply lags 0.06–0.27s unthrottled and 0.47–3.33s THROTTLED, with 7×
// run-to-run spread — because `revalidatePath` also invalidates the client router
// cache, so every visible <Link> re-prefetches (~25 `_rsc` GETs, then the whole set
// again under a second cache key) on the same main thread that has to render the
// payload. Five recurring-failure census rows came out of that one gap, four of
// them closed by raising a named ceiling at the call site. This helper is that
// ceiling, named ONCE, attached to the guarantee it actually belongs to.
//
// THE CONTRACT. When this returns: (1) a correlated Server Action POST completed —
// everything `settledClick` promises, and nothing more (see its note above); and
// (2) `applied` is VISIBLE, i.e. the browser has committed a tree containing it.
//
// WHAT IT DOES NOT GUARANTEE, said plainly:
//   • It cannot tell WHICH tree it saw. If `applied` was already visible before the
//     click, this returns immediately and proves nothing at all. The marker must be
//     something the mutation PRODUCES or CHANGES — the "prove a guard both ways"
//     rule in docs/internals/e2e-hygiene.md. Assert-what-changed, not what was
//     already there.
//   • A marker a CLIENT component can render from its own state (an optimistic
//     update, a `useState` flip in the handler) is not evidence of a server render.
//     Pick a server-rendered marker — the `mood-server-logged` precedent.
//   • The marker is a POSITIVE one on purpose. An ABSENCE ("the panel closed") is
//     the #1964 trap: a stale tree and an applied tree are the same DOM when the
//     thing you are looking for is gone, so the assertion cannot say which it saw.
//     If absence is what your test is about, pass a positive marker here and assert
//     the absence on the line below, against a page already proven settled.
//   • It is not a general "the router applied" signal, and there deliberately is
//     none: every available signal is heuristic, and a wrong one would buy a new
//     class of FALSE GREEN. The marker is supplied by the call site because the
//     call site is the only thing that knows what the re-render should say.
//
// The two halves carry SEPARATE ceilings because they fail for different reasons:
// `timeout` (15s, settledClick's) is "the action never posted", which is nearly
// always a wrong call site; `appliedTimeout` (20s — the value all four census rows
// independently converged on, ~6× the worst apply measured) is "the render never
// arrived". Their sum can exceed the 30s test default, so a call site that raises
// either adds `test.slow()`, per the "declared ceiling above 30s" rule in
// docs/internals/e2e-hygiene.md.
export async function settledClickApplied(
  page: Page,
  locator: Locator,
  applied: Locator,
  opts: { timeout?: number; url?: RegExp; appliedTimeout?: number } = {}
): Promise<void> {
  const { appliedTimeout = 20_000, ...clickOpts } = opts;
  await settledClick(page, locator, clickOpts);
  await expect(
    applied,
    "[settledClickApplied] the Server Action completed, but the marker proving " +
      "the router applied the revalidated tree never rendered. Either the " +
      "re-render is genuinely slower than appliedTimeout (raise it AND add " +
      "test.slow()), or this marker is not in the tree the action revalidates."
  ).toBeVisible({ timeout: appliedTimeout });
}

// Fill a form field so its value durably lands in React STATE, not just the DOM —
// the input analog of followLink's pre-hydration guard.
//
// Root cause: a `.fill()` dispatched before React hydrates the input sets the DOM
// value (a plain `toHaveValue` then passes) but never fires the input's `onChange`,
// so a CONTROLLED input's state stays unchanged and hydration REVERTS the field to
// state. Anything that then reads STATE — a Save that builds its payload from
// component state (Settings' `PublicUrlSettings`/`SmtpSettings`) — persists the
// empty/stale value, SILENTLY (an empty value is often a valid save), and no
// value-assertion catches it because the DOM looked set. That widened hydration
// window under `--workers>1`/CI load is the same one followLink handles for clicks;
// it was the ~1/3-under-load email-auth:58 flake.
//
// Wait until React has hydrated THIS element (on hydration React attaches
// `__reactFiber$…`/`__reactProps$…` own-properties to the DOM node) BEFORE filling,
// so `.fill()`'s input event fires `onChange` and the value lands in state; then
// confirm it holds. WORKS for text/number inputs and textareas.
//
// NOTE: settledFill guarantees the value reached React state — NOT that a later save
// or navigation kept it. When the fill feeds a save whose success is SILENT (empty
// is valid), also confirm the PERSISTED effect after saving (reload + assert), the
// email-auth precedent.
//
// DO NOT USE on a field whose RENDERED text differs from the value you fill — it
// would HANG, not fail. The self-check below is `toHaveValue(value)`, and a
// `DateField` re-renders `2026-08-03` as `Aug 3, 2026` (its input's `value` is
// `formatDateWithYear(val)`), so the post-condition can never hold and this retries
// to its timeout on a fill that WORKED. Those fields are self-verifying anyway —
// a DateField's calendar opens only through React's `onFocus`, so a swallowed fill
// fails on the very next line. Assert the downstream effect instead. (#1941)
//
// The retry loop — not the hydration check — is what rescues a control whose
// `onFocus` WRITES state (`Combobox` opens its listbox; `StrengthSets`' first-set
// fields apply the ghost suggestion). `.fill()` focuses before it types, so that
// write interleaves with the clear-and-type and the first attempt lands corrupted
// or empty; the second attempt sticks. (#1941)
// Turn the set grid's effort column on or off from the editor's own options row
// (#3335) — the affordance the acceptance criterion calls "discoverable without a
// settings trip". IDEMPOTENT, so a test can assert its starting side of the
// boundary rather than assuming a previous run left it there.
//
// The checkbox input is `sr-only` (BrandedCheckbox paints the visible box off the
// peer), so the click goes to the label text, the same way the per-side toggle is
// driven in entry-ergonomics and form-hygiene.
//
// Turning it ON settles on the marker that proves the router applied the answer —
// the column itself. Turning it OFF cannot: the marker would be an ABSENCE, and a
// retrying wait for something to vanish is the shape that passes against the bug it
// exists to catch. So the off path settles on the Server Action POST and then reads
// the checkbox, which is a PRESENT element either way.
export async function setRpeColumn(page: Page, on: boolean): Promise<void> {
  await openPartOptions(page, 0);
  const box = page.getByTestId("rpe-tracking-checkbox");
  // Still exactly one, and now it means MORE than it did: at most one options panel is
  // open across the whole form (#3349), so a second part cannot be showing its own.
  await expect(box).toHaveCount(1);
  if ((await box.isChecked()) !== on) {
    const label = page.getByText("Rate effort (RPE)", { exact: true });
    if (on) {
      await settledClickApplied(page, label, page.getByTestId("set1-rpe"));
    } else {
      await settledClick(page, label);
    }
    await expect(box).toBeChecked({ checked: on });
  }
  await closePartOptions(page);
}

// ── The per-part options editor (#3349) ──────────────────────────────────────
//
// `Track sides separately`, `Target reps`, `To failure` and the RPE opt-in used to be
// a row of four controls drawn on every exercise. They are one tap behind the part's
// fact chips now — every testid unchanged, only relocated — so a spec that drives one
// of them opens the panel first.
//
// WHICH CHIP OPENS IT depends on what the part currently states: a part rating effort
// has a `part-fact-effort` chip, one that is not has that fact behind the trailing
// affordance instead. All of them open the SAME panel — equipment is the one fact that
// does not, and it keeps its own chip in the row rather than going behind the
// affordance (#3349 AC 1) — so this takes whichever is there rather than making every
// caller work out which state it is in.
//
// `index` IS REQUIRED. It was defaulted to 0 while every caller drove a single-part
// form, which is honest right up until it silently is not: a multi-part spec that
// omits it drives part 1's panel while believing it drives part 3's, and the helper
// has chosen the assertion's subject. Say which part.
export async function openPartOptions(
  page: Page,
  index: number
): Promise<void> {
  const part = page.getByTestId("activity-part").nth(index); // nth-ok: the caller names which part it means
  await part
    .getByTestId("part-fact-more")
    .or(part.getByTestId("part-fact-sides"))
    .or(part.getByTestId("part-fact-intent"))
    .or(part.getByTestId("part-fact-effort"))
    .first() // first-ok: these four chips all open the one options panel, and a part can render several at once
    .click();
  await expect(page.getByTestId("part-options-editor")).toBeVisible();
}

// Closes on a PRESENCE — the chip row coming back — rather than on the panel's
// absence. A retrying wait for something to vanish is satisfied by a form that never
// rendered, which is the one failure this settle exists to distinguish.
export async function closePartOptions(page: Page): Promise<void> {
  await page.getByTestId("part-options-done").click();
  await expect(page.getByTestId("part-fact-row").first()).toBeVisible(); // first-ok: the row that just came back; a multi-part form has one per part and any of them proves the panel closed
}

export async function settledFill(
  page: Page,
  field: Locator,
  value: string,
  opts: { timeout?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 10_000;
  await expect(field).toBeVisible();
  await expect(async () => {
    const hydrated = await field.evaluate((el) =>
      Object.keys(el).some(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")
      )
    );
    // Not hydrated yet → toPass retries (the fill would be reverted). Once React has
    // attached, the fill fires onChange and the value sticks in state.
    expect(hydrated, "input not hydrated yet").toBe(true);
    await field.fill(value);
    await expect(field).toHaveValue(value, { timeout: 2_000 });
  }).toPass({ timeout });
}

// Choose a `<select>` option so the change durably lands in React STATE — the
// select analog of settledFill/settledCheck.
//
// Same root cause: a `selectOption()` dispatched before React hydrates a CONTROLLED
// select sets the DOM value but fires no `onChange`, so state never moves and
// hydration REVERTS it — and for a select whose handler NAVIGATES (the responsive
// tables' card-mode sort control, #1426) the swallowed change leaves no trace at all:
// no POST to await, no URL to watch, just a spec that times out on the destination.
//
// Wait for React's hydration markers on the node, then select; retrying is safe
// because `selectOption` sets an ABSOLUTE value (unlike a toggle, a second
// application is a no-op), so the whole thing sits inside the probe.
export async function settledSelect(
  page: Page,
  select: Locator,
  value: string,
  opts: { timeout?: number; destination?: RegExp } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 10_000;
  await expect(select).toBeVisible();
  await expect(async () => {
    const hydrated = await select.evaluate((el) =>
      Object.keys(el).some(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")
      )
    );
    // Not hydrated yet → toPass retries (the selection would be reverted). Once
    // React has attached, the change fires onChange and the value sticks.
    expect(hydrated, "select not hydrated yet").toBe(true);
    await select.selectOption(value);
    await expect(select).toHaveValue(value, { timeout: 2_000 });
    // A controlled select can update its own DOM value before a router.push()
    // finishes. When the selection navigates, make that destination part of the
    // same retry boundary so a swallowed or slow transition re-selects the
    // absolute value instead of leaving the caller to time out on the source URL.
    if (opts.destination) {
      await expect(page).toHaveURL(opts.destination, { timeout: 2_000 });
    }
  }).toPass({ timeout });
}

export async function settledSelectSave(
  page: Page,
  select: Locator,
  value: string,
  scope: Locator,
  opts: { timeout?: number } = {}
): Promise<void> {
  await settledSelect(page, select, value, opts);
  await awaitAutosaveSettled(scope);
}

// settledFill + await the card's autosave spinner — the text/time-input analog of
// settledSelectSave, for autosaving inputs (e.g. the #2121 minute-grain schedule
// time inputs) whose change handler fires a Server Action.
export async function settledFillSave(
  page: Page,
  field: Locator,
  value: string,
  scope: Locator,
  opts: { timeout?: number } = {}
): Promise<void> {
  await settledFill(page, field, value, opts);
  await awaitAutosaveSettled(scope);
}

// Hand files to a <MediaInput> and await the Server-Action POST its CONFIRM
// fires — the settledClick idiom for an upload surface.
//
// THE POST MOVED (#3286) and this comment used to describe where it was: the
// pick itself used to submit, because a hidden input's `onChange` went straight
// to the action. It no longer does. Files are STAGED by the pick and committed
// by the confirm, which is what lets a batch be listed per file and a drop or a
// paste arrive by the same route — so the wait is armed around the confirm
// CLICK, and arming it around `setInputFiles` would wait for a POST that the
// pick no longer makes.
//
// We arm the POST wait BEFORE the click (so a fast upload can't resolve in the
// gap), then await it, so the follow-up `expect(...)` runs against the durably-
// applied strip rather than a bare timed count poll. WORKS when the confirm
// fires exactly one Server Action per file; a multi-file batch posts once per
// file, so pass a single file here.
//
// The wait goes through the SAME armActionPost predicate settledClick uses
// (#1952). It used to be the pre-#1958 "any same-origin POST", which was the same
// silent-green defect: the settle could land on a revalidation from an earlier step
// or the offline queue's `/api/offline-replay` flush and prove nothing about the
// upload — measured on CI, where the settle resolved and no thumbnail rendered for
// 15s. Both call sites had wrapped it in a 45s `toPass` re-upload loop to survive
// that; correlating the wait is what makes the loop unnecessary rather than
// load-bearing.
export async function settledUpload(
  page: Page,
  input: Locator,
  files: Parameters<Locator["setInputFiles"]>[0],
  opts: { timeout?: number; url?: RegExp } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 20_000;
  await input.setInputFiles(files);
  const submit = page.getByTestId("media-input-submit");
  await expect(submit).toBeVisible();
  const here = new URL(page.url());
  const wait = armActionPost(page, here, { timeout, url: opts.url });
  try {
    // Same synchronous turn as the interaction, exactly as in settledClick.
    wait.begin();
    await Promise.all([wait.settled, submit.click()]);
  } catch (err) {
    throw wait.diagnose(
      err,
      "settledUpload",
      `The confirm must submit a Server Action. If this upload posts to a route ` +
        `handler instead, it is not a settledUpload site — await the route's own ` +
        `response. If it posts somewhere other than this route, pass { url }.`
    );
  } finally {
    wait.release();
  }
}

// ── Touch gestures (issues #1425 / #1469) ────────────────────────────────────
//
// Drive a real one-finger drag. Playwright's `page.touchscreen` only taps, and
// `page.mouse` produces `pointerType: "mouse"` events which the shell/page
// gestures deliberately ignore (a mouse drag across a page is a text selection,
// not a navigation). So this goes through CDP `Input.dispatchTouchEvent`, the
// same channel `touchscreen.tap` uses: Chromium runs it through its real input
// pipeline, which is what produces the compatibility PointerEvents the
// recognizer (components/overlay/useDragGesture.ts) listens for — including the
// `pointercancel` the browser fires when it decides the gesture is a scroll.
// Synthesising PointerEvents in `page.evaluate` would bypass exactly that
// arbitration and prove nothing about the behaviour that matters.
//
// `stepDelayMs` is how a spec chooses between the two commit paths in
// lib/gesture.ts: 0 (the default) is a fast flick, a delay makes the same
// distance a slow drag that must clear `commitPx` on distance alone.
//
// TWO ENTRY POINTS, and the choice is about WHERE THE GESTURE MUST START:
//
//   * `touchSwipe(page, from, to)` — a gesture anchored to the DOCUMENT. The
//     drawer's edge swipe and the Timeline's day swipe are these: they name a
//     screen coordinate ("2px from the left edge", "mid-page"), no element has to
//     be under it, and the recognizer runs with no `targetRef` to satisfy.
//   * `touchSwipeFrom(page, locator, delta)` — a gesture that must start INSIDE
//     an element: a drag handle, a panel. The recognizer tests containment at
//     touch-start, so where the finger lands is not a detail of the gesture, it
//     IS the gesture.
//
// Only the second can be made safe, and it has to be (#2714). See below.
type SwipeOptions = { steps?: number; stepDelayMs?: number };

export async function touchSwipe(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: SwipeOptions = {}
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y }],
    });
    await dragToEnd(page, cdp, from, to, opts);
  } finally {
    await cdp.detach();
  }
}

// The moves and the lift, shared by both entry points so the two cannot drift
// into two ideas of what a swipe is. The touch is already down when this runs.
async function dragToEnd(
  page: Page,
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: SwipeOptions
): Promise<void> {
  const steps = Math.max(2, opts.steps ?? 10);
  for (let i = 1; i <= steps; i++) {
    if (opts.stepDelayMs) await page.waitForTimeout(opts.stepDelayMs);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        },
      ],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await consumeSuppressedTap(cdp, to);
}

// ── A DRAG LEAVES ONE SWALLOWED TAP BEHIND, AND SPENDS IT HERE (#3262) ───────
//
// After a touch drag whose STARTING element forbids the axis the drag travels on,
// Chromium suppresses the tap gesture of the NEXT touch sequence. The touch
// events still flow — `touchstart`/`touchend` arrive intact, and so do the
// touch-type PointerEvents — but no `GestureTap` is produced, so the renderer
// synthesises no `mousedown`, no `mouseup` and NO `click`. Nothing in the page
// can see it happen: the element is hydrated, the handler is committed, and the
// tap simply reaches nobody.
//
// That is #3262, and it is the whole of it. Measured in this repo, Chromium
// 1194, phone viewport, on a standalone page with no React in it at all:
//
//   touch-action on the element the drag STARTS on   next tap's click
//   ------------------------------------------------ ----------------
//   none                                             lost 6/6
//   pan-x        (forbids the vertical drag)         lost 6/6
//   pan-y        (permits it)                        lost 0/6
//   manipulation (permits it)                        lost 0/6
//   auto                                             lost 0/6
//
// Re-run it yourself: `node scripts/tap-suppression-probe.mjs`.
//
// So it is not a fling, not a scroll, and not multi-touch: it is the browser's
// tap arbitration for a gesture it was told it may not have. The sheet's drag
// handle is `touch-none` on purpose (components/overlay/tokens.ts — the panel's
// own scroller would otherwise steal the drag), so every flick this suite drives
// from a handle incurs the debt.
//
// The debt is exactly ONE touch sequence, and only for ~300 ms: measured lost at
// gaps of 0–300 ms after the drag's lift, recovered by 350–400 ms, and the
// SECOND tap always lands (0/6 lost) however soon it comes. A CPU throttle does
// not move the window — 20x on the renderer left it where it was — which is why
// the throttling recipe in docs/internals/e2e-hygiene.md answered "nothing
// wrong" for five probe rounds: the timer is in the BROWSER process, and the
// instrument only slows the renderer.
//
// WAITING IT OUT WOULD BE THE WRONG FIX. The window is a wall-clock timer we
// cannot observe from the page, so any sleep would be a guess that a loaded
// runner can outlast — the flake would come back quieter. SPENDING the sequence
// is state-based instead: a `touchStart` immediately cancelled is a complete
// touch sequence to the browser's arbitration and can never produce a click by
// construction, so it consumes the suppression and does nothing else. It is
// inert for the app too — every recognizer in components/overlay/useDragGesture.ts
// requires a CLAIMED axis before it calls anything, claiming requires movement,
// and nothing moved; `PullToRefresh` reads the same touchstart and arms nothing.
//
// Measured over 24 trials each, gap 14–103 ms, on the same page:
//   without this call: 23/24 taps lost.  with it: 0/24.
//
// It runs after EVERY drag, not only the ones that started on a restricted
// element. A drag that was allowed its axis has no suppressed tap to spend, so
// the call is a no-op there — one path is cheaper than a rule about which drags
// owe it, and a future gesture over a `touch-none` surface cannot forget.
async function consumeSuppressedTap(
  cdp: CDPSession,
  at: { x: number; y: number }
): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: at.x, y: at.y }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
}

// ── An element-anchored swipe PROVES where the finger landed (#2714) ─────────
//
// A point measured from an element is stale the instant it is measured, and
// `centerOf`'s settling cannot fix that: it proves the element held still across
// one 50ms window, never that it will hold still for the next one. On a
// BOTTOM-ANCHORED surface that gap is not theoretical. The quick-log sheet
// gathers its "Due & usual now" row lazily on every open (#1468 — the offers
// must be fresher than the page), and when that Server Action lands the sheet
// grows; a bottom-anchored panel grows UPWARD, so the drag handle leaves the
// coordinate a settled measurement had just certified.
//
// What happens next is the reason this helper exists rather than a longer wait:
// the touch lands on whatever slid into that coordinate, the recognizer's
// containment test (components/overlay/useDragGesture.ts) rejects it, and the
// gesture is never claimed — so NOTHING HAPPENS, silently. #2714 is that:
// `expect(sheet).toHaveCount(0)` did not miss a deadline, it waited five seconds
// for an exit that was never going to begin. No budget and no arrival signal
// would have helped, because the end state was not on its way.
//
// So the finger is not committed until it is proven to be on the element. The
// touch starts, the helper reads the target of the touchstart the browser
// actually dispatched — the same `contains()` fact the recognizer keys on, not a
// re-hit-test that could disagree with it — and only then moves. A landing that
// misses is cancelled before a single move, and the aim is re-taken against the
// element's new position.
//
// That is a PROBE, not a retry of an attempt, and the distinction is exact
// rather than a hopeful reading: every recognizer in the app requires a claimed
// axis before it calls anything, claiming requires MOVEMENT, and nothing has
// moved. The #2437 rule against re-driving a non-idempotent interaction — and
// this file's own "a swipe cannot be retried, a re-fired day-swipe skips a day"
// — are both untouched, because no gesture was driven.
//
// The re-aim is bounded, and running out is a LOUD failure naming the cause. A
// surface still relaying out after four settled measurements is a defect in the
// surface, and quietly swiping at it forever would be the timeout raise this
// issue refused.
const GESTURE_AIM_ATTEMPTS = 4;
const TOUCH_START_TARGET = "__e2eTouchStartTarget";

export async function touchSwipeFrom(
  page: Page,
  target: Locator,
  delta: { dx?: number; dy?: number },
  opts: SwipeOptions = {}
): Promise<void> {
  const dx = delta.dx ?? 0;
  const dy = delta.dy ?? 0;
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let attempt = 1; attempt <= GESTURE_AIM_ATTEMPTS; attempt++) {
      const from = await centerOf(target);
      // Armed BEFORE the touch, read AFTER it: the browser's own dispatch is
      // what decides the target, so that is what gets asked.
      await page.evaluate((key) => {
        const store = window as unknown as Record<string, unknown>;
        store[key] = null;
        document.addEventListener(
          "touchstart",
          (e) => {
            store[key] = e.target;
          },
          { capture: true, once: true, passive: true }
        );
      }, TOUCH_START_TARGET);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: from.x, y: from.y }],
      });
      const landed = await target.evaluate((el, key) => {
        const origin = (window as unknown as Record<string, unknown>)[key];
        return origin instanceof Node && el.contains(origin);
      }, TOUCH_START_TARGET);
      if (landed) {
        await dragToEnd(
          page,
          cdp,
          from,
          { x: from.x + dx, y: from.y + dy },
          opts
        );
        return;
      }
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchCancel",
        touchPoints: [],
      });
    }
    throw new Error(
      `touchSwipeFrom: the target moved out from under the gesture on all ` +
        `${GESTURE_AIM_ATTEMPTS} attempts, each aimed at a settled measurement. ` +
        `Something is still relaying the surface out after it comes to rest — ` +
        `find what arrives late (a lazily gathered section is the usual answer, ` +
        `see #2714) rather than widening a wait.`
    );
  } finally {
    await cdp.detach();
  }
}

// ── Streamed-reveal guard (#1644/#1674) ──────────────────────────────────────
//
// A page that streams a Suspense boundary (the Trends landing surface's body
// census) delivers the boundary's content in a `<div hidden id="S:n">` staging
// node at the end of `<body>`; React then MOVES it into place, on a schedule of
// its own (a rAF, or a coalescing timeout). Until that reveal runs, a testid
// inside the streamed content matches TWO nodes — the hidden staged copy and,
// mid-move, the revealed one — which a strict-mode locator reports as a
// duplicated-element bug, and on a loaded CI shard the reveal can lag SECONDS
// behind the load event, so per-spec waits with default 5s ceilings kept losing.
//
// This guard closes the class at the harness level: every full-document
// navigation (goto/reload/back/forward — client-side navigations render in
// place and never stage) waits until no staging node remains before returning,
// with a generous named ceiling. Installed once, on every page of every
// context, by the `browser` fixture's newContext patch — so no spec ever calls
// anything, and a future spec cannot forget to.
const STREAM_REVEAL_TIMEOUT_MS = 30_000;

async function settleStreamedReveal(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('div[hidden][id^="S:"]').length === 0,
      undefined,
      { timeout: STREAM_REVEAL_TIMEOUT_MS }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A destroyed context (an immediate follow-up navigation, a closed page, a
    // non-HTML response) is not a stuck reveal — only a genuine timeout is.
    if (/Timeout.*exceeded/i.test(message)) {
      throw new Error(
        `streamed content was still staged (hidden div[id^="S:"]) ` +
          `${STREAM_REVEAL_TIMEOUT_MS}ms after navigation to ${page.url()} — ` +
          `React's reveal never ran; see e2e/helpers.ts settleStreamedReveal`
      );
    }
  }
}

export function installStreamRevealGuard(page: Page): void {
  for (const method of ["goto", "reload", "goBack", "goForward"] as const) {
    const original = page[method].bind(page) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    (page as unknown as Record<string, unknown>)[method] = async (
      ...args: unknown[]
    ) => {
      const result = await original(...args);
      await settleStreamedReveal(page);
      return result;
    };
  }
}

// Open the shared Combobox's dropdown (components/Combobox.tsx) on an EMPTY query —
// which, for a picker that passes `groupFor`, is its relevance view (#1675).
//
// Same hydration root cause as settledFill/settledSelect: the list opens from the
// input's React `onFocus`, so a click landing before React attaches focuses the DOM
// node and nothing else — and because the node is then already focused, a retry that
// simply clicks again fires no second focus event. Waiting for the fiber markers first
// is what makes the open reliable; the assertion sits inside the retry so a slow
// hydration re-clicks rather than leaving the caller to time out on a closed list.
export async function openCombobox(
  page: Page,
  field: Locator,
  opts: { timeout?: number } = {}
): Promise<Locator> {
  const timeout = opts.timeout ?? 15_000;
  await expect(field).toBeVisible();
  await expect(async () => {
    const hydrated = await field.evaluate((el) =>
      Object.keys(el).some(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")
      )
    );
    expect(hydrated, "combobox not hydrated yet").toBe(true);
    await field.click();
    await expect(page.getByRole("listbox")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout });
  return page.getByRole("listbox");
}

// EVERY PICKABLE ROW of the shared Combobox's open list, for a spec that types a name
// and takes "whichever row carries it".
//
// The list holds two KINDS of row, and since #3316 they carry different roles: the
// vocabulary's rows are `option`s, and the free-text "Use '<query>'" row is a real
// `button`, because it is a COMMAND on what was typed rather than a member of the
// vocabulary. A spec that types a lift name and clicks the match wants either — the
// name may already be in the catalog, or the spec may be about to create it — so
// asking for one role would break on whichever case it did not anticipate. (That is
// not hypothetical: it is exactly what a role-by-role sweep of this file's callers
// turned red, because a plain `getByRole("button")` used to match BOTH.)
export function comboboxRows(scope: Page | Locator): Locator {
  const listbox = scope.getByRole("listbox");
  return listbox.getByRole("option").or(listbox.getByRole("button"));
}

// Choose a shared-Combobox option by its VISIBLE LABEL — the combobox analog of
// settledSelect, for the pickers #1675 converted from `<select>`s.
//
// Typing the label first is deliberate: it is the app's own fuzzy search, so the row
// is found the way a user finds it, and the list is narrowed to the intended match
// instead of relying on a position in a ~200-row ranked list. The option is addressed
// by its ACCESSIBLE NAME with `exact`, so two rows that read the same fail loudly here
// (the #531 rule the option builder enforces) rather than picking an arbitrary one.
export async function settledPickOption(
  page: Page,
  field: Locator,
  label: string,
  opts: { timeout?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 15_000;
  await expect(async () => {
    await settledFill(page, field, label, { timeout: 5_000 });
    const option = page
      .getByRole("listbox")
      .getByRole("option", { name: label, exact: true });
    await expect(option).toBeVisible({ timeout: 2_000 });
    await option.click();
    await expect(field).toHaveValue(label, { timeout: 2_000 });
  }).toPass({ timeout });
}

// ── The #2471 automatic update reload, switched off for one page ──────────────
//
// Since #2471 a tab that notices a deploy converges on the new build by itself at
// the first provably-safe moment, and the "Update ready" bar / stale-save banner
// survive ONLY as the rationed-failure fallback: the automatic attempt has been
// spent and the tab is still stale. Every spec that drives one of those affordances
// therefore has to put the tab in that state first — otherwise it is asserting on a
// surface the app is right not to render.
//
// This seeds the ration as already spent, for every target, and keeps refreshing it
// so a long spec cannot age out of its 60s window mid-test. It simulates a state the
// app genuinely reaches (one automatic attempt already made); it does not disable
// anything the app would otherwise do.
export async function spendAutoReloadRation(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, targets, refreshMs }) => {
      // clock-ok: runs IN the page, whose clock the harness freezes for the whole run — the same clock the guard's own window is measured against
      const write = () =>
        sessionStorage.setItem(
          key,
          JSON.stringify({ targets, at: Date.now() })
        ); // clock-ok: as above

      write();
      setInterval(write, refreshMs);
    },
    {
      key: AUTO_RELOAD_KEY,
      // Two distinct targets is the window total, so the ration reads as spent for
      // any sha the spec's simulated deploy names.
      targets: ["e2e-ration-spent-a", "e2e-ration-spent-b"],
      refreshMs: 5_000,
    }
  );
}

// ── Going offline honestly ───────────────────────────────────────────────────
//
// PLAYWRIGHT'S OFFLINE EMULATION IS PER-BROWSER-CONTEXT AND DOES NOT COVER REQUESTS
// THE SERVICE WORKER MAKES. In Chromium `context.setOffline(true)` cuts the page's
// own fetches; the worker's `fetch()` inside `public/sw.js`'s `cacheFirst` handler
// still reaches the server. So a spec can go offline, navigate, render and pass while
// the assets it rendered from were pulled over the network during the "offline"
// navigation. A real device has no such escape hatch (#3002).
//
// Measured on this tree, because the obvious test is a lie here. Take away the one
// thing that warms the /offline shell (emergency-card's own online visit to it) and the
// counter below reads 13/15 for a full 30s poll and never climbs — two chunks the
// /offline document needs are simply not cached. The block that navigates offline PASSES
// ANYWAY, and the counter reads `warm` immediately afterwards: both missing chunks were
// fetched during the supposedly offline navigation. That is the direct proof of the
// bypass, not an inference from it.
//
// So an "it renders offline" assertion cannot see a missing chunk at all: on a real
// device that chunk is a blank page, and in the harness it is a green test. What CAN
// be asserted faithfully is the precondition — the chunk is in the cache BEFORE the
// network goes away. Assert that alongside the render, and the offline block measures
// the app instead of the harness.
//
// Blocks that only go offline on an ALREADY-LOADED page (the offline write queue:
// tap → queued → reconnect → replayed) are not exposed to this: they never navigate,
// so no shell has to come from anywhere, and the page's own POST is exactly what
// setOffline does block. The hazard is specific to navigating while offline.

/**
 * Whether every `/_next/static` asset the /offline document declares AND THIS BROWSER
 * ACTUALLY LOADS is in the service worker's cache — "warm", or a `cached/total` count
 * plus the missing URLs, to read on failure.
 *
 * Reads the cache only: the HTML fetch here populates nothing, because the worker never
 * caches rendered HTML and this is not a navigation. So a poll on this cannot be
 * self-fulfilling — with the shell un-warmed it sits at its count and never climbs.
 *
 * The `noModule` SKIP is load-bearing, not tidying. Next emits its legacy polyfill
 * bundle as `<script src="…" noModule>`, which a module-supporting browser — every
 * browser this suite runs — deliberately never requests. It is declared in the document
 * and is not part of what the page needs, so a scan that matched raw `/_next/static`
 * URLs counted an asset that can NEVER be cached however well the shell is warmed, and
 * reported a permanent shortfall. Measured on this build: 15/16 with the polyfill
 * counted, warm without it.
 */
export async function offlineChunksWarm(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch("/offline", { headers: { Accept: "text/html" } });
    const html = await res.text();
    const urls = [
      ...new Set(
        (html.match(/<(?:script|link)\b[^>]*>/g) ?? []).flatMap((tag) => {
          if (/\bnomodule\b/i.test(tag)) return [];
          const href = tag.match(
            /(?:src|href)="([^"]*\/_next\/static\/[^"]+)"/
          )?.[1];
          return href && (href.endsWith(".js") || href.endsWith(".css"))
            ? [href]
            : [];
        })
      ),
    ];
    const missing: string[] = [];
    for (const u of urls) {
      if (!(await caches.match(new URL(u, location.origin).href))) {
        missing.push(u);
      }
    }
    return urls.length > 0 && missing.length === 0
      ? "warm"
      : `${urls.length - missing.length}/${urls.length} cached (missing: ${missing.join(", ") || "none — the document declared no assets"})`;
  });
}

/**
 * The precondition every offline block that NAVIGATES shares: a live controlling
 * worker, and the offline shell's own code already in its cache. Call this before
 * `context.setOffline(true)` — it is what makes the offline render an assertion about
 * the app rather than about the harness's leaky emulation.
 */
export async function readyForOffline(page: Page): Promise<void> {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, {
    timeout: 15_000,
  });
  await expect
    .poll(() => offlineChunksWarm(page), { timeout: 30_000 })
    .toBe("warm");
}

// ── A dialog body does not overflow sideways (#3395) ─────────────────────────
//
// `tap-target` extends a compact control's hit area with an `inset: -6px`
// pseudo-element under `@media (pointer: coarse)`. The extension paints nothing
// and sits OUTSIDE the control's box, so it contributes to a scroll container's
// overflow extent while being invisible in every screenshot.
//
// Everywhere else `<main>`'s `overflow-x-clip` absorbs it silently. INSIDE A
// DIALOG BODY IT IS NOT ABSORBED: since #2774 the sheet's content region is the
// scroll owner, and since #3360 it is `overflow-x-hidden` — which refuses the
// USER but still reports the extent, and (per #3382) still lets a script park the
// box sideways. So a compact control flush against the region's right edge pushes
// 6px of nothing past it, and the only symptom is a body a thumb can nudge with
// no affordance back.
//
// THE TRIGGER IS NOT "SOMEBODY ADDS A BAD ELEMENT". It is any change that removes
// horizontal padding from a container holding a flush-edge `tap-target` control —
// which is exactly what #3361's body-chrome rule encourages, since that rule is
// about bodies NOT carrying their own insets. #3360 did it to FoodLogBar's header
// and took the food sheet to 5px (#3384, fixed in #3392 with `pr-1.5` below `md`).

/**
 * WHAT IS STICKING OUT of a scroll region, not just how far.
 *
 * KEEP THIS even when the assertion it annotates is green — a reviewer will read
 * it as dead weight and it is the opposite. `scrollWidth - clientWidth` is a
 * number with no author: the first time this went red on CI it said
 * "Received: 5" and nothing else, and 5px in a dialog body can be a bleed, a
 * hit-area pseudo-element, sub-pixel rounding, or a child that was transiently
 * wide during mount. Those need different fixes. This walks the region and ranks
 * its children by how far their ESCAPING overflow reaches past the region's right
 * edge, so the next red arrives with its cause attached instead of a bare integer.
 * It found the real one: a `tap-target` extension on the food sheet's preferences
 * button (#3384).
 */
export async function overflowStory(content: Locator): Promise<string> {
  return content.evaluate((node) => {
    const over = node.scrollWidth - node.clientWidth;
    if (over <= 0) return "nothing overflows";
    const edge = node.getBoundingClientRect().right;
    // RANKED BY REACH PAST THE REGION'S EDGE, not by "does this element overflow
    // at all". Nearly every `tap-target` in a sheet overflows its own box by 6px
    // — that is what the hit-area extension IS — and listing them all buries the
    // one that matters under a wall of innocents. Only an element whose overflow
    // actually ARRIVES at the region's right edge can make the region scrollable,
    // so that is the question asked.
    const culprits = Array.from(node.querySelectorAll("*"))
      .filter(
        (el): el is HTMLElement =>
          el instanceof HTMLElement &&
          // Only overflow that ESCAPES can make the region scrollable. A
          // `truncate` span overruns its box by a mile and clips every pixel of
          // it, so it is not a suspect — including it put three innocent labels
          // at the top of this list the first time round.
          getComputedStyle(el).overflowX === "visible"
      )
      .map((el) => ({
        el,
        reach:
          el.getBoundingClientRect().right +
          (el.scrollWidth - el.clientWidth) -
          edge,
      }))
      .filter((c) => c.reach > -0.5)
      .sort((a, b) => b.reach - a.reach)
      .slice(0, 3)
      .map(
        ({ el, reach }) =>
          `<${el.tagName.toLowerCase()} data-testid="${
            el.getAttribute("data-testid") ?? ""
          }" class="${el.className}"> reaches ${Math.round(reach)}px past`
      );
    return `region overflows by ${over}px; ${
      culprits.join(" | ") ||
      "no element reaches the edge — check text, a pseudo-element, or a mid-mount width"
    }`;
  });
}

/**
 * A dialog body holds everything it contains — nothing escapes past its right
 * edge, and the region is therefore not sideways-scrollable at all.
 *
 * `label` names the surface in the failure, because this is run over a table of
 * dialogs and "expected 5 to be <= 0" says nothing about WHICH one.
 *
 * THIS ASSERTS NOTHING ABOUT AN EMPTY REGION, and the caller is what stops it
 * being asked one. A body that is still rendering its loading paragraph fits any
 * width, so a check taken there passes for a reason that has nothing to do with
 * the surface — the race that resolves toward the empty DOM fails toward GREEN
 * (#3384). Wait for a named child of the mounted content BEFORE calling this.
 */
export async function expectNoEscapingOverflow(
  content: Locator,
  label: string
): Promise<void> {
  const scrollable = await content.evaluate(
    (node) => node.scrollWidth - node.clientWidth
  );
  expect(
    scrollable,
    `${label}: ${await overflowStory(content)}\n` +
      "A dialog body must hold everything it contains. The usual cause is a " +
      "flush-edge `tap-target` control whose 6px hit-area extension has nowhere " +
      "to sit after a container lost its horizontal padding (#3395). THE FIX IS " +
      "THE CONTAINER, never the control: the extension is the accessibility " +
      "feature, so give it room (`pr-1.5` below `md` is what #3392 used) rather " +
      "than taking it away."
  ).toBeLessThanOrEqual(0);
}

// ── CARD-MODE LABEL–VALUE PAIRS (#3499) ──────────────────────────────────────
//
// Below `sm` a `.table-cards` meta cell renders its column's label beside the
// value it names (`components/ResponsiveTable.tsx` → the `table-cards` utility in
// app/globals.css). The two must READ as one pair: wrapping may break between
// pairs, never between a label and the START of its own value.
//
// WHY THIS IS MEASURED AND NOT ASSERTED FROM THE COMPUTED STYLE. "The pair did
// not break across lines" is a fact about GEOMETRY. `toHaveCSS("display",
// "inline-flex")` asserts the DECLARATION, which is a different claim and one
// that has already shipped green over a wrong render in this tree: #3466's
// stepped 16px seam measured 16 on the exact element it styled while the seam the
// user saw stayed 24, because it collapsed against an unstepped parent two files
// away. So this reads rects — the label's box against the FIRST line box of its
// value — and asks whether they share a line.
//
// `getClientRects()[0]` is the load-bearing detail: a range over a wrapping value
// returns one rect per line box, and the FIRST one is the value's start. That is
// what "atomic" binds the label to — a long provider name is still free to wrap
// inside itself (#3499 says so in as many words), so comparing against the
// value's whole bounding box would fail the very case the ruling allows.
//
// THE SCAN REPORTS ITS CORPUS, not just its verdict. "No pair is broken" is an
// ABSENCE, and an absence over a selector goes green the moment the selector
// stops matching anything at all (#3509). Callers assert on `labels` — the pairs
// the scan actually SAW — so a scan that has gone blind fails loudly instead of
// passing quietly, and `forgeBrokenCardPair` below proves the scan can still see
// a break by making one on purpose.
export interface CardPairScan {
  /** Every label the scan resolved to a rendered pair, in DOM order. */
  labels: string[];
  /** One `LABEL → value` line per pair the scan saw. The corpus, for diagnosis. */
  pairs: string[];
  /** The pairs whose value's first line box does NOT share a line with its label. */
  breaks: string[];
  /**
   * The pairs whose cell runs past its own row's right edge.
   *
   * The other half of "atomic", and the failure mode the first cut of #3499 shipped
   * into the sleep history: a cell is now a flex line, so a value passed as several
   * loose sibling nodes becomes several ITEMS on that line rather than the stack the
   * block flow used to give it, and a three-nap day ran 29px off the row. A page-level
   * clipping check does not see this — the row scrolls, the document does not — so the
   * measurement has to be the cell against its row.
   */
  overflows: string[];
}

// Two independent rect reads can never be compared exactly (#2505), and a label
// and its value sit on slightly different baselines because the label is a step
// smaller. 1px of slack absorbs sub-pixel rounding; the defect this guards puts
// the value on the NEXT line, tens of pixels away.
const PAIR_LINE_SLACK_PX = 1;

export async function scanCardMetaPairs(scope: Locator): Promise<CardPairScan> {
  return scope.evaluate((root, slack) => {
    const labels: string[] = [];
    const pairs: string[] = [];
    const breaks: string[] = [];
    const overflows: string[] = [];
    const cells = root.querySelectorAll<HTMLElement>('td[data-card="meta"]');
    for (const cell of cells) {
      const label = cell.querySelector<HTMLElement>(
        ":scope > .card-cell-label"
      );
      // No label is no pair: an unlabeled meta cell (a subject chip, which IS its
      // own label — #534) has nothing to be separated from.
      if (!label) continue;
      const labelRect = label.getClientRects()[0];
      // The label is `sm:hidden`, so at desktop width there is no pair on screen.
      if (!labelRect || labelRect.width === 0) continue;

      // The value's START: the first rendered node after the label, and the first
      // line box of it. A bare text node is the common case (`{r.date}`), so it
      // needs a Range — an element child (`NotesText`'s span) has rects directly.
      let valueRect: DOMRect | undefined;
      for (let node = label.nextSibling; node; node = node.nextSibling) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          valueRect = range.getClientRects()[0];
          if (valueRect) break;
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        valueRect = (node as Element).getClientRects()[0];
        if (valueRect) break;
      }
      const name = label.textContent?.trim() ?? "";
      // A cell whose value renders nothing has no pair to break — `Td`'s `empty`
      // is supposed to have dropped it from the card entirely.
      if (!valueRect) continue;

      const whole = cell.textContent?.trim() ?? "";
      const pair = `${name} → ${whole.slice(name.length).trim().slice(0, 48)}`;
      labels.push(name);
      pairs.push(pair);

      // SAME LINE = the two boxes overlap vertically. Comparing tops would fail on
      // the baseline offset between two font sizes; overlap is what "on one line"
      // actually means, and it is font-size agnostic.
      const overlap =
        Math.min(labelRect.bottom, valueRect.bottom) -
        Math.max(labelRect.top, valueRect.top);
      // …and the value starts AFTER the label, rather than the label having been
      // pushed onto a line of its own above it.
      const startsAfter = valueRect.left >= labelRect.right - slack;
      if (overlap <= 0 || !startsAfter) breaks.push(pair);

      const row = cell.closest("tr");
      if (
        row &&
        cell.getBoundingClientRect().right >
          row.getBoundingClientRect().right + slack
      )
        overflows.push(pair);
    }
    return { labels, pairs, breaks, overflows };
  }, PAIR_LINE_SLACK_PX);
}

/**
 * Break one pair ON PURPOSE and return its `LABEL → value` id.
 *
 * The discriminator for the absence assertion above. A green "no pair is broken"
 * is also what a scan that matches nothing — or one whose rect reads have quietly
 * degraded to zeroes — would report, so every caller forges an offender and
 * requires the scan to flag exactly it (#3509).
 *
 * WHAT IT FORGES IS THE DEFECT'S OWN SHAPE, and the shape was measured rather
 * than assumed. `Td` renders the label span and the value with NO whitespace
 * between them (JSX drops it; the 4px gap is the label's margin), and a margin is
 * not a soft-wrap opportunity — so in the pre-#3499 inline flow the label could
 * only ever be split from its value when that value was a BLOCK, which begins a
 * line of its own. That is the real defect and it is not rare: a RecordTable
 * column whose `cell()` returns a `<div>` (the visits list) and the sleep
 * history's per-nap `<div>`s both rendered "VISIT" / "NAPS" alone above their own
 * values before this change.
 *
 * So the forgery restores exactly that: the cell back to the block box it used to
 * be, and the label made block inside it, which puts the value on the next line
 * whether it is a text node or an element. `!important` because
 * `metric-readings-list` pins its metas with `!important` of its own.
 *
 * A NARROWED BLOCK BOX WAS TRIED FIRST AND SILENTLY DID NOTHING — the label and
 * the value have no break opportunity between them, so they overflowed the narrow
 * cell side by side on one line and the scan was right not to flag them. The
 * discriminator caught its own first draft, which is the argument for having one.
 */
const FORGED_PROPERTIES = ["display"] as const;

export async function forgeBrokenCardPair(scope: Locator): Promise<string> {
  const forged = await scope.evaluate((root) => {
    const cells = root.querySelectorAll<HTMLElement>('td[data-card="meta"]');
    for (const cell of cells) {
      const label = cell.querySelector<HTMLElement>(
        ":scope > .card-cell-label"
      );
      const labelRect = label?.getClientRects()[0];
      if (!label || !labelRect || labelRect.width === 0) continue;
      const name = label.textContent ?? "";
      if (!cell.textContent?.slice(name.length).trim()) continue;
      cell.dataset.forgedPairBreak = "true";
      label.dataset.forgedPairBreak = "true";
      cell.style.setProperty("display", "block", "important");
      label.style.setProperty("display", "block", "important");
      const whole = cell.textContent?.trim() ?? "";
      const trimmed = name.trim();
      return `${trimmed} → ${whole.slice(trimmed.length).trim().slice(0, 48)}`;
    }
    return "";
  });
  expect(
    forged,
    "forgeBrokenCardPair found no labeled meta pair to break — the scan is then " +
      "asserting an absence over an empty corpus, which is the failure it exists " +
      "to rule out."
  ).not.toBe("");
  return forged;
}

/** Undo `forgeBrokenCardPair`, so the caller can run a control AFTER the restore. */
export async function restoreForgedPair(scope: Locator): Promise<void> {
  await scope.evaluate(
    (root, properties) => {
      for (const node of root.querySelectorAll<HTMLElement>(
        '[data-forged-pair-break="true"]'
      )) {
        for (const property of properties) node.style.removeProperty(property);
        delete node.dataset.forgedPairBreak;
      }
    },
    FORGED_PROPERTIES as unknown as string[]
  );
}

/**
 * Assert one card-mode scope's meta pairs, WITH the discriminator attached.
 *
 * The two claims this makes — "no pair is broken" and "no cell overflows its row"
 * — are both ABSENCES, and an absence over a selector goes green the moment the
 * selector stops matching (#3509). So the discriminator is not an optional extra
 * a call site may skip: it lives HERE, bound to the assertion, because #3517 asked
 * for the guard to reach more surfaces and the cheapest way to reach more surfaces
 * is a call site that forgets it. Three steps, in this order:
 *
 *   (a) the scan SAW `mustSee` — without it the two absences below are both
 *       satisfied by a scan that found no pairs at all;
 *   (b) the absences hold;
 *   (c) a break forged ON PURPOSE is flagged, and exactly it — so a scan whose
 *       rect reads have gone blind fails loudly instead of sweeping clean.
 *
 * The control runs AFTER the restore, not only before it.
 */
export async function expectAtomicCardPairs(
  scope: Locator,
  mustSee: string[]
): Promise<CardPairScan> {
  const scan = await scanCardMetaPairs(scope);
  expect(scan.labels, `pairs seen: ${scan.pairs.join(" | ")}`).toEqual(
    expect.arrayContaining(mustSee)
  );
  expect(
    scan.breaks,
    "a card-mode meta cell put its value on a different line from its own " +
      "label. The pair is supposed to be one non-wrapping flex line " +
      "(`table-cards` in app/globals.css); wrapping belongs BETWEEN pairs."
  ).toEqual([]);
  expect(
    scan.overflows,
    "a card-mode meta cell ran past its own row. The usual cause is a value " +
      "passed as several loose sibling nodes: the cell is a flex line, so they " +
      "become items side by side instead of stacking. Pass one node " +
      "(components/ResponsiveTable.tsx says so where `label` is documented)."
  ).toEqual([]);

  const forged = await forgeBrokenCardPair(scope);
  expect(
    (await scanCardMetaPairs(scope)).breaks,
    "the scan did not flag a pair broken ON PURPOSE — it cannot see the " +
      "defect it is here to catch, so its clean sweep above meant nothing."
  ).toEqual([forged]);

  await restoreForgedPair(scope);
  expect((await scanCardMetaPairs(scope)).breaks).toEqual([]);
  return scan;
}

// ── THE DAY LEDGER'S DOSE ROWS (#3987) ───────────────────────────────────────
//
// The Nutrition page states a day ONCE now, on the Food tab: what a day owes and what
// it recorded are the ledger's, and the Supplements tab is the stack you manage. So a
// spec that used to confirm a dose by reaching into a time-bucket `<section>` on the
// Supplements tab has two subjects where it had one — the ROW (edit, delete, history)
// and the DAY (take, skip, clear) — and they live on different tabs.
//
// These two helpers are that split, named once, because six specs make the same reach
// and a seventh would otherwise re-derive it. Neither navigates: a spec says which tab
// it is on, since that is part of what it is asserting.

/**
 * Expand every collapsed due-dose group in the ledger, so the individual doses behind
 * the bulk Take-all are in the DOM.
 *
 * Idempotent by construction — it opens only the groups reading `aria-expanded="false"`
 * — so a spec may call it after any navigation without tracking what it already did.
 */
export async function expandLedgerDueGroups(page: Page): Promise<void> {
  const groups = page.locator('[data-testid^="ledger-due-group-"]');
  const count = await groups.count();
  for (let i = 0; i < count; i++) {
    const group = groups.nth(i);
    if ((await group.getAttribute("aria-expanded")) === "false") {
      await group.click();
    }
  }
}

/**
 * One item's dose row in the ledger, whichever half of the day it is in — still owed
 * (`ledger-due-dose-…`) or already recorded (`ledger-dose-…`).
 *
 * BOTH SHAPES, DELIBERATELY. Resolving a dose moves it from the bucket's due row to a
 * recorded row of its own, so a locator pinned to one of them describes the dose only
 * until somebody answers it — which is precisely the moment most of these specs are
 * asserting. Filtering the union by name keeps the subject the DOSE rather than a
 * position the ledger is allowed to change.
 */
export function ledgerDoseRow(page: Page, name: string): Locator {
  return page
    .getByTestId("day-ledger")
    .locator(
      'li[data-testid^="ledger-due-dose-"], li[data-testid^="ledger-dose-"]'
    )
    .filter({ hasText: name });
}

/**
 * State a day and a minute through `WhenControl`'s COMPOSED DOOR (#4218).
 *
 * A `state` mount that requires a time on a day the user may still change renders
 * ONE field — `{testId}-when` — over one panel holding the calendar and the time
 * wheel, instead of the split date and time boxes. So a spec that used to
 * `.fill()` two inputs opens one door here and picks in it, which is what the
 * user now does; there is no text box to fill.
 *
 * The panel is portaled to `<body>` in both presentations (anchored popover from
 * `md` up, bottom sheet below), so it is addressed off `page` rather than off the
 * form — the form does not contain it. Everything else is presentation-agnostic
 * on purpose: the same call drives either host, which is the #2305 guarantee the
 * fork is built on.
 */
export async function pickComposedWhen(
  page: Page,
  testId: string,
  { date, hhmm }: { date?: string; hhmm?: string }
): Promise<void> {
  await hydratedClick(page, page.getByTestId(`${testId}-when`));
  // The CONTENT wrapper, which `AnchoredPanel` marks with the same testid in
  // both presentations (the sheet's own host testid names the sheet around it).
  // One locator for both hosts is the point: a spec that had to know which host
  // it was in would be the `hidden md:` twin the fork exists to avoid.
  const panel = page.getByTestId(`${testId}-when-panel`);
  await expect(panel).toBeVisible();

  if (date) {
    const [year, month, day] = date.split("-").map(Number);
    // Year before month: the month options are DISABLED outside the control's
    // bounds, and a month that is out of range in the year on screen may be in
    // range in the year being moved to.
    // Exact names: the calendar's own previous/next buttons are "Previous month"
    // and "Next month", which a substring match on "Month" also picks up.
    await panel.getByLabel("Year", { exact: true }).selectOption(String(year));
    await panel
      .getByLabel("Month", { exact: true })
      .selectOption(String(month - 1));
    // By the cell's own accessible date name (#3744), not the bare numeral — the
    // grid shows the neighbouring months' days too.
    await panel
      .getByRole("button", {
        name: `${MONTHS_LONG[month - 1]} ${day}, ${year}`,
        exact: true,
      })
      .click();
  }

  if (hhmm) {
    const hour24 = Number(hhmm.slice(0, 2));
    const meridiem = panel.getByRole("listbox", { name: "AM or PM" });
    // The wheel's columns follow the profile's clock, so which hour row to tap
    // is a question about the preference and not about the value.
    const twelve = (await meridiem.count()) > 0;
    const shownHour = twelve ? (hour24 % 12 === 0 ? 12 : hour24 % 12) : hour24;
    await panel
      .getByRole("listbox", { name: "Hour" })
      .getByRole("option", { name: String(shownHour).padStart(2, "0") })
      .click();
    await panel
      .getByRole("listbox", { name: "Minute" })
      .getByRole("option", { name: hhmm.slice(3) })
      .click();
    if (twelve)
      await meridiem
        .getByRole("option", { name: hour24 >= 12 ? "PM" : "AM" })
        .click();
  }

  // Done is a pure client dismissal — it posts nothing, so what it is waited on
  // for is the panel going away.
  await hydratedClick(page, page.getByTestId(`${testId}-when-done`));
  await expect(panel).toHaveCount(0);
}
