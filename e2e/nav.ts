import { expect, type Locator, type Page } from "@playwright/test";

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
// the navigation robust without touching a single content assertion.
export async function followLink(
  page: Page,
  link: Locator,
  destination: RegExp
): Promise<void> {
  await expect(link).toBeVisible();
  await expect(async () => {
    if (!destination.test(page.url())) {
      // Ignore a detached-element error: a click that DID navigate on a prior
      // iteration leaves the old link detached, and the next tick's URL check
      // will observe the change and pass.
      await link.click({ timeout: 2000 }).catch(() => {});
    }
    // The navigation must have STUCK, not merely flipped. The same hydration race
    // can commit the client transition optimistically — the URL advances to the
    // destination — and then unwind back to the source route as hydration
    // finishes, so a single url() check can pass on a navigation that reverts and
    // leave the caller asserting against the source page. Require the destination
    // URL to hold across a short settle; a revert fails the recheck and toPass
    // re-clicks.
    expect(page.url()).toMatch(destination);
    await page.waitForTimeout(500);
    expect(page.url()).toMatch(destination);
  }).toPass({ timeout: 25000, intervals: [300, 700, 1500, 3000] });
}

// Open the Cmd/Ctrl-K command palette reliably. The same pre-hydration swallow
// (issue #500) applies to the keyboard shortcut: a keypress fired before the
// document-level keydown handler is wired does nothing, so the palette never
// opens and the very first assertion (its search input) fails under parallel-run
// contention. Re-press until the input appears — guarded on visibility so a press
// after it has opened can't toggle it shut.
export async function openCommandPalette(page: Page): Promise<Locator> {
  const input = page.getByRole("combobox", {
    name: "Search or run a command",
  });
  await expect(async () => {
    if (!(await input.isVisible())) {
      await page.keyboard.press("Control+KeyK");
    }
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20000, intervals: [300, 700, 1500] });
  return input;
}
