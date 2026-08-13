import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { AUTO_RELOAD_KEY } from "@/lib/sw-update";

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
//        → settledUpload(page, input, files)
//    Same guarantee, same correlated predicate as settledClick — they share
//    armActionPost, because "did this interaction's action complete?" is one
//    question and a helper family must not answer it two ways (#1952).
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
//    Two rules meet here, and the second is the one #2662 was filed for. First,
//    a chooser is an EVENT, so the listener is armed and the tap taken under one
//    `Promise.all` — never armed with its own short timeout inside a retry loop,
//    which does not lengthen the window, it just re-runs the same too-short one.
//    Second, the branch that reaches the chooser at all must be a STATED
//    precondition. PhotoCapture only opens the picker synchronously for a session
//    that already knows the camera is unusable; otherwise the tap tries
//    getUserMedia and opens a fallback MODAL — whose `fixed inset-0` backdrop
//    then intercepts every later click on the trigger, so the loop's own first
//    attempt is what makes the rest unreachable. Retrying a control that covers
//    itself is worse than not retrying it.
//
// 3. Everything else — a pure client toggle, a value that settles in place, a
//    toast that appears — needs NO settle on the network. Assert it with a plain
//    auto-retrying `expect(locator).toBeVisible()` / `.toHaveText(...)`. Playwright
//    retries the assertion for you; that IS the wait. Reaching for a helper here
//    only hides which state you actually depend on.
//        → hydratedClick(page, locator) when the CLICK ITSELF can be lost — a
//          disclosure/chip/menu whose handler React may not have attached yet, and
//          which a retry loop would toggle back. Then assert what it revealed.
//    Do NOT reach for settledClick here. A client toggle posts nothing, so there is
//    nothing to settle on; before #1952 it appeared to work only because it accepted
//    a bystander's POST, which is the silent-green failure that issue is about.
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
export async function capturePhotoFile(
  page: Page,
  trigger: Locator,
  file: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    hydratedClick(page, trigger),
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
export async function centerOf(
  locator: Locator
): Promise<{ x: number; y: number }> {
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

// Open the Upcoming page's display aggregates (issue #1504).
//
// The planning page folds a band's scheduled doses into one disclosure, and its
// interaction + PGx notes into another, collapsed on every visit. A spec that
// asserts on an individual dose / interaction / PGx ROW has to open the fold
// first — the rows are real and unchanged, they are just behind a <details>.
//
// Native <details>, so this needs no hydration and no server round-trip; it is
// idempotent (an already-open disclosure is skipped) and tolerant of a page with
// no aggregate at all, so a spec may call it unconditionally after navigating.
// Pass a `kind` to open only that class.
export type UpcomingAggregateKind = "dose" | "med-safety";

export async function expandUpcomingAggregates(
  scope: Page | Locator,
  kind?: UpcomingAggregateKind
): Promise<void> {
  // Exact testids, never a `^=` prefix: the summary INSIDE each disclosure is
  // `upcoming-aggregate-summary-<kind>`, which a prefix match would also select —
  // and a <summary> has no <summary> of its own, so the loop would hang on it.
  const kinds: UpcomingAggregateKind[] = kind ? [kind] : ["dose", "med-safety"];
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

// Mobile clipped-content guard (issue #1063). The app shell deliberately clips
// horizontal overflow (`<main className="… overflow-x-clip">` in
// app/(app)/layout.tsx), so broken phone-width layouts never page-scroll — they
// render as INVISIBLE, unreachable content (copy/token buttons pushed off-screen).
// That also defeats the naive `document.scrollWidth > clientWidth` check: it
// reads 0 overflow on every page. So this asserts ELEMENT-level containment:
// every rendered element's right edge must sit inside the viewport (+2px
// tolerance), unless it lives inside a functioning `overflow-x: auto|scroll`
// container that itself fits — the AGENTS.md "wide content scrolls inside its
// own container" rule, made mechanical. Call it AFTER the page's content is
// visible (assert a page-specific element first), with the viewport already at
// phone width. Offenders are reported with tag/testid/class + widths so a
// failure names the guilty element directly.
export async function expectNoClippedContent(page: Page): Promise<void> {
  const offenders = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const TOL = 2;
    const bad: string[] = [];
    const insideWorkingScroller = (el: Element): boolean => {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const o = getComputedStyle(a).overflowX;
        if (o === "auto" || o === "scroll") {
          const r = a.getBoundingClientRect();
          // The scroll container must itself fit the viewport — a scroller that
          // overflows just moves the problem up a level.
          if (r.right <= vw + TOL) return true;
        }
      }
      return false;
    };
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // not rendered
      if (r.right <= vw + TOL) continue; // fits
      if (r.left >= vw) continue; // fully off-canvas by design (drawers, toasts)
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.opacity === "0") continue;
      if (insideWorkingScroller(el)) continue;
      const id = el.getAttribute("data-testid");
      const cls = typeof el.className === "string" ? el.className : "";
      bad.push(
        `<${el.tagName.toLowerCase()}${id ? ` data-testid="${id}"` : ""}` +
          `${cls ? ` class="${cls.slice(0, 80)}"` : ""}> ` +
          `right=${Math.round(r.right)} vs viewport=${vw}`
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
// only safe because its hamburger sets `open` TRUE and never toggles. A real
// TOGGLE (the #1455 "Custom…" pill, the digest's "Show all N") flips state, so a
// second tap UNDOES the first — a retry loop there is a coin flip. Instead: wait
// for the hydration markers React attaches to the DOM node, then click ONCE.
//
// WORKS for a client-state button whose effect is a re-render (a disclosure, an
// expander). For a click that fires a Server Action use settledClick; for one that
// navigates use followLink.
export async function hydratedClick(
  page: Page,
  button: Locator,
  opts: { timeout?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 10_000;
  await expect(button).toBeVisible();
  await expect(async () => {
    const hydrated = await button.evaluate((el) =>
      Object.keys(el).some(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")
      )
    );
    // Not hydrated yet → toPass retries the PROBE only; the click below runs once,
    // after the handler is attached, so the toggle can never be double-fired.
    expect(hydrated, "button not hydrated yet").toBe(true);
  }).toPass({ timeout }); // topass-ok: polls for React's hydration markers on this node — a state, not an interaction; the click stays outside the loop so a toggle is never fired twice
  await button.click();
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

// Open MobileNav's slide-in drawer and return it (issue #1420 — the `mobile`
// Playwright project's one shared interaction). The drawer is the phone shell's
// only route to the app's navigation: below `md` the desktop sidebar is hidden and
// the drawer's <aside> isn't even MOUNTED until the hamburger is tapped
// (components/MobileNav.tsx renders it behind `{open && …}`), so a mobile spec that
// needs a nav link has to open it first.
//
// The tap fires NO Server Action and NO navigation — it's a pure `setOpen(true)`
// client toggle — so neither settledClick nor followLink applies, and a tap landing
// in the pre-hydration window (#500/#830) is silently swallowed with nothing to
// await. This is decision-tree case 4: re-tap until the drawer mounts, guarded on
// its visibility. Re-tapping is safe because the hamburger only ever sets `open`
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
      await page.getByRole("button", { name: "Open menu" }).click();
    }
    await expect(drawer).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the hamburger past the pre-hydration swallow — a pure client toggle with no POST/navigation to settle on; set-true-only, so a late tap can't re-close it
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
// loads — the precondition of #2182's one-tap native picker, and the device class
// PhotoCapture's own header names first ("PWA-safe, CI, older devices").
//
// Two specs used to ASSUME this ("No getUserMedia in CI") and it was false:
// `navigator.mediaDevices.getUserMedia` exists on a headless runner because
// localhost is a secure context — what is missing is the camera. So an unprimed
// tap took `try-camera`, getUserMedia rejected `NotFoundError`, and the fallback
// DIALOG opened. That is correct product behaviour (you cannot skip trying a
// camera you know nothing about); it is just not the state those specs assert.
//
// Why this fact and not the session-cache one: `cameraStartDecision` reads
// `hasGetUserMedia` SYNCHRONOUSLY at tap time, from a value this init script has
// already fixed before any document script ran, so the branch is decided with no
// async input anywhere. The `knowledge: "failed"` route to the same branch is a
// true statement about the runner too, but its precondition arrives from a mount
// effect (a sessionStorage read, then a `navigator.permissions.query` promise),
// and "that effect has flushed" is not something a tap can prove — which is the
// class of assumption this whole issue is about. Staging the device removes the
// question rather than narrowing it.
//
// Nothing is lost by staging it: `cameraStartDecision`'s full branch matrix,
// knowledge cache included, is unit-covered in lib/__tests__/camera-fallback.ts,
// and the camera-API-present shapes (denied → recovery guidance, present-but-no-
// hardware → picker-only dialog) have their own browser test in
// progress-photos.spec.ts, which stages `navigator.mediaDevices` the same way.
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
// Desktop mount by default (the sidebar's bar). The phone's bar is a separate
// mount (`profile-identity-bar-mobile`) because both exist in the DOM at every
// width, one `md:hidden` and one `hidden md:flex`.
export async function expectInView(
  page: Page,
  count: number,
  opts: { mobile?: boolean } = {}
): Promise<void> {
  await expect(
    page.getByTestId(
      opts.mobile ? "profile-identity-bar-mobile" : "profile-identity-bar"
    )
  ).toHaveAttribute("data-view-count", String(count));
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
    const boxes = await Promise.all(locators.map((l) => l.boundingBox()));
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
  diagnose: (err: unknown, helper: string, advice: string) => Error;
} {
  // Requests observed from the moment the interaction is dispatched. A WeakSet keyed
  // on Playwright's own Request object is exact identity — no URL/timing heuristics
  // — and `response.request()` returns that same object.
  const caused = new WeakSet<Request>();
  let collecting = false;
  const onRequest = (request: Request) => {
    if (collecting) caused.add(request);
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
  return {
    settled,
    begin: () => {
      collecting = true;
    },
    release: () => page.off("request", onRequest),
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
          : `\n[${helper}] NO same-origin POST was seen at all during the wait — ` +
            `not even a background one. The page produced no traffic, so the old ` +
            `"any POST" helper would have timed out here too; suspect a stalled or ` +
            `navigated page rather than this contract.`);
      return wrapped;
    },
  };
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
    await Promise.all([wait.settled, clicked]);
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
        `than this route, pass { url }.`
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

// Set files on a file `<input>` and await the Server-Action POST the resulting
// change fires — the settledClick idiom for an upload input (which has no click to
// drive). A hidden camera/file input's `onChange` submits a Server Action (upload
// + `revalidatePath`); we arm the POST wait BEFORE `setInputFiles` (so a fast
// upload can't resolve in the gap), then await it, so the follow-up `expect(...)`
// runs against the durably-applied strip rather than a bare timed count poll.
// WORKS when the change definitely fires exactly one Server Action (the upload).
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
  const here = new URL(page.url());
  const wait = armActionPost(page, here, { timeout, url: opts.url });
  try {
    // Same synchronous turn as the interaction, exactly as in settledClick.
    wait.begin();
    await Promise.all([wait.settled, input.setInputFiles(files)]);
  } catch (err) {
    throw wait.diagnose(
      err,
      "settledUpload",
      `The input's onChange must submit a Server Action. If this upload posts to ` +
        `a route handler instead, it is not a settledUpload site — await the ` +
        `route's own response. If it posts somewhere other than this route, pass ` +
        `{ url }.`
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
export async function touchSwipe(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number; stepDelayMs?: number } = {}
): Promise<void> {
  const steps = Math.max(2, opts.steps ?? 10);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y }],
    });
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
      .getByRole("button", { name: label, exact: true });
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
