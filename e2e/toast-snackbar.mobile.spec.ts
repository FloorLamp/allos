import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { hydratedClick, settledClick } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_MOBILITY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The phone toast is a SNACKBAR (issue #3373).
//
// It used to be the desktop corner card at every width — a `w-72` slab hugging the
// right edge of a 390px screen, with no enter/exit motion, a 16px dismiss glyph and
// an unbounded stack. Below `md` it is now one full-width bar on the bottom edge,
// one at a time, with the rest queued behind it. From `md` up nothing changed, so
// there is nothing here at that width.
//
// WHY THE OFFLINE MOBILITY TAPS RAISE THE TOASTS. Everything asserted here is about
// what the toast LAYER does when two toasts arrive close together, so the flow that
// raises them has to be fast and has to raise two DISTINGUISHABLE ones. With the
// connection cut, the mobility chip's ON tap queues locally and confirms ("Saved
// offline — …", success/6s) and its OFF tap is refused ("You're offline — removing
// a move needs a connection.", error/10s) — neither waits on a server round trip,
// which a revalidating write would have put between the two posts.
//
// THIS FILE IS NEW, so it re-partitions the duration-balanced CI shards: every
// spec's NEIGHBOURS move, not just this one's. See docs/internals/e2e-hygiene.md.
//
// Fixture discipline (#868): the dedicated mobility login, two moves no other spec
// touches (offline-mobility owns neck_cars, offline-refused-capture wrist_cars,
// mobility pigeon_pose/cat_cow), and each test reconnects, lets its queued entry
// replay, and puts its move back where it found it.

// `loginAs` builds its OWN context, which does NOT inherit the project's `use`
// block — so the phone viewport is passed explicitly rather than inherited from
// this file's `.mobile.spec.ts` name.
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };
// The app's own touch floor (app/globals.css, `tap-target`; #644).
const TAP_FLOOR = 44;
// What `max(1rem, env(safe-area-inset-*))` resolves to with no hardware inset —
// the gutter the bottom-edge tokens put on both sides of the bar.
const GUTTER = 16;

const SAVED_OFFLINE = "Saved offline — will sync when you reconnect.";
const REFUSED_OFFLINE = "You're offline — removing a move needs a connection.";

async function openMobility(page: Page, slug: string) {
  await page.goto("/training?tab=overview");
  const chip = page.getByTestId(`mobility-move-${slug}`);
  await expect(chip).toBeVisible();
  // Normalize to OFF so the flow is repeat-safe.
  if ((await chip.getAttribute("aria-pressed")) === "true") {
    await settledClick(page, chip);
    await expect(chip).toHaveAttribute("aria-pressed", "false");
  }
  return chip;
}

// The bar spans the row: both safe-area gutters and everything between them. This
// is the anatomy, not a literal width — a hardware inset moves both edges together
// and still passes, while the old 288px corner card (which left ~86px of empty
// screen to its left) fails on the left edge.
function expectFullWidthBar(box: { x: number; width: number }) {
  expect(box.x).toBeLessThanOrEqual(GUTTER + 1);
  expect(box.x + box.width).toBeGreaterThanOrEqual(
    PHONE.viewport.width - GUTTER - 1
  );
}

// The bar's box AFTER its keyframes have run.
//
// MEASURED, NOT ASSUMED: taken the moment the text appears, the read lands mid
// `overlay-slide-up-in` and the bar is still ~46px low — it reported a bottom edge
// of 833 against a dock top of 787 and looked exactly like a broken bottom-edge
// claim. Waiting on the element's own animations is the fix, and it is a WAIT on
// the thing being measured rather than a widened tolerance, so a bar that really
// did sit over the dock still fails (#3373).
async function settledBox(toast: Locator) {
  await toast.evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})))
  );
  const box = await toast.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

// Reconnect, let the queued write replay, and put the move back where it started.
async function drainAndRestore(page: Page, slug: string) {
  await page.context().setOffline(false);
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);
  await page.reload();
  const chip = page.getByTestId(`mobility-move-${slug}`);
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await settledClick(page, chip);
  await expect(chip).toHaveAttribute("aria-pressed", "false");
}

