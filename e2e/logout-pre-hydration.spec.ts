import { test, expect } from "./fixtures";
import { LOGOUT_TAPPED_ATTR } from "@/lib/logout-tap";

// LOG OUT SURVIVES A TAP THAT LANDS BEFORE HYDRATION (#3515, and the app-side half of
// #3400).
//
// THE DEFECT THIS PINS. Log out is the one control in this app with no
// progressive-enhancement fallback. `<form action={serverAction}>` + `type="submit"` —
// what the login form below is — carries a real `action` attribute in the server HTML, so
// a tap before React attaches still posts natively. Log out is `type="button"` with a
// React `onClick`, on a form whose action is a CLIENT function, so React SSRs no usable
// action attribute. #2908 made it `type="button"` deliberately: as a submit button the
// async IndexedDB PHI wipe raced the navigation and lost, leaving one login's med list
// and dose schedule readable session-free at /offline for the next person. That trade was
// right and stands — what it cost was this control's fallback, and nothing was put back.
//
// So a tap in that window did NOTHING AT ALL: no submit, no POST, no navigation, and no
// error either. On a shared or borrowed machine that is a person clicking Log out, seeing
// nothing happen, and walking away from it still signed in. It is also #3400: three CI
// reds whose only symptom was a bare `waitForURL` timeout naming nothing.
//
// THIS RUNS AT THE DEFAULT DESKTOP VIEWPORT ON PURPOSE, and that is the whole scope of
// the defect rather than a convenience. The Log out control is in the server HTML only
// inside the desktop sidebar (`app/(app)/layout.tsx`, `<aside … hidden … md:flex>`);
// below `md` that aside is `display:none` and the mobile drawer is a `createPortal`
// gated on client state (`components/MobileNav.tsx`), so on a phone there is no Log out
// to tap until the bundle has landed anyway. See lib/logout-tap.ts for why the phone's
// version of this is a different defect. A `mobile`-project twin of this spec would not
// be broader coverage; it would assert a window that does not exist.
//
// WHY THIS SPEC EXISTS AT ALL, given #3513 already landed `settledClick` on the
// emergency-card call site. That was an INSTRUMENT — it closes the window for one spec so
// a recurrence names its own shape. It does not fix the app, and it cannot: a person is
// not a spec and does not wait for hydration markers. #3513's lane said plainly that it
// COULD NOT REPRODUCE the swallow (CPU throttling at 20x and 50x navigated every time;
// `page.route` never fired because the service worker serves `/_next/static/**`
// `cacheFirst` and route interception does not see SW-mediated fetches), so it shipped
// with no test that fails without the fix. This spec is that test.
//
// HOW THE WINDOW IS FORCED, and why it is deterministic rather than sampled. Not a CPU
// throttle — a throttle makes the window PROBABLE and the #3513 lane exhausted the usable
// band proving that. Instead the JS chunks are HELD at the network until this spec
// releases them, so React provably cannot have attached, and `serviceWorkers: "block"`
// is what makes that hold reachable at all (it is the exact obstacle #3513 recorded).
//
// HOLD `.js` ONLY, AND THE PATTERN IS LOAD-BEARING RATHER THAN TIDY. In this Turbopack
// build the STYLESHEETS ALSO LIVE UNDER `/_next/static/chunks/`, so the obvious glob
// (`**/_next/static/chunks/**`) holds them too — and React 19 will not reveal a shell
// whose `<link rel=stylesheet data-precedence>` has not loaded, so the document stops at
// its <head> and the control never arrives at all. Measured here: 4.6 KB of HTML and no
// Log out button, failing as `element(s) not found` — the SAME symptom a swallowed tap
// produces, from a completely different cause. Holding only `.js` leaves the stylesheet
// alone, which is also what the assertions need: the pending state is painted by CSS.
test.describe("Log out tapped before hydration (#3515)", () => {
  test.use({
    // Its own unauthenticated context, logging in by hand, for the same reason
    // e2e/emergency-card.spec.ts does it: this spec exercises logout, which destroys the
    // session row server-side and would otherwise invalidate the shared cookie every
    // other spec relies on.
    storageState: { cookies: [], origins: [] },
    // Without this, `page.route` below never fires: public/sw.js serves `/_next/static/*`
    // cacheFirst and Playwright cannot intercept a service-worker-mediated fetch. #3513
    // hit exactly this and recorded it — "page.route cannot be used to stress hydration
    // anywhere in this app once the SW is controlling".
    serviceWorkers: "block",
  });

  test("the tap queues, shows a pending state, and logs out when React attaches", async ({
    page,
  }) => {
    // A login, a stalled navigation, a held-then-released bundle, a device wipe and a
    // logout round trip.
    test.slow();

    await page.goto("/login");
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "e2e-admin-pass");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
      timeout: 20_000,
    });

    // Hold every JS chunk, and ONLY the JS — see the `.js` note in the header comment;
    // the stylesheets share this directory and holding one stalls the whole shell.
    let releaseChunks = (): void => {};
    const chunksReleased = new Promise<void>((resolve) => {
      releaseChunks = resolve;
    });
    await page.route(
      /\/_next\/static\/chunks\/[^?]*\.js(\?|$)/,
      async (route) => {
        await chunksReleased;
        await route.continue();
      }
    );

    // `commit` — the document is what is wanted, and waiting for `load` would wait for
    // the very chunks being held.
    await page.goto("/", { waitUntil: "commit" });

    const logout = page.getByRole("button", { name: "Log out" });
    await expect(logout).toBeVisible();

    // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED, and it is what stops this spec
    // passing vacuously. If React had already attached, everything below would be an
    // ordinary click and would prove nothing about the window it names. No ceiling on
    // this read on purpose: it is a single instantaneous question about the node in front
    // of the tap, not a state being waited for.
    const hydrated = await logout.evaluate((node) =>
      Object.keys(node).some(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")
      )
    );
    expect(
      hydrated,
      "React had already attached, so this tap is not in the pre-hydration window and the spec proves nothing"
    ).toBe(false);

    // The tap. On main this is where everything stops: no submit event, no POST, no
    // navigation, no error, and the assertions below are what turn that silence into a
    // named failure instead of a bare timeout twenty seconds later.
    await logout.click();

    // 1. THE TAP WAS CAPTURED. LOGOUT_BOOT_SCRIPT wrote this from the document head,
    //    with no bundle in the page.
    await expect(logout).toHaveAttribute(LOGOUT_TAPPED_ATTR, "");
    // 2. IT IS ANNOUNCED. The name is still "Log out" — the control has not become a
    //    different control — and aria-busy is what carries "working on it".
    await expect(logout).toHaveAttribute("aria-busy", "true");
    // 3. IT IS VISIBLE. The spinner is in the server HTML and CSS reveals it, because a
    //    state that must paint before the bundle cannot be rendered conditionally by
    //    React. This is the assertion that would fail if the pending state were wired to
    //    React state alone.
    await expect(page.getByTestId("logout-pending")).toBeVisible();

    // Let React attach. The queued tap is replayed by SidebarContent's effect, which is
    // the first instant the click could have done anything at all.
    releaseChunks();

    // 4. THE LOGOUT ACTUALLY COMPLETES. A generous ceiling is honest here — this is a
    //    PRESENCE assertion, so waiting longer cannot manufacture a navigation that never
    //    started, and the wipe (bounded at WIPE_BUDGET_MS = 2s) plus a Server Action round
    //    trip sits behind a bundle that only starts downloading on the line above.
    await page.waitForURL(/\/login/, { timeout: 30_000 });

    // 5. AND THE SESSION IS REALLY GONE, not merely the URL. The queued tap must reach
    //    the same destroy a live tap does; a fix that navigated to /login without
    //    destroying the session would satisfy everything above and be worse than the bug.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });
});
