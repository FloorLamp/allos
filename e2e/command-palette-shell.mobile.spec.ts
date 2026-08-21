import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { openCommandPalette } from "./nav";
import { hydratedClick, settledAfterAnimation } from "./helpers";

// The command palette's PHONE SHELL (issue #3423).
//
// It used to be a centred `max-h-[85dvh]` card inset by `p-4` at every width,
// instructing "arrows to move, Enter to run" under the field and drawing a "↵"
// glyph as its commit affordance. On a phone that is a desktop dialog naming two
// keys the reader cannot press, inside a viewport the software keyboard is
// already eating. Below `md` it is now the phone idiom for its own content: a
// FULL-SCREEN SEARCH SURFACE — field at the top under a named Cancel, results
// filling everything beneath.
//
// WHAT THIS FILE IS AND IS NOT ASSERTING. Everything here is PRESENTATION. The
// search itself, the ranking, the quick-log parse and its commit path are
// unchanged and are pinned by e2e/palette-actions.spec.ts and
// e2e/palette-deeplinks.spec.ts at the desktop viewport; the desktop half of
// each width-gated decision below is pinned there too, deliberately in one place
// so "the phone lost it" and "the desktop kept it" are read side by side.
//
// THE SURFACE IS STILL THE SHARED HOST. `presentation="centered"` is unchanged —
// the palette's recorded anatomy exception in
// lib/__tests__/overlay-motion-chokepoint.test.ts still says why this is not a
// bottom sheet, and that reasoning was never touched. What moved is the box's
// EDGES, in `md:` classes on components/BottomSheet.tsx, so the portal, scrim,
// focus trap, scroll lock and Escape seam are the ones the palette already had.
//
// THIS FILE IS NEW, so it re-partitions the duration-balanced CI shards: every
// spec's NEIGHBOURS move, not just this one's. See docs/internals/e2e-hygiene.md.
//
// Fixture discipline (#868): every test is READ-ONLY. Opening the palette and
// typing into it writes nothing, and the one row that COULD commit (the quick-log
// preview) is only ever read — its commit path is exercised at desktop width by
// e2e/entry-ergonomics.spec.ts, which owns that write.

// The app's own touch floor (app/globals.css, `tap-target`; #644).
const TAP_FLOOR = 44;
// The `mobile` project's viewport (playwright.config.ts). 390 rather than the
// 430 the issue's screenshots were taken at, on purpose: both are below `md`,
// which is the only boundary any of this is keyed on, and 390 is the HARDER of
// the two for anything measuring whether content fits.
const PHONE_WIDTH = 390;

// The palette's panel — the `role="dialog"` BottomSheet mounts, addressed through
// its host testid so this does not depend on the palette's own internals.
function palettePanel(page: Page): Locator {
  return page.getByTestId("modal-shell").locator("[data-sheet-panel]");
}

// WAIT FOR THE ANIMATION TO FINISH BEFORE MEASURING THE BOX. The centred
// presentation's enter is a FADE (app/globals.css, `.overlay-enter-centered`),
// so its geometry is in fact stable from the first frame — but that is a fact
// about today's keyframe, not a property of the surface, and a spec that reads a
// bounding box mid-animation is one stylesheet edit away from being a sampler of
// a race (#3384). `settledAfterAnimation` costs one frame and removes the
// question. The panel's CONTENT is separately waited for by each caller, which
// is the half that actually flatters you when it resolves empty.
async function settledPanel(page: Page): Promise<Locator> {
  const panel = palettePanel(page);
  await expect(panel).toBeVisible();
  await settledAfterAnimation(panel);
  return panel;
}

