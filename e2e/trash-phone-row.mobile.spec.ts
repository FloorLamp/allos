import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { CARD_MODE_BREAKPOINT_PX } from "../lib/card-row";
import { plantTrashCaptures, sweepTrashProbes } from "./trash-probe";

// A TRASH ROW KEEPS ITS IDENTITY AT PHONE WIDTH (issue #3491 items 1 and 4).
//
// The row was one flex line — text (`min-w-0 flex-1`) beside two `shrink-0`
// buttons — so at 390px the headline got about 120px and `truncate` ate the date.
// An untitled capture read "activity · 2026-0…", which is the #1847 "five identical
// rows" problem re-created by the layout: the fallback headline's ENTIRE point is
// the date, and there is nothing else to tell one capture from another. With
// identity gone, "Delete permanently" is a blind choice.
//
// THIS IS A GEOMETRY PROBE, NOT A CLASS-LIST CHECK, for #3466's reason: a computed
// style is a DECLARATION and the reader gets a RENDERED result, and this tree has
// already shipped a green declaration over a wrong render. So the questions asked
// here are "does the date have a box", "is the text's box wider than the actions
// left it", "is the actions row BELOW the text" — every one of them off
// `getBoundingClientRect()`. `e2e/card-mode-boundary.spec.ts` is the worked example.
//
// AND THE PROBE PROVES IT CAN TELL THE DIFFERENCE. A "the date is visible"
// assertion passes on any layout that happens to fit, so the last test FORGES the
// old arrangement at the same width — the row put back on one line with the text
// clipped — and requires the same probe to call it truncated. Without that, a probe
// that had gone blind would read as a fixed layout.
//
// Fixture ownership (#868): every row measured here is planted by this spec and
// swept afterwards (e2e/trash-probe.ts). Nothing counts the shared trash, which any
// sibling spec's delete can add to.

const ROUTE = "/data?section=trash";

// Card mode is `width < CARD_MODE_BREAKPOINT_PX` (lib/card-row.ts). This project's
// viewport is 390px, which is inside it; asserting that rather than typing 390
// twice is what makes this spec move when the boundary moves (#3457/#3538).
const PHONE_WIDTH = 390;

// An UNTITLED capture — the payload root carries a date and no title — so the
// headline takes its fallback branch and leads with the kind label. This is the
// shape the whole issue is about.
const UNTITLED_LABEL = "probe kind untitled";
const UNTITLED_DATE = "2019-03-11";
// The formatted day the row must show. Deliberately spelled out rather than
// computed: if the surface stops formatting, this is what stops matching.
const UNTITLED_DATE_SHOWN = "Mar 11, 2019";

// A TITLED capture, whose headline leads with the title instead. Long enough that
// the old one-line layout had to clip it, short enough to fit a full-width phone
// line — which is exactly the band the fix is about.
const TITLED = "Morning ride along the river";
const TITLED_DATE = "2019-04-02";
const TITLED_DATE_SHOWN = "Apr 2, 2019";

interface RowShape {
  /** The row's own box. The corpus check: 0 means nothing rendered. */
  rowWidth: number;
  /** The headline paragraph's rendered box. */
  textWidth: number;
  /** Its full text, and how wide that text actually is when laid out. */
  headline: string;
  /** True when the headline's content overflows the box that is showing it. */
  headlineClipped: boolean;
  /** Top of the action pair's box, and of the text block's. */
  actionsTop: number;
  textBottom: number;
  /** The action pair's box, for the "wrapped to its own line" reading. */
  actionsLeft: number;
  textLeft: number;
}

/**
 * Read one row's rendered shape. No class names, no computed styles except the two
 * that ARE the painted result (a background colour is not a layout indirection).
 *
 * `headlineClipped` is the load-bearing reading and it is recovered from geometry:
 * `scrollWidth` is how wide the text WANTS to be, `clientWidth` how much box it
 * has. A truncated line reports the first strictly greater than the second, which
 * is true whatever produced the clipping — an ellipsis, an overflow, a narrower
 * parent — and false for a line that wrapped, because wrapping grows the height
 * instead.
 */
