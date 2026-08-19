import { test, expect } from "./fixtures";
import { hydratedClick, readyForOffline } from "./helpers";
import { switchToProfile } from "./family-helpers";
// Offline Emergency Card (issue #42), living as the #emergency section of the
// Passport page since the #1042 phase-3 merge (the old /emergency route was
// removed outright in #1635 and 404s). This spec runs in its OWN unauthenticated
// context and logs in by hand (rather than reusing the shared storageState),
// because it exercises logout — which destroys the session row server-side, and
// would otherwise invalidate the shared cookie every other spec relies on.
test.use({ storageState: { cookies: [], origins: [] } });

const LS_KEY = "allos:emergency-card";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "e2e-admin-pass");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
}

test("emergency card: opt-in, render on the passport page, offline copy, and logout clears it (#42/#1042)", async ({
  page,
  context,
}) => {
  // Several full navigations + a bounded SW wait; give it headroom under the
  // parallel load of the full suite.
  test.slow();
  await login(page);

  // 0. Nav: the Medical group carries a Passport entry and NO Emergency Card
  //    entry (the section merged into Passport — #1042 phase 3).
  await page.goto("/");
  const sidebar = page.locator("aside nav");
  await sidebar.getByRole("button", { name: "Medical" }).click();
  await expect(sidebar.getByRole("link", { name: "Passport" })).toBeVisible();
  await expect(
    sidebar.getByRole("link", { name: "Emergency Card" })
  ).toHaveCount(0);

  // 0b. Background (Records › Care › Overview) NO LONGER renders the emergency-card
  //     settings — they moved to the Passport (#1087). Smoking history still does.
  await page.goto("/records/care/overview");
  await expect(page.getByTestId("records-background")).toBeVisible();
  await expect(page.getByTestId("emergency-toggle")).toHaveCount(0);

  // 1. Opt in ON THE PASSPORT itself (#1087) — the toggle sits inline with the card
  //    it configures, no cross-page bounce. Off by default; wait for the autosave
  //    "Saved" indicator so the write has landed before we read the card.
  await page.goto("/profile");
  const toggle = page.getByTestId("emergency-toggle");
  await expect(toggle).toBeVisible();
  // Repeat-each safe: a prior iteration may have left profile 1 opted in (the
  // server flag persists across the shared fixture DB), so reset to the default-off
  // precondition before exercising the opt-in flow.
  if (await toggle.isChecked()) {
    await toggle.uncheck();
    await expect(page.getByLabel("Saved")).toBeVisible();
    await page.reload();
  }
  await expect(toggle).not.toBeChecked();

  // 1a. While the opt-in is OFF, the passport's emergency section shows the calm
  //     prompt AND the inline toggle — no "Enable in Medical → Background" bounce.
  await expect(
    page.getByRole("heading", { name: "Health passport" })
  ).toBeVisible();
  const section = page.getByTestId("emergency-section");
  await expect(section).toContainText("Offline emergency card is off");
  await expect(
    section.getByRole("link", { name: /Enable in Medical/ })
  ).toHaveCount(0);
  await expect(page.getByTestId("emergency-card")).toHaveCount(0);

  // Enable it right here — no navigation away.
  await toggle.check();
  await expect(page.getByLabel("Saved")).toBeVisible();
  // The card appears inline on the SAME page (the settings' router.refresh) —
  // enabling is one tap, no bounce (#1087).
  await expect(page.getByTestId("emergency-card")).toBeVisible();

  // 2. The passport page's #emergency anchor, where the card renders the seeded
  //    allergy + active medication, both artifacts stack on one page, and the
  //    card's own scoped Print affordance is offered. (The old /emergency route
  //    was removed outright in #1635 — this deep link is the only one left.)
  await page.goto("/profile#emergency");
  await expect(page).toHaveURL(/\/profile#emergency$/);
  await expect(page.getByTestId("emergency-card")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Health passport" })
  ).toBeVisible();
  await expect(
    page.getByTestId("emergency-section").getByRole("button", { name: "Print" })
  ).toBeVisible();
  // The anchor scrolled the emergency section into the viewport (the passport
  // summary above it fills well more than one screen for the seeded profile).
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.getElementById("emergency");
        if (!el) return Number.POSITIVE_INFINITY;
        return el.getBoundingClientRect().top;
      })
    )
    .toBeLessThan(720);
  await expect(page.getByTestId("emergency-allergies")).toContainText(
    "Peanuts"
  );
  await expect(page.getByTestId("emergency-medications")).toContainText(
    "Sertraline"
  );

  // 3. The visit cached an offline copy in localStorage (written by a client
  //    effect after hydration, so poll rather than read once).
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), LS_KEY))
    .toContain("Peanuts");

  // 4. The public /offline fallback (the exact page the service worker serves for
  //    a failed navigation) surfaces that cached copy instead of dead-ending.
  await page.goto("/offline");
  await page.getByTestId("offline-view-emergency").click();
  await expect(page.getByTestId("emergency-card")).toContainText("Peanuts");

  // 4b. Offline render, with the precondition stated rather than assumed. A failed
  //     navigation is served the precached /offline shell, which reads the cached card
  //     out of localStorage and shows it.
  //
  //     WHAT THIS BLOCK PROVES, EXACTLY. The localStorage read is genuinely offline —
  //     there is no server involved in it and the bypass below cannot fake it. The
  //     SHELL that renders it is a different claim: Playwright's offline emulation is
  //     per-browser-context and does not cover the SERVICE WORKER's own fetches, so
  //     `cacheFirst` in public/sw.js can still pull a missing chunk over the network
  //     during a navigation the page believes is offline (#3002 — measured: chunks
  //     absent from the cache before `setOffline(true)` were present after it). A real
  //     device has no such escape hatch, and there a missing chunk is a blank card.
  //
  //     So this used to claim more than it delivered — it called itself the assertion
  //     that "the card is readable with no network", which is not what a leaky offline
  //     emulation can measure. `readyForOffline` closes the gap by asserting the thing
  //     that CAN be checked faithfully: the shell's own chunks are in the worker's
  //     cache BEFORE the network goes away. Delete a chunk from the cache and this
  //     block now fails; before, it passed by fetching it.
  //
  //     (It also used to sit behind `if (process.env.CI)`, on the premise that only
  //     the CI harness boots a production build with a live service worker. That
  //     premise died with #1538 — every worker's server is `next start` with
  //     NODE_ENV=production, spawned unconditionally by e2e/fixtures.ts — so the gate
  //     only meant the block ran nowhere but CI (#2645/#2648). Removing it was right;
  //     the claim it guarded is what this note corrects.)
  await readyForOffline(page);
  await context.setOffline(true);
  try {
    await page.goto("/profile");
    await page.getByTestId("offline-view-emergency").click();
    await expect(page.getByTestId("emergency-card")).toContainText("Peanuts");
  } finally {
    await context.setOffline(false);
  }

  // 4c. Toggling OFF on the Passport hides the card AND clears the offline copy on
  //     this device — all without leaving the page (#1087). Re-enable afterward so
  //     the logout-clears-it contract below still starts from a cached copy. Route
  //     via "/" first: the offline block above may leave the document on the
  //     /profile offline shell, so a bare goto("/profile#emergency") would be a
  //     hash-only change (no reload) and never fetch the real page + its toggle.
  await page.goto("/");
  await page.goto("/profile#emergency");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(page.getByLabel("Saved")).toBeVisible();
  await expect(page.getByTestId("emergency-card")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), LS_KEY))
    .toBeNull();
  // Re-enable + re-cache for the logout step.
  await toggle.check();
  await expect(page.getByLabel("Saved")).toBeVisible();
  await expect(page.getByTestId("emergency-card")).toBeVisible();
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), LS_KEY))
    .toContain("Peanuts");

  // 5. Log out. The offline copy is wiped from this device, and the card is locked
  //    behind auth again.
  await page.goto("/");
  // Log out sits at the sidebar's bottom since #1801 — no menu to open first.
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });

  const afterLogout = await page.evaluate(
    (k) => localStorage.getItem(k),
    LS_KEY
  );
  expect(afterLogout).toBeNull();

  // A direct visit to the card now redirects to login (no session): /profile's
  // session gate bounces to /login.
  await page.goto("/profile#emergency");
  await expect(page).toHaveURL(/\/login/);

  // And the offline fallback no longer offers the card (nothing cached).
  await page.goto("/offline");
  await expect(page.getByTestId("offline-view-emergency")).toHaveCount(0);
});