test.describe("command palette — the phone shell (#3423)", () => {
  test("below md the palette fills the viewport, with a named Cancel that closes it", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    const input = await openCommandPalette(page);

    // The DECLARED decision, so a reader of a failure knows whether the shape was
    // chosen and mis-rendered or never chosen at all.
    await expect(page.getByTestId("modal-shell")).toHaveAttribute(
      "data-full-screen-below-md",
      ""
    );

    const panel = await settledPanel(page);
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    // Full-bleed: flush to both side edges and to the top. Not an exact-height
    // assertion — the panel clears the home indicator through
    // `env(safe-area-inset-bottom)`, which is 0 in a headless Chromium and need
    // not be — so the claim is "it starts at the top and spans the width", which
    // is exactly what a floating card inset by `p-4` fails.
    expect(box!.x).toBe(0);
    expect(box!.y).toBe(0);
    expect(box!.width).toBe(PHONE_WIDTH);
    // And it is not the old 85dvh card: the surface reaches the bottom of the
    // viewport rather than floating above it.
    const viewport = page.viewportSize()!;
    expect(box!.height).toBeGreaterThanOrEqual(viewport.height - 1);

    // The field is at the TOP — above every result, under the Cancel row.
    const inputBox = await input.boundingBox();
    expect(inputBox!.y).toBeLessThan(viewport.height / 3);

    // ONE named way out, and it is the accessible name too — not a bare "✕"
    // glyph under the tap floor.
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeVisible();
    const cancelBox = await cancel.boundingBox();
    expect(cancelBox!.height).toBeGreaterThanOrEqual(TAP_FLOOR);

    // `hydratedClick`, not `settledClick`: Cancel posts nothing — it closes a
    // read-only surface — and settledClick arms a POST wait that would time out
    // on a control that is behaving correctly.
    await hydratedClick(page, cancel);
    await expect(input).toBeHidden();
  });

  test("no instruction below md names a key the phone has no room for", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    const input = await openCommandPalette(page);
    // A parse that produces the quick-log row, so the row carrying the commit
    // affordance is on screen to be read. Read-only: nothing commits it.
    await input.fill("weight 82.5");
    const quickLog = page.getByTestId("palette-quicklog");
    await expect(quickLog).toBeVisible();

    const panel = await settledPanel(page);
    const text = (await panel.innerText()).toLowerCase();

    // The two instructions the owner reported, by their own words.
    expect(text).not.toContain("arrows to move");
    expect(text).not.toContain("enter to run");
    expect(text).not.toContain("enter to save");

    // The commit affordance is shaped like the gesture that reaches it.
    // `useInnerText` for the reason the desktop half of this pair records: the
    // fork is a `hidden md:inline` twin, and `textContent` reads both spellings
    // at both widths, so a default `toContainText` here would pass on a desktop
    // render too and assert nothing about the width gate.
    await expect(quickLog).toContainText("Tap to save", { useInnerText: true });

    // THE PROFILE-SCOPE HALF SURVIVES. It is a claim about the DATA — the one
    // sentence saying whose records this searches — not an instruction about a
    // keyboard, so it renders at every width. Losing it here would be the
    // over-correction this issue's copy decision exists to prevent.
    //
    // READ FROM `innerText`, like every other line in this block. A bare
    // `toContainText` falls back to `textContent`, which reads BOTH halves of a
    // `hidden md:*` fork at both widths — the reason the `Tap to save` assertion
    // six lines up passes `useInnerText`. Written the default way this one was
    // width-blind: hiding the whole hint below `md` left all seven tests in this
    // file green.
    expect(text).toContain("searching");

    // The "↵" glyph is a PICTURE OF A KEY, so it draws only where the key is.
    // Addressed by the tabler class the icon renders, since it carries no marker
    // of its own.
    //
    // `:visible`, NOT a bare count. The glyph is width-gated by a `hidden
    // md:block` class, which is exactly the app's own idiom for this (the ⌘K
    // hint, #3423's own reference point) — the element is in the DOM and
    // display:none. A `toHaveCount(0)` therefore fails against a CORRECT
    // implementation, and demanding it be unmounted instead would force a JS
    // width check for a purely visual gate. Measured: this assertion read 1
    // against a working fork before it was narrowed to visibility.
    await expect(
      panel.locator(".tabler-icon-corner-down-left:visible")
    ).toHaveCount(0);
  });

  test("a result row meets the tap floor and runs on one tap, with no hover first", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    const input = await openCommandPalette(page);
    await input.fill("log workout");

    const row = page.getByTestId("palette-action-log-workout");
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    // ~36px before this change: `px-2 py-2` around `text-sm`.
    expect(box!.height).toBeGreaterThanOrEqual(TAP_FLOOR);

    // ONE TAP, NO HOVER. `tap()` dispatches touch events only — it fires no
    // mouseenter at all — so a row whose commit still depended on the hover-only
    // highlight cannot pass this. That is the whole point: the highlight the ↵
    // glyph and the commit copy hang off was a state touch could never enter.
    await row.tap();
    await expect(page.getByTestId("activity-form")).toBeVisible();
  });

  test("the field asks the phone keyboard for a search key and an uncapitalised query", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    const input = await openCommandPalette(page);

    // The five attributes the OS reads. Asserted as ATTRIBUTES rather than by
    // screenshotting a keyboard, because the keyboard is the OS's and headless
    // Chromium has none — these are the whole of the app's side of the contract.
    await expect(input).toHaveAttribute("enterkeyhint", "search");
    await expect(input).toHaveAttribute("inputmode", "search");
    await expect(input).toHaveAttribute("autocapitalize", "off");
    await expect(input).toHaveAttribute("autocorrect", "off");
    await expect(input).toHaveAttribute("spellcheck", "false");
  });

  test("every keyboard path still works at phone width, and Escape does not ask about an abandoned query", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    // ⌘/Ctrl-K opened it (openCommandPalette presses exactly that).
    const input = await openCommandPalette(page);
    await input.fill("log workout");

    const row = page.getByTestId("palette-action-log-workout");
    await expect(row).toBeVisible();

    // Arrows still walk the list and Enter still runs it — the touch grammar was
    // added BESIDE the keyboard one, not in place of it, at every width. A phone
    // with a paired keyboard is a real device and this is the only place it is
    // asserted below `md`.
    await page.keyboard.press("ArrowDown");
    await expect(row).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("activity-form")).toBeVisible();
  });

  test("Escape closes a palette holding a typed query, with no discard prompt", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    const input = await openCommandPalette(page);
    await input.fill("weight 82.5");
    await expect(page.getByTestId("palette-quicklog")).toBeVisible();

    // A SEARCH QUERY IS NOT AUTHORED CONTENT (#3425's seam, and this surface's
    // side of it). #3425 routed Escape through the discard confirm when a dialog
    // holds unsaved work, and components/ModalShell.tsx's own sweep already
    // classifies the palette under NOTHING TO LOSE — "a search box, deliberately
    // untracked". Typing a query creates nothing: it is a lookup, thrown away
    // every time the palette closes by any route, and it is re-typed in seconds.
    // A confirm here would be a click-through on the app's most-used dismissal.
    //
    // Asserted as a PRESENCE (the palette leaves) rather than as the absence of a
    // confirm, because waiting longer can only ever make an absence assertion
    // greener — see the brief's rule. The confirm's absence is proved by the
    // palette being gone in one keystroke.
    await page.keyboard.press("Escape");
    await expect(input).toBeHidden();
  });

  // ── The two spellings, one at a time ──────────────────────────────────────
  //
  // The control is ONE button that reads "Cancel" below `md` and "✕" from `md`
  // up, forked by `md:hidden` on the word and `hidden md:block` on the glyph.
  // Nothing asserted that exactly one of them paints: the accessible name is
  // `aria-label="Cancel"` at BOTH widths (deliberately — WCAG 2.5.3), so
  // `getByRole("button", { name: "Cancel" })` reads the same at 390 and 1280 and
  // is blind to the fork. Deleting `md:hidden` paints "Cancel ✕" together at
  // desktop and every spec in the palette, records and page suites stayed green.
  //
  // So this reads the VISIBLE half: `innerText` for the word (which respects
  // `display: none`, where `textContent` would not) and the glyph's own
  // visibility for the picture.
  test("exactly one spelling of the close control paints at each width", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    await openCommandPalette(page);
    await settledPanel(page);

    const close = page.getByTestId("modal-shell-close");
    const glyph = close.locator("svg");
    await expect(close).toBeVisible();

    // Below `md`: the word, and only the word.
    expect((await close.innerText()).trim()).toBe("Cancel");
    await expect(glyph).toBeHidden();

    // From `md` up: the glyph, and only the glyph. `innerText` empty rather than
    // "Cancel" is the whole assertion — the span is still in the DOM.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(glyph).toBeVisible();
    await expect
      .poll(async () => (await close.innerText()).trim(), { timeout: 2000 })
      .toBe("");

    // The accessible name does NOT fork, and that is correct rather than an
    // oversight: "Cancel" is the accurate word for abandoning a search at either
    // width, and below `md` it is also the visible label, so the two agree.
    await expect(close).toHaveAttribute("aria-label", "Cancel");
  });

  // ── The 640–767px band, which is the only reason the FROM_MD map exists ────
  //
  // `OVERLAY_PANEL_MAX_WIDTH_FROM_MD` holds the size buckets off until `md`
  // instead of `sm`. Mutating it back to the plain `sm:` map left every spec in
  // the suite green, because nothing visits the width where the two maps differ:
  // below 640 both are uncapped, from 768 both cap, and only in between does
  // `sm:max-w-md` cut a full-bleed surface down to a 448px column with the scrim
  // showing down both sides — neither of the two shapes on offer.
  //
  // 700px is inside that band and still below `md`, so the palette must be
  // exactly as full-bleed here as it is at 390.
  test("a 700px viewport is still full-bleed, not a 448px column", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 844 });
    await page.goto("/upcoming");
    await openCommandPalette(page);
    const panel = await settledPanel(page);

    await expect(page.getByTestId("modal-shell")).toHaveAttribute(
      "data-full-screen-below-md",
      ""
    );
    const box = (await panel.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBe(700);
  });
});

