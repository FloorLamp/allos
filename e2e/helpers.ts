import { expect, type Locator, type Page } from "@playwright/test";

// The blessed e2e interaction module (issue #868, fix b2).
//
// The suite had reinvented "wait until the interaction actually took effect" per
// spec — a zoo of `waitForLoadState("networkidle")` gates, `waitForTimeout(...)`
// sleeps, and `toPass()` re-click loops. They disagree about WHAT they wait for,
// so the same class of race (a Server-Action POST + trailing `router.refresh()`
// that detaches elements mid-interaction, or a pre-hydration click that gets
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
// 2. The click is a NAVIGATION to another route (a Next `<Link>`/tab `<a href>`)
//    and the flake is the pre-hydration swallow (#500/#830):
//        → followLink(page, locator, /destination-url/)
//    It retries the click until the client router commits (and HOLDS) the URL.
//    Do NOT reach for networkidle "to let it hydrate first" — followLink already
//    tolerates the un-hydrated window by retrying.
//
// 3. Everything else — a pure client toggle, a value that settles in place, a
//    toast that appears — needs NO special helper. Assert it with a plain
//    auto-retrying `expect(locator).toBeVisible()` / `.toHaveText(...)`. Playwright
//    retries the assertion for you; that IS the wait. Reaching for a helper here
//    only hides which state you actually depend on.
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

// Click `locator` and await the Server Action POST it fires before returning.
//
// Next App Router Server Actions POST to the CURRENT route URL (same origin) — a
// `<form action={serverAction}>` submit posts natively before hydration and via a
// `fetch` POST after, and either way the response completes only once the action
// AND its `revalidatePath`/`router.refresh()` have run server-side. We arm a
// `waitForResponse` for that POST BEFORE clicking (so a fast action can't resolve
// in the gap between click and wait), then click, then await the response. When it
// resolves the mutation is durably applied; the follow-up `expect(...)` asserts the
// re-rendered UI (React applies the revalidated payload on the next tick — the
// assertion's own retry absorbs that sub-tick).
//
// WORKS when: the click definitely triggers exactly one same-origin POST (form
// submit, action button). PREFER this over networkidle/waitForTimeout/toPass for
// those.
//
// DOES NOT WORK when: the click fires NO action (a pure client toggle, an
// `<a href>` navigation with no action) — there is no POST to await and this will
// time out. Use followLink for navigations and a plain `expect` for client-only
// state (decision tree above). If a click fires an action AND navigates, this
// still resolves on the action POST.
//
// ALSO NOT RELIABLE on a page with steady background action-POST traffic (the
// dashboard's watchers/pollers): the wait can resolve on a bystander POST while
// the mutation's own request is still in flight — and a follow-up `page.reload()`
// then aborts it (the write is lost, not just late). There, prefer asserting a
// SERVER-rendered marker that only the completed mutation + refresh can produce
// (the wellbeing card's `mood-server-logged` marker is the precedent) — the
// assertion's own retry is the settle.
export async function settledClick(
  page: Page,
  locator: Locator,
  opts: { timeout?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 15_000;
  const origin = new URL(page.url()).origin;
  await expect(locator).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (resp) => {
        if (resp.request().method() !== "POST") return false;
        try {
          return new URL(resp.url()).origin === origin;
        } catch {
          return false;
        }
      },
      { timeout }
    ),
    locator.click({ timeout }),
  ]);
}

// Set files on a file `<input>` and await the Server-Action POST the resulting
// change fires — the settledClick idiom for an upload input (which has no click to
// drive). A hidden camera/file input's `onChange` submits a Server Action (upload
// + `revalidatePath`/`router.refresh()`); we arm the POST wait BEFORE
// `setInputFiles` (so a fast upload can't resolve in the gap), then await it, so
// the follow-up `expect(...)` runs against the durably-applied strip rather than a
// bare timed count poll. WORKS when the change definitely fires exactly one
// same-origin POST (the upload). Mirrors settledClick for inputs.
export async function settledUpload(
  page: Page,
  input: Locator,
  files: Parameters<Locator["setInputFiles"]>[0],
  opts: { timeout?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 20_000;
  const origin = new URL(page.url()).origin;
  await Promise.all([
    page.waitForResponse(
      (resp) => {
        if (resp.request().method() !== "POST") return false;
        try {
          return new URL(resp.url()).origin === origin;
        } catch {
          return false;
        }
      },
      { timeout }
    ),
    input.setInputFiles(files),
  ]);
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
  try {
    await expect(async () => {
      if (!destination.test(page.url())) {
        try {
          await link.click({ timeout: 2000 });
        } catch (err) {
          lastClickError = err instanceof Error ? err : new Error(String(err));
          // The ONE benign, expected race is a click on a link a PRIOR iteration
          // already navigated away from: the old element is detached, and this
          // same iteration's URL check below will observe the destination and
          // pass — so swallow it and fall through. EVERY other click failure (a
          // wrong/ambiguous selector, an overlay intercepting the click, a
          // disabled or pointer-events:none target, a stubborn click timeout)
          // is rethrown into toPass. toPass still retries — tolerating a genuine
          // transient — but its final timeout now carries this error, and the
          // catch below names it explicitly, so a broken click fails with a
          // useful message rather than masquerading as a URL-match timeout.
          if (!isDetachedElementError(lastClickError)) throw lastClickError;
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
    // The navigation never committed within the budget. If a click failed along
    // the way, surface it — otherwise the caller sees only "url never matched",
    // which is exactly the causeless timeout #890 is about.
    if (lastClickError) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      wrapped.message =
        `${wrapped.message}\n\n[followLink] navigation to ${destination} never ` +
        `committed; the last click on the link failed with:\n${lastClickError.message}`;
      throw wrapped;
    }
    throw err;
  }
}

// Playwright surfaces a click on a link that a prior iteration already navigated
// away from as an "element is not attached to the DOM" / "detached" error. That
// is the ONE race followLink is allowed to swallow (the next URL check passes);
// every other click failure must reach the caller.
function isDetachedElementError(err: Error): boolean {
  return /not attached|is detached|element was detached/i.test(err.message);
}