// #600: switching profiles must wipe the previous profile's cached emergency card.
// Before the centralized watcher, A's full card stayed readable session-free at
// /offline after the switch.
test("switching profiles wipes the previous profile's emergency card (#600)", async ({
  page,
}) => {
  test.slow();
  await login(page);

  // Opt in + cache profile 1's card (the admin's default active profile) — the
  // toggle lives on the Passport now (#1087).
  await page.goto("/profile#emergency");
  const toggle = page.getByTestId("emergency-toggle");
  if (!(await toggle.isChecked())) {
    await toggle.check();
    await expect(page.getByLabel("Saved")).toBeVisible();
  }
  await expect(page.getByTestId("emergency-card")).toBeVisible();
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), LS_KEY))
    .toContain("Peanuts");

  // Switch to profile 2 ("Riley (child)") through the shared profile switcher.
  await page.goto("/");
  await switchToProfile(page, "Riley (child)");

  // The previous profile's offline card is wiped from this device …
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), LS_KEY))
    .toBeNull();
  // … and /offline no longer offers it.
  await page.goto("/offline");
  await expect(page.getByTestId("offline-view-emergency")).toHaveCount(0);
});

// #2997 — THE CARD HAS TO WORK FOR SOMEONE WHO NEVER OPENED /offline.
//
// `public/sw.js` precaches the /offline HTML and the icon, and nothing else. This page
// is a CLIENT component, and build assets are `cacheFirst` — cached as a side effect of
// being fetched — so its route chunk reached the cache only if /offline had already been
// loaded in this browser. Nothing in the app links there, prefetches it, or visits it.
// So the precached shell was served to a first-time offline user, rendered, and never
// hydrated: no "View emergency card" button, no card, nothing but the static copy. The
// card was readable in a dead zone only for someone who had happened to open a page they
// had no reason to know existed.
//
// The test above hides this: its step 4 visits /offline online, which warms the chunk
// before its own offline block. This one never does, and that omission IS the assertion.
// The app warms the shell's code itself now, from the authenticated refresher
// (lib/offline/warm-offline-route.ts, under the owner's narrow amendment: the precache
// is still shell + icon, rendered HTML is still never cached, PHI is still never
// cached).
test("the emergency card is readable offline for a first-time offline user (#42/#2997)", async ({
  page,
  context,
}) => {
  test.slow();
  await login(page);

  // Opt in and let the device copy land — a client effect after hydration, so poll.
  await page.goto("/profile#emergency");
  const toggle = page.getByTestId("emergency-toggle");
  if (!(await toggle.isChecked())) {
    await toggle.check();
    await expect(page.getByLabel("Saved")).toBeVisible();
  }
  await expect(page.getByTestId("emergency-card")).toBeVisible();
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), LS_KEY))
    .toContain("Peanuts");

  // A live worker and the shell's own code in its cache — put there by the app, not by
  // this test. `readyForOffline` deliberately does not visit /offline.
  await readyForOffline(page);

  // `readyForOffline` is the LOAD-BEARING assertion, and its doc comment says why: an
  // "it renders offline" check cannot see this defect, because Playwright's offline
  // emulation does not cover the service worker's own fetches, so the worker keeps a
  // network the real device would not have. The offline block below is still worth
  // having — it pins the card end to end — but it is not what would go red.
  await context.setOffline(true);
  try {
    // A URL this context has NOT loaded, so the browser's own HTTP cache cannot satisfy
    // the navigation and the worker's offline fallback genuinely runs.
    await page.goto("/medications");
    // A pure client toggle, so hydratedClick rather than settledClick: there is no
    // Server Action here to correlate against.
    await hydratedClick(page, page.getByTestId("offline-view-emergency"));
    await expect(page.getByTestId("emergency-card")).toContainText("Peanuts");
  } finally {
    await context.setOffline(false);
  }
});
