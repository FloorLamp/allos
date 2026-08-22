import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { CARD_MODE_BREAKPOINT_PX } from "../lib/card-row";

// WHERE CARD MODE STARTS, MEASURED AS A RENDERED LAYOUT (issue #3457).
//
// #3457's mismatch: `table-cards` does its work in `max-sm:` while the
// mobile-native campaign wrote its requirements in `md`. At 390px and 430px —
// the only widths anyone tested — the two boundaries agree, so the disagreement
// only ever showed between 640px and 768px, where a surface a requirement called
// cards rendered as a sort-header table and nothing looked wrong.
//
// It resolved toward `sm`, and this spec is why that is not a concession. The
// 640–768px band already has a DESIGNED rendering: the record lists ladder their
// columns in three steps, and the `hidden sm:table-cell` tier exists only to give
// that band a narrower table than the desktop one. The last test here measures
// what widening the utility to the `md` breakpoint would actually do to it.
//
// THIS IS A GEOMETRY PROBE, NOT A CLASS-LIST CHECK. A computed-style assertion
// measures a DECLARATION; the reader sees a RENDERED result, and this tree has
// already shipped a green declaration over a wrong render (#3466's stepped seam,
// correct on the element it styled and collapsed against an unstepped parent).
// So the probe reads `getBoundingClientRect()` — how tall the header strip is,
// how many vertical bands a row's cells occupy, which labels have a box — and
// never asks an element what class it carries. #3529's probes and
// `expectAtomicCardPairs` in e2e/helpers.ts are the worked examples.
//
// It runs in the DESKTOP project on purpose: the subject is a range of widths,
// not a phone, and it sets each one itself. The widths are DERIVED from
// `CARD_MODE_BREAKPOINT_PX` (lib/card-row.ts) rather than typed, so moving the
// boundary moves this spec with it instead of leaving it green about the wrong
// number — which is the whole shape of the defect #3457 reported.

// #3408's own surface: the vaccine list, whose item D said "becomes rows below
// `md`" and whose AC named 430px.
const ROUTE = "/records/history/immunizations";
const TABLE = "immunization-vaccines-table";

const VIEWPORT_HEIGHT = 900;

// Card mode is `width < CARD_MODE_BREAKPOINT_PX`. A phone sits well inside it;
// 430px is the width #3408's ACs named, and 390px the one the mobile project
// uses, so this is below both without being a magic number.
const PHONE_WIDTH = CARD_MODE_BREAKPOINT_PX - 250;
// The band #3457 is about: above the card-mode boundary, below `md` (768px).
// The midpoint, so neither edge can be reached by an off-by-one.
const BAND_WIDTH = (CARD_MODE_BREAKPOINT_PX + 768) / 2;
// Comfortably above `md`, where every column is back.
const DESKTOP_WIDTH = 1024;

type Presentation = "cards" | "table" | "mixed";

interface BoundaryProbe {
  /** Data rows the probe measured. The corpus. */
  rows: number;
  /** Cells with a rendered box across those rows. The corpus. */
  cells: number;
  /** The header strip's rendered height. 0 ⇒ `thead` draws nothing. */
  headerHeight: number;
  /** The most vertical bands any one row's rendered cells occupy. */
  maxRowLines: number;
  /** Column labels reprinted INSIDE a cell — a card-mode-only element. */
  cardLabels: string[];
  /** Column headers in `thead` with a rendered box. */
  headers: string[];
}

/**
 * Read the table's rendered shape. No class names, no computed styles.
 *
 * `maxRowLines` is the load-bearing reading and it is recovered from geometry:
 * a row's visible cells are bucketed by their rounded `top`, so a TABLE row —
 * whose cells are laid out side by side by the table algorithm — reports 1, and
 * a CARD — whose title, value and meta pairs wrap onto separate lines — reports
 * more. Bucketing by top rather than asking for a `display` value is what makes
 * this a claim about the layout the reader gets.
 */
async function probe(page: Page): Promise<BoundaryProbe> {
  return page.evaluate((testid) => {
    const table = document.querySelector<HTMLElement>(
      `[data-testid="${testid}"]`
    );
    if (!table)
      return {
        rows: 0,
        cells: 0,
        headerHeight: 0,
        maxRowLines: 0,
        cardLabels: [],
        headers: [],
      };
    const boxed = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const head = table.querySelector("thead");
    const headerHeight = head
      ? Math.round(head.getBoundingClientRect().height)
      : 0;
    const headers = [...table.querySelectorAll("thead th")]
      .filter(boxed)
      .map((th) => th.textContent?.trim() ?? "");
    const cardLabels = [...table.querySelectorAll("tbody .card-cell-label")]
      .filter(boxed)
      .map((s) => s.textContent?.trim() ?? "");

    let cells = 0;
    let maxRowLines = 0;
    const rows = [...table.querySelectorAll("tbody tr")];
    for (const row of rows) {
      const visible = [...row.querySelectorAll(":scope > td")].filter(boxed);
      cells += visible.length;
      const bands = new Set(
        visible.map((td) => Math.round(td.getBoundingClientRect().top))
      );
      maxRowLines = Math.max(maxRowLines, bands.size);
    }
    return {
      rows: rows.length,
      cells,
      headerHeight,
      maxRowLines,
      cardLabels,
      headers,
    };
  }, TABLE);
}

