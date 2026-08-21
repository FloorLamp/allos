import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { openCommandPalette } from "./nav";
import { settledAfterAnimation, settledClick } from "./helpers";

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

    await settledClick(page, cancel);
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
    await expect(quickLog).toContainText("Tap to save");

    // THE PROFILE-SCOPE HALF SURVIVES. It is a claim about the DATA — the one
    // sentence saying whose records this searches — not an instruction about a
    // keyboard, so it renders at every width. Losing it here would be the
    // over-correction this issue's copy decision exists to prevent.
    await expect(panel).toContainText("Searching");

    // The "↵" glyph is a PICTURE OF A KEY, so it draws only where the key is.
    // Addressed by the tabler class the icon renders, since it carries no marker
    // of its own.
    await expect(panel.locator(".tabler-icon-corner-down-left")).toHaveCount(0);
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
});