async function rowShape(page: Page, headlineText: string): Promise<RowShape> {
  return page.evaluate((needle) => {
    const rows = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="trash-row"]'),
    ];
    const row = rows.find((r) =>
      (
        r.querySelector('[data-testid="trash-row-headline"]')?.textContent ?? ""
      ).includes(needle)
    );
    if (!row)
      return {
        rowWidth: 0,
        textWidth: 0,
        headline: "",
        headlineClipped: false,
        actionsTop: 0,
        textBottom: 0,
        actionsLeft: 0,
        textLeft: 0,
      };
    const head = row.querySelector<HTMLElement>(
      '[data-testid="trash-row-headline"]'
    )!;
    const actions = row.querySelector<HTMLElement>(
      '[data-testid="trash-restore"]'
    )!.parentElement!;
    const headBox = head.getBoundingClientRect();
    const actionsBox = actions.getBoundingClientRect();
    const textBox = head.parentElement!.getBoundingClientRect();
    return {
      rowWidth: row.getBoundingClientRect().width,
      textWidth: headBox.width,
      headline: head.textContent ?? "",
      headlineClipped: head.scrollWidth > head.clientWidth,
      actionsTop: actionsBox.top,
      textBottom: textBox.bottom,
      actionsLeft: actionsBox.left,
      textLeft: textBox.left,
    };
  }, headlineText);
}