/**
 * The verdict, from the readings alone.
 *
 * Both halves are required in each direction, so a forgery has to move BOTH to
 * fool it: card mode both removes the header strip and wraps a row onto several
 * lines, and a table does neither. A reading that satisfies neither description
 * is `mixed` — reported as itself rather than defaulted to one side, because a
 * half-transformed table is exactly the state #3457 describes.
 */
function presentation(p: BoundaryProbe): Presentation {
  if (p.headerHeight === 0 && p.maxRowLines > 1 && p.cardLabels.length > 0)
    return "cards";
  if (p.headerHeight > 0 && p.maxRowLines === 1 && p.cardLabels.length === 0)
    return "table";
  return "mixed";
}

// The two forgeries are each other: at a table width we force the card layout on,
// at a card width we force it off. Both are written as raw rendered properties,
// never as class names — a forgery that reused the app's own classes would prove
// only that the class still exists.
const FORGE_CARDS = `
  [data-testid="${TABLE}"] thead { display: none !important; }
  [data-testid="${TABLE}"] tbody { display: block !important; }
  [data-testid="${TABLE}"] tbody tr { display: flex !important; flex-wrap: wrap !important; }
  [data-testid="${TABLE}"] tbody td { display: block !important; width: 100% !important; }
  [data-testid="${TABLE}"] tbody td[data-card="meta"] { display: inline-flex !important; width: auto !important; }
  [data-testid="${TABLE}"] tbody .card-cell-label { display: inline !important; }
`;
// THE TABLE DISPLAY VALUES ARE ASSEMBLED, NOT WRITTEN, AND THAT IS DELIBERATE.
//
// Tailwind's content scanner reads every tracked source file as TEXT, so a token
// that looks like a class name compiles to a real rule wherever it appears —
// #3523 found a min-height utility shipped into production CSS from an English
// sentence in a comment. Written out, the four values below each add a real
// display utility to the app's stylesheet OUTSIDE the phone media query, where
// this change is supposed to contribute nothing. Measured on this PR's own
// compiled-sheet diff against `origin/main`, which is how they were found — and
// then found a SECOND time, because the first draft of this very comment spelled
// the four class names out in order to explain them and put them straight back.
// So neither the code nor its explanation writes one: `table` on its own is
// already a shipped utility and a bare suffix is not a candidate, so the
// composition below emits nothing and this paragraph names nothing.
const tableDisplay = (part: string) => `table${part}`;

const FORGE_TABLE = `
  [data-testid="${TABLE}"] { display: ${tableDisplay("")} !important; }
  [data-testid="${TABLE}"] thead { display: ${tableDisplay("-header-group")} !important; }
  [data-testid="${TABLE}"] tbody { display: ${tableDisplay("-row-group")} !important; }
  [data-testid="${TABLE}"] tbody tr { display: ${tableDisplay("-row")} !important; }
  [data-testid="${TABLE}"] tbody td { display: ${tableDisplay("-cell")} !important; }
  [data-testid="${TABLE}"] tbody .card-cell-label { display: none !important; }
`;

const FORGED_STYLE_ID = "forged-card-mode-boundary";

async function forge(page: Page, css: string): Promise<void> {
  await page.evaluate(
    ([id, text]) => {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = text;
      document.head.append(style);
    },
    [FORGED_STYLE_ID, css] as const
  );
}

async function restore(page: Page): Promise<void> {
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, FORGED_STYLE_ID);
}

/**
 * Assert one width's rendered presentation, WITH the discriminator attached.
 *
 * "This surface is a table at 700px" is satisfiable by a probe that has gone
 * blind — a renamed testid, a rect read that degraded to zeroes, a route that
 * stopped rendering the list — so the discriminator is not an optional extra a
 * call site may skip. It lives here, bound to the assertion, the shape
 * `expectAtomicCardPairs` uses for the same reason (#3509, #3517). Four steps:
 *
 *   (a) WAIT FOR THE CONTENT BEING MEASURED, not for the container. A table that
 *       has not rendered its rows yet is one line tall with no labels, which
 *       reads as a perfectly clean "table" — the empty DOM flattering the
 *       measurement (#3384);
 *   (b) the corpus the probe saw is non-trivial, and `mustSee` is in it;
 *   (c) the presentation is the expected one;
 *   (d) the OTHER presentation, forged at this same width, is reported as the
 *       other presentation — so a probe that cannot tell them apart fails loudly
 *       instead of agreeing with whatever it was asked. The control runs AFTER
 *       the restore, not only before it.
 */