test("a phone toast is one full-width bar above the dock, and a second waits its turn (#3373)", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_MOBILITY, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
  const context = page.context();
  try {
    const chip = await openMobility(page, "couch_stretch");

    await context.setOffline(true);
    await hydratedClick(page, chip);

    const toast = page.getByTestId("toast");
    await expect(toast).toHaveText(SAVED_OFFLINE);

    // ── Shape: a bar, gutter to gutter, not a corner card ──────────────────
    const bar = await settledBox(toast);
    expectFullWidthBar(bar);

    // ── Layer: still the bottom-edge claim, still above the dock ───────────
    const dock = page.getByTestId("mobile-dock");
    await expect(dock).toBeVisible();
    const dockBox = (await dock.boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(dockBox.y + 1);

    // ── Motion: the shared overlay tokens, not a hand-rolled slide ─────────
    // The class is what carries `--overlay-ms` / `--overlay-ease-*`; it stays on
    // the element after the keyframe has run, so this is a settled read and not a
    // race against the animation. The reduced-motion half is the test below.
    await expect(toast).toHaveClass(/overlay-enter-notice/);

    // ── Thumb affordances ──────────────────────────────────────────────────
    const dismiss = toast.getByRole("button", { name: "Dismiss" });
    const dismissBox = (await dismiss.boundingBox())!;
    expect(dismissBox.width).toBeGreaterThanOrEqual(TAP_FLOOR);
    expect(dismissBox.height).toBeGreaterThanOrEqual(TAP_FLOOR);
    // Reachable by keyboard as well as by thumb.
    await dismiss.focus();
    await expect(dismiss).toBeFocused();

    // ── The queue: one at a time, in order, nothing dropped ────────────────
    // The OFF tap is refused offline, so a SECOND, distinct toast is posted while
    // the first is still up. A queued toast is not in the DOM at all, so the proof
    // is the HAND-OVER rather than a count of something invisible: while the first
    // bar is up `toHaveText` finds exactly ONE element carrying the first message
    // (a stacked second one would fail it), and the moment that bar goes the
    // refusal is there — neither buried under it nor dropped. The ORDER itself is
    // pinned unit-side, over the list arithmetic (lib/__tests__/toast-upsert).
    await chip.click();
    await expect(toast).toHaveText(SAVED_OFFLINE);
    await hydratedClick(page, dismiss);
    await expect(toast).toHaveText(REFUSED_OFFLINE);

    // ── Over an open overlay, nothing is deferred (#3038) ──────────────────
    // The drawer's overlay is `fixed inset-0 z-40`; the notice layer is `z-100`,
    // so the bar the reader was just handed is still the topmost thing at its own
    // centre instead of being buried by an overlay opening over it.
    await hydratedClick(page, page.getByTestId("dock-slot-more"));
    await expect(page.getByTestId("mobile-drawer")).toBeVisible();
    const overBox = await settledBox(toast);
    expectFullWidthBar(overBox);
    const onTop = await page.evaluate(
      ([x, y]) =>
        !!document.elementFromPoint(x, y)?.closest('[data-testid="toast"]'),
      [overBox.x + overBox.width / 2, overBox.y + overBox.height / 2]
    );
    expect(onTop, "the toast bar is above the drawer's scrim").toBe(true);
    // Dismiss it the ordinary way. POSITIONED on purpose: the backdrop spans the
    // viewport but the drawer panel (`w-72 max-w-[85%]`) covers its middle, so an
    // unpositioned click lands on the panel and is refused as intercepted.
    await page
      .getByTestId("mobile-drawer-backdrop")
      .click({ position: { x: 375, y: 400 } });
    await expect(page.getByTestId("mobile-drawer")).toHaveCount(0);
  } finally {
    await drainAndRestore(page, "couch_stretch");
  }
});

test("under reduced motion the bar arrives instantly — no keyframe is scheduled (#3373)", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_MOBILITY, password: E2E_MEMBER_PASSWORD },
    { ...PHONE, reducedMotion: "reduce" }
  );
  try {
    const chip = await openMobility(page, "glute_bridge");
    await page.context().setOffline(true);
    await hydratedClick(page, chip);

    const toast = page.getByTestId("toast");
    await expect(toast).toHaveText(SAVED_OFFLINE);
    // `overlayMotionClass` returns "" under the preference, so there is no class
    // to animate — the same state sequence, snapped (#794 8d / #1416 F).
    await expect(toast).not.toHaveClass(/overlay-(enter|exit)-notice/);
    // Reduced motion takes away the travel, not the shape.
    expectFullWidthBar(await settledBox(toast));
  } finally {
    await drainAndRestore(page, "glute_bridge");
  }
});