// ── The close control's DISABLED treatment, both widths (#3455 × #3423) ─────
//
// This is the seam the two changes met at. #3455 gave the shared close control
// `closeDisabled` and the `disabled:pointer-events-none disabled:opacity-50`
// pair that makes a refused control LOOK refused; #3423 replaced that same
// `className` with a ternary on `asFullScreen`. Nothing in either suite reads
// the full-screen branch's disabled state, so a resolution that kept one side's
// string and dropped the other's would have been green everywhere.
//
// WHAT IS SYNTHETIC HERE, SAID PLAINLY: no consumer wires `closeDisabled` to the
// palette, so the test sets `disabled` on the element itself. That makes this a
// test of the CONTROL'S STYLESHEET CONTRACT at this width — "when this button is
// disabled, does it say so" — and not of any consumer's decision to disable it.
// That is the half the merge could break; the prop's plumbing is pinned by
// lib/__tests__/overlay-motion-chokepoint.test.ts and the dialog-convergence
// specs.
//
// `hasTouch: false`, DELIBERATELY, AND IT IS THE POINT OF THE HOVER HALF.
// Tailwind 4 compiles `hover:` inside `@media (hover: hover)`, so in the
// `mobile` project — which sets `hasTouch: true` — NO `hover:` class applies at
// all. A hover assertion there passes against an empty rule and proves nothing.
// A hover-capable context is the only place this control's hover behaviour can
// be observed at either width, so that is what this block uses.
test.describe("the disabled close control, both widths (hover-capable context)", () => {
  test.use({ hasTouch: false });

  test("says it is refused, and does not light up under a pointer", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    await openCommandPalette(page);
    await settledPanel(page);

    const cancel = page.getByTestId("modal-shell-close");
    await expect(cancel).toBeVisible();
    const paint = () =>
      cancel.evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, opacity: s.opacity, pe: s.pointerEvents };
      });

    const live = await paint();
    expect(live.opacity).toBe("1");
    expect(live.pe).not.toBe("none");

    await cancel.evaluate((el) => el.setAttribute("disabled", ""));
    const dead = await paint();

    // Faded, and unreachable. `disabled:pointer-events-none` is load-bearing
    // SEPARATELY from the fade — but it is worth being exact about WHERE, because
    // the two branches of this control do not need it equally. Tailwind emits
    // `disabled:` after `hover:` at equal specificity, so below `md`
    // `disabled:text-slate-500` already outranks `hover:text-brand-800` and the
    // hue is pinned twice over. At `md` and up it is not: `md:hover:` is a
    // BREAKPOINT variant and sorts after the unprefixed `disabled:`, so there
    // `pointer-events: none` is the only thing between a refused ✕ and
    // `md:hover:text-slate-600`. This test reads both widths for that reason,
    // and the desktop half at the end is the one that bites.
    expect(dead.opacity).toBe("0.5");
    expect(dead.pe).toBe("none");

    // THE HUE CHANGES, not just the alpha. Fading a saturated brand colour reads
    // as washed-out brand rather than as disabled — the ruling #1450 already made
    // for the button family (app/globals.css, `.btn:disabled`), and measurement
    // agrees here: faded brand-400 on the dark surface clears the ✕'s own
    // disabled contrast by half again, on a hue that still reads as a live link.
    expect(dead.color).not.toBe(live.color);

    // Hover it by COORDINATE. `locator.hover()` refuses a `pointer-events: none`
    // target, so it would skip the very assertion this is here to make.
    const hoverCancel = async () => {
      await page.mouse.move(0, 0);
      const box = (await cancel.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    };
    await hoverCancel();
    await expect
      .poll(async () => (await paint()).color, { timeout: 2000 })
      .toBe(dead.color);
    expect((await paint()).opacity).toBe("0.5");

    // ONE disabled look, not a second one invented for the phone: the colour the
    // full-screen Cancel takes when refused is the colour the ✕ takes when
    // refused, read from the same element at desktop width rather than hardcoded
    // as a hex the palette could drift away from.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect
      .poll(async () => (await paint()).color, { timeout: 2000 })
      .toBe(dead.color);

    // AND HERE IS WHAT `pointer-events: none` IS FOR. At this width
    // `md:hover:text-slate-600` sorts AFTER `disabled:text-slate-500` at equal
    // specificity, so it WOULD repaint the refused ✕ under a pointer — verified
    // by deleting the class: slate-500 rgb(78,99,84) became slate-600
    // rgb(64,84,70) on this line.
    //
    // TO BE EXACT ABOUT THE ORDER, because an earlier draft of this comment was
    // not: deleting `disabled:pointer-events-none` trips the resting-state
    // `expect(dead.pe).toBe("none")` above FIRST, at phone width, and that is the
    // line a bisect would name. This line is not the one that catches the
    // deletion — it is the one that shows why the deletion matters. The resting
    // check says the property is set; this says the property is load-bearing.
    await hoverCancel();
    await expect
      .poll(async () => (await paint()).color, { timeout: 2000 })
      .toBe(dead.color);
  });
});