async function expectPresentation(
  page: Page,
  opts: {
    width: number;
    expected: Exclude<Presentation, "mixed">;
    mustSee: string[];
  }
): Promise<BoundaryProbe> {
  await page.setViewportSize({ width: opts.width, height: VIEWPORT_HEIGHT });
  await expect(
    page.getByTestId(TABLE).locator('tbody a[href^="/immunizations/"]').first() // first-ok: any rendered vaccine row proves the list is past its empty state, which is all this wait is for
  ).toBeVisible();

  const seen = await probe(page);
  const report = `probe at ${opts.width}px: ${JSON.stringify(seen)}`;
  expect(seen.rows, report).toBeGreaterThan(1);
  expect(seen.cells, report).toBeGreaterThan(3);
  const visible = [...seen.headers, ...seen.cardLabels];
  expect(visible, report).toEqual(expect.arrayContaining(opts.mustSee));
  expect(presentation(seen), report).toBe(opts.expected);

  const other = opts.expected === "cards" ? "table" : "cards";
  await forge(page, opts.expected === "cards" ? FORGE_TABLE : FORGE_CARDS);
  const forged = await probe(page);
  expect(
    presentation(forged),
    `a ${other} layout forged at ${opts.width}px was still read as ` +
      `"${presentation(forged)}". The probe cannot tell the two presentations ` +
      `apart, so its verdict above meant nothing. Forged probe: ` +
      JSON.stringify(forged)
  ).toBe(other);

  await restore(page);
  expect(presentation(await probe(page)), report).toBe(opts.expected);
  return seen;
}

test.beforeEach(async ({ page }) => {
  await page.goto(ROUTE);
});

test("below the boundary the vaccine list renders as cards, with every column back as a labeled line", async ({
  page,
}) => {
  // The card gets MORE than the narrow table does: `Doses` and `Next due` are
  // `hidden md:table-cell` columns, and card mode re-places them as meta lines
  // rather than losing them (`.table-cards td[data-card]` outranks `.hidden`).
  const seen = await expectPresentation(page, {
    width: PHONE_WIDTH,
    expected: "cards",
    mustSee: ["Last dose", "Doses", "Next due"],
  });
  expect(seen.headers, "the header strip is gone in card mode").toEqual([]);
});

test("between the boundary and `md` it is a narrower TABLE, which is the tier that band is for", async ({
  page,
}) => {
  const seen = await expectPresentation(page, {
    width: BAND_WIDTH,
    expected: "table",
    mustSee: ["Vaccine", "Status", "Last dose"],
  });
  // The middle rung of the three-step ladder, measured: `Last dose` has arrived
  // (`hidden sm:table-cell`), `Doses` and `Next due` have not (`hidden
  // md:table-cell`). This is the rendering #3457 chose to keep — paired with the
  // presence claims above, so it is not an absence over an empty corpus.
  expect(
    seen.headers,
    `the ${BAND_WIDTH}px band is supposed to render the sm-tier column and not ` +
      `the md-tier ones. Headers seen: ${seen.headers.join(" | ")}`
  ).not.toEqual(expect.arrayContaining(["Doses"]));
  expect(seen.headers).not.toEqual(expect.arrayContaining(["Next due"]));
});

test("above `md` every column is back", async ({ page }) => {
  await expectPresentation(page, {
    width: DESKTOP_WIDTH,
    expected: "table",
    mustSee: ["Vaccine", "Status", "Last dose", "Doses", "Next due"],
  });
});

test("moving card mode to the `md` breakpoint would silence the sm column tier — measured, not argued", async ({
  page,
}) => {
  // THE EVIDENCE FOR #3457's RESOLUTION, kept as a regression guard rather than
  // left in a PR body. Option 1 on that issue was "`table-cards` moves to the
  // `md` breakpoint". This forges exactly that rendering at a width inside the
  // band and reads what happens to the column ladder: the `hidden md:table-cell`
  // cells come back — `.table-cards td[data-card]` is (0,2,1) and `.hidden` is
  // (0,1,0) — so the tier the band exists for stops being read at all, at every
  // one of the lists that ladder their columns.
  await page.setViewportSize({ width: BAND_WIDTH, height: VIEWPORT_HEIGHT });
  await expect(
    page.getByTestId(TABLE).locator('tbody a[href^="/immunizations/"]').first() // first-ok: any rendered vaccine row proves the list is past its empty state
  ).toBeVisible();

  const before = await probe(page);
  expect(presentation(before), JSON.stringify(before)).toBe("table");
  expect(before.cardLabels).toEqual([]);

  await forge(page, FORGE_CARDS);
  const after = await probe(page);
  expect(presentation(after), JSON.stringify(after)).toBe("cards");
  expect(
    after.cardLabels,
    "with card mode widened to the `md` breakpoint, the md-tier columns render " +
      "in the 640–768px band after all — so `hidden md:table-cell` and " +
      "`hidden sm:table-cell` would both stop deciding anything there. That is " +
      "what #3457 declined."
  ).toEqual(expect.arrayContaining(["Doses", "Next due"]));

  await restore(page);
  const control = await probe(page);
  expect(presentation(control), JSON.stringify(control)).toBe("table");
  expect(control.cardLabels).toEqual([]);
});