test.describe("Data → Trash at phone width (#3491)", () => {
  test.beforeEach(async () => {
    sweepTrashProbes();
    plantTrashCaptures([
      { labelSuffix: "untitled", title: null, date: UNTITLED_DATE },
      { labelSuffix: "titled", title: TITLED, date: TITLED_DATE },
    ]);
  });
  test.afterAll(sweepTrashProbes);

  test("an untitled capture keeps the date that is the only thing distinguishing it", async ({
    page,
  }) => {
    test.slow(); // local next dev compiles /data on first hit

    // The project's viewport really is inside card mode — otherwise this whole
    // file is measuring the desktop arrangement and its silence means nothing.
    const width = page.viewportSize()?.width ?? 0;
    expect(
      width,
      "this spec belongs to the `mobile` project, whose viewport must be below " +
        "the card-mode boundary for any of it to be a claim about a phone"
    ).toBe(PHONE_WIDTH);
    expect(PHONE_WIDTH).toBeLessThan(CARD_MODE_BREAKPOINT_PX);

    await page.goto(ROUTE);
    await expect(page.getByTestId("trash-list")).toBeVisible();
    // WAIT FOR THE CONTENT, NOT THE CONTAINER (#3384): a row measured between the
    // card's shell and its list is measuring an empty box, and empty fits.
    const row = page
      .getByTestId("trash-row")
      .filter({ hasText: UNTITLED_LABEL });
    await expect(row).toHaveCount(1);

    // ── THE ASSERTION THE ISSUE IS ABOUT ──────────────────────────────────────
    // The date is PRESENT and RENDERED, not merely in the DOM.
    const headline = row.getByTestId("trash-row-headline");
    await expect(headline).toBeVisible();
    await expect(headline).toHaveText(
      `${UNTITLED_LABEL} · ${UNTITLED_DATE_SHOWN}`
    );

    const shape = await rowShape(page, UNTITLED_LABEL);
    expect(shape.rowWidth).toBeGreaterThan(0);
    expect(
      shape.headlineClipped,
      `the headline "${shape.headline}" is clipped at ${PHONE_WIDTH}px — its ` +
        `content wants more room than its box has, which is the #3491 defect: ` +
        `the date is the fallback headline's entire point and the layout ` +
        `discards it.`
    ).toBe(false);

    // ── AND THE MECHANISM: the actions wrapped BELOW the text ─────────────────
    // Read as geometry rather than as a class: the action pair's top is at or
    // past the text block's bottom, and it starts at the row's left edge rather
    // than out to the right of the text.
    expect(
      shape.actionsTop,
      "the action pair is still sharing a line with the text, so the headline " +
        "is competing with two buttons for a 390px row (#3491 item 1)"
    ).toBeGreaterThanOrEqual(shape.textBottom);
    expect(
      Math.abs(shape.actionsLeft - shape.textLeft),
      "the action pair did not start at the text block's left edge, so it has " +
        "not taken a line of its own"
    ).toBeLessThanOrEqual(1);

    // The text block now spans the row rather than the sliver the buttons left.
    // Two thirds is a floor, not a pin: the exact width depends on card padding.
    expect(shape.textWidth).toBeGreaterThan(shape.rowWidth * 0.66);
  });

  test("a titled capture shows its title AND its date, both unclipped", async ({
    page,
  }) => {
    test.slow();
    await page.goto(ROUTE);
    const row = page.getByTestId("trash-row").filter({ hasText: TITLED });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("trash-row-headline")).toHaveText(
      `${TITLED} · ${TITLED_DATE_SHOWN}`
    );

    const shape = await rowShape(page, TITLED);
    expect(shape.rowWidth).toBeGreaterThan(0);
    expect(
      shape.headlineClipped,
      `"${shape.headline}" is clipped at ${PHONE_WIDTH}px — a titled capture ` +
        `loses its date the same way an untitled one loses its kind.`
    ).toBe(false);
  });

  test("the probe can SEE a clipped headline — the old arrangement, forged", async ({
    page,
  }) => {
    test.slow();
    await page.goto(ROUTE);
    const row = page.getByTestId("trash-row").filter({ hasText: TITLED });
    await expect(row).toHaveCount(1);

    const fixed = await rowShape(page, TITLED);
    expect(fixed.headlineClipped).toBe(false);

    // FORGED BY A SPEC on purpose — never a real render. This puts the row back
    // the way #3491 found it at the SAME width: one line, the text block back to
    // a flex sliver beside two shrink-0 buttons, the headline back to nowrap.
    // If the probe cannot call this clipped, then its verdict on the real layout
    // was never a measurement.
    await page.evaluate((needle) => {
      const rows = [
        ...document.querySelectorAll<HTMLElement>('[data-testid="trash-row"]'),
      ];
      const el = rows.find((r) => (r.textContent ?? "").includes(needle))!;
      const head = el.querySelector<HTMLElement>(
        '[data-testid="trash-row-headline"]'
      )!;
      const text = head.parentElement!;
      text.style.flexBasis = "auto";
      text.style.flex = "1 1 0%";
      head.style.whiteSpace = "nowrap";
      head.style.overflow = "hidden";
    }, TITLED);

    const forged = await rowShape(page, TITLED);
    expect(
      forged.headlineClipped,
      "the geometry probe did NOT see a headline it was just made to clip, so " +
        "its clean readings above mean nothing — the probe has gone blind."
    ).toBe(true);
    // …and the forged row is back on one line, which is the other half of the
    // arrangement the fix changed.
    expect(forged.actionsTop).toBeLessThan(forged.textBottom);
  });

  test("the row's destructive verb is quiet and the alarm lives on the confirm (#3491 item 4)", async ({
    page,
  }) => {
    test.slow();
    await page.goto(ROUTE);
    const row = page
      .getByTestId("trash-row")
      .filter({ hasText: UNTITLED_LABEL });
    await expect(row).toHaveCount(1);

    // THE DESIGN SYSTEM ALREADY SAYS THIS (docs/internals/design-system.md, the
    // OverflowMenu row): "a destructive verb is never a standing red button
    // beside a record and always confirms". The Trash row was the counter-
    // example, and on a surface whose whole purpose is recovery it wore the
    // heaviest treatment on the page once per row.
    //
    // NOT A GREP FOR `btn-danger`. The claim is about the PAINTED result, so it
    // is read as one: the row's purge shares its sibling Restore's surface —
    // whatever that surface currently is — while the confirm dialog's action
    // does NOT. A class-name check would go green on a renamed utility that
    // still fills.
    const restore = row.getByTestId("trash-restore");
    const purge = row.getByTestId("trash-purge");
    const bg = (loc: typeof restore) =>
      loc.evaluate((el) => getComputedStyle(el).backgroundColor);

    const restoreBg = await bg(restore);
    const purgeBg = await bg(purge);
    expect(
      purgeBg,
      "the row's Delete permanently is painted on a different surface than the " +
        "Restore beside it — a standing destructive fill on a recovery surface."
    ).toBe(restoreBg);

    // …and the alarm is not gone, it MOVED. The confirm dialog's action is where
    // the irreversible step is actually taken, and it still carries the fill.
    await purge.click();
    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toBeVisible();
    const confirmBg = await bg(
      dialog.getByRole("button", { name: "Delete permanently" })
    );
    expect(
      confirmBg,
      "the confirm dialog's Delete permanently no longer carries a treatment " +
        "of its own — demoting the row was supposed to MOVE the alarm here, " +
        "not remove it."
    ).not.toBe(restoreBg);

    // Leave the capture alone: the dialog is dismissed, nothing is purged.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });
});
