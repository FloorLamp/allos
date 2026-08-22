import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { settledClick } from "./helpers";
import { LEAD_MAX_CHARS } from "@/lib/lead-fold-census";

// THE LEAD + FOLD CENSUS, OVER RENDERED BOXES AT 390px (#3488, #3490).
//
// Its sibling lib/__tests__/lead-fold-census.test.ts bounds the SOURCE — no
// registry entry may carry a paragraph in `lead`. This file asks the question the
// owner actually asked on a phone: how tall is the intro before the first control?
// A character budget is a proxy; #3529 wrote down why the proxy is not enough — a
// computed style measures a DECLARATION and the reader sees a RENDERED result — so
// every number below comes from `getBoundingClientRect()` on the real paragraph in
// a real 390px viewport.
//
// ── IT IS AN ABSENCE ASSERTION, SO IT FAILS OPEN ────────────────────────────────
//
// "No intro is taller than two lines" goes green the instant the probe stops
// finding intros: a renamed testid, a route that 404s, a card that renders its
// shell first. So nothing here believes a clean sweep until the sweep proves it
// happened, in the same three steps the machine-date census uses:
//
//   1. A CENSUS FLOOR — `EXPECTED_INTROS` intros, examined, counted, and compared
//      against a recorded number rather than against itself.
//   2. A NAMED SUBJECT per route: the lead paragraph must be VISIBLE and carry
//      real text before its height is read. Waiting for the container instead of
//      the content is how a race resolves toward the empty DOM, and empty is the
//      state that flatters a height ceiling.
//   3. A SYNTHETIC OFFENDER planted in the live DOM — the actual 72-word
//      health-connect blurb this issue pair was filed about — which the same
//      measurement must flag.
//
// Fixture (#868 hygiene): READ-ONLY. It navigates, measures, and plants its
// offender in a DOM that is about to be discarded. Nothing is written.

/**
 * THE CEILING, IN RENDERED LINES OF THE ELEMENT'S OWN LINE BOX.
 *
 * Not pixels, on purpose. A pixel ceiling encodes a font metric — 20px for
 * `text-sm` today — and would go red on a font change that a reader would call an
 * improvement, or silently permit three lines if the line box shrank. Lines are
 * what "the intro is seven lines before any content" (#3490) and "the intro fits
 * in ~2 lines at 390px" (#3488) are both stated in, so lines is the unit the
 * acceptance criteria are written in and the unit this asserts.
 *
 * The count is `round(boxHeight / lineHeight)` read from the live element, so the
 * two quantities come from the same box and a rounding of 40.4px over a 20.2px
 * line box is 2, not 2.02.
 */
const MAX_LEAD_LINES = 2;

/**
 * The number of intros this census must find. A floor AND a ceiling: fewer means
 * the sweep silently shortened, more means a surface adopted the primitive without
 * being added here, and both should be a diff somebody has to justify.
 */
const EXPECTED_INTROS = 9;

interface IntroRoute {
  path: string;
  /** The `data-testid` prefix the adopter passed to `<LeadFold>`. */
  testId: string;
  /** What this route is in the census FOR. */
  why: string;
  /** A distinctive fragment of the lead, so "it rendered" is a claim about the RIGHT text. */
  leadFragment: string;
  /** True when this surface folds a detail — the ones with nothing to fold say so. */
  folds: boolean;
}

const ROUTES: IntroRoute[] = [
  {
    path: "/data?section=import",
    testId: "upload-intro",
    why: "#3488's standards wall — CCD/XDM, SMART Health Card and FHIR in bold above both buttons.",
    leadFragment: "Drop in a lab report, scan, or health-record export",
    folds: true,
  },
  {
    path: "/integrations/health-connect",
    testId: "integration-intro",
    why: "#3490's filing surface: 72 words, seven lines at 390px before any control.",
    leadFragment: "Sync weight, heart rate, steps",
    folds: true,
  },
  {
    path: "/integrations/fitbit-takeout",
    testId: "integration-intro",
    why: "The registry's longest blurb at 146 words.",
    leadFragment: "Import a Fitbit account export",
    folds: true,
  },
  {
    path: "/integrations/weather",
    testId: "integration-intro",
    why: "73 words — the second worst.",
    leadFragment: "Bring in the actual UV index",
    folds: true,
  },
  {
    path: "/integrations/withings",
    testId: "integration-intro",
    why: "40 words; the sweep is every entry, not the three worst.",
    leadFragment: "Pull weight, blood pressure, sleep",
    folds: true,
  },
  {
    path: "/integrations/calendar-feed",
    testId: "integration-intro",
    why: "39 words.",
    leadFragment: "Subscribe to your appointments",
    folds: true,
  },
  {
    path: "/integrations/strava",
    testId: "integration-intro",
    why: "27 words — the shortest, and still split, because the convention is the convention.",
    leadFragment: "Pull runs, rides, and other activities",
    folds: true,
  },
  {
    path: "/integrations/oura",
    testId: "integration-intro",
    why: "37 words.",
    leadFragment: "Pull sleep, nightly heart-rate variability",
    folds: true,
  },
  {
    path: "/integrations/patient-portals",
    testId: "integration-intro",
    why: "44 words, and the one adopter that reaches the primitive through a client surface.",
    leadFragment: "Bring in visit summaries",
    folds: true,
  },
];

/**
 * The rendered line count of one element: its own box height over its own line
 * box. Both readings come from the same live element, so nothing here is a
 * declaration read off a stylesheet.
 */
async function renderedLines(
  page: Page,
  testId: string
): Promise<{ lines: number; height: number; lineHeight: number }> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) throw new Error(`no element with data-testid="${id}"`);
    const height = el.getBoundingClientRect().height;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    return { lines: Math.round(height / lineHeight), height, lineHeight };
  }, testId);
}

test("(1)(2) every intro leads in at most two rendered lines at 390px", async ({
  page,
}) => {
  test.slow();
  const measured: string[] = [];

  for (const route of ROUTES) {
    await page.goto(route.path);
    await expect(page.getByRole("main")).toBeVisible();

    // (2) THE NAMED SUBJECT — the lead paragraph, carrying ITS OWN text, before a
    // single measurement. A region that measures its container while the content
    // is still arriving is measuring a placeholder, and a placeholder fits every
    // ceiling (#3384).
    const lead = page.getByTestId(`${route.testId}-lead`);
    await expect(
      lead,
      `${route.path}: the lead never rendered, so this route's silence about wall-` +
        `of-text intros means nothing — ${route.why}`
    ).toBeVisible();
    await expect(lead).toContainText(route.leadFragment);

    const { lines, height, lineHeight } = await renderedLines(
      page,
      `${route.testId}-lead`
    );
    expect(
      lines,
      `${route.path}: the intro lead renders ${lines} lines (${height}px over a ` +
        `${lineHeight}px line box) at 390px — over the ${MAX_LEAD_LINES}-line ` +
        `budget. Move the specifics behind the fold (copy.md rule 10).`
    ).toBeLessThanOrEqual(MAX_LEAD_LINES);

    // The text is also under the source budget, asserted HERE too because the
    // rendered surface is where a hand-written lead (the Import card's, which is
    // JSX and never passes through the registry) would otherwise escape it.
    const text = ((await lead.textContent()) ?? "").trim();
    expect(text.length, `${route.path}: "${text}"`).toBeLessThanOrEqual(
      LEAD_MAX_CHARS + 10
    );

    if (route.folds) {
      // THE FOLD IS CLOSED, AND IT HOLDS SOMETHING. A disclosure a reader is
      // handed already open has not folded anything; one with nothing behind it is
      // a control that lies.
      const fold = page.getByTestId(`${route.testId}-fold`);
      await expect(fold).toHaveJSProperty("tagName", "DETAILS");
      await expect(fold).not.toHaveAttribute("open", "");
      await expect(page.getByTestId(`${route.testId}-detail`)).toBeHidden();

      // …and opening it reveals the detail. This is the half that makes "folded,
      // not deleted" a checked claim rather than a hope: #3490's fourth acceptance
      // criterion is that no factual claim was lost.
      await settledClick(
        page,
        page.getByTestId(`${route.testId}-fold-summary`)
      );
      const detail = page.getByTestId(`${route.testId}-detail`);
      await expect(detail).toBeVisible();
      expect(
        ((await detail.textContent()) ?? "").trim().length
      ).toBeGreaterThan(20);
    }

    measured.push(route.path);
  }

  // (1) THE CENSUS FLOOR — asserted last, and against a recorded number. A sweep
  // that quietly visited three routes passes every assertion above.
  expect(
    measured,
    "the census examined a different set of intros than it declares — a route that " +
      "stopped rendering its intro, or a new adopter nobody added here"
  ).toEqual(ROUTES.map((r) => r.path));
  expect(measured).toHaveLength(EXPECTED_INTROS);
});

test("(3) the census catches a synthetic wall planted in the live DOM", async ({
  page,
}) => {
  test.slow();
  await page.goto("/integrations/health-connect");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByTestId("integration-intro-lead")).toBeVisible();

  const clean = await renderedLines(page, "integration-intro-lead");
  expect(clean.lines).toBeLessThanOrEqual(MAX_LEAD_LINES);

  // The 72-word blurb this issue pair was filed about, put back into the exact
  // element it used to occupy. FORGED BY A SPEC on purpose — this text has not
  // shipped since #3490. If the measurement reads the wrong box, or a ceiling was
  // quietly widened, this is where it shows, and it is the only assertion in this
  // file that can fail because the probe stopped working rather than the app.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="integration-intro-lead"]');
    if (!el) throw new Error("no lead to forge into");
    el.textContent =
      "FORGED BY A SPEC on purpose (not shipped copy): Sync weight, body fat, " +
      "resting heart rate, steps, heart rate, and workouts from your Android " +
      "phone. An exporter app on the phone pushes Health Connect data to this " +
      "app on a schedule. It's also the supported way to bring in nutrition: " +
      "food trackers like MyFitnessPal, Cronometer, Lose It!, and Yazio write " +
      "your logged macros to Health Connect, so calories and protein/carbs/fat " +
      "flow through here and chart on Trends → Nutrition → Macros.";
  });

  const forged = await renderedLines(page, "integration-intro-lead");
  expect(
    forged.lines,
    "the census did not see a 72-word paragraph grow the intro — the measurement " +
      "is reading something other than the lead's rendered box"
  ).toBeGreaterThan(MAX_LEAD_LINES);
  // And it is the SIZE of the miss that #3490 reported: seven lines, not three.
  expect(forged.lines).toBeGreaterThanOrEqual(6);
});

test("a card tab strip scrolls without painting a scrollbar (#3488 fix 3)", async ({
  page,
}) => {
  test.slow();
  await page.goto("/data?section=import");
  const strip = page.getByTestId("tab-strip");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("Paste CSV");

  // THE OVERFLOW IS FORCED, NOT HOPED FOR. Whether two tabs happen to overflow a
  // 390px card depends on font metrics, and a scrollbar assertion on a strip that
  // does not scroll is an absence assertion with nothing to be absent — it would
  // pass on a strip that never suppressed anything. So the probe widens the
  // content itself and then measures.
  //
  // The reading is `offsetHeight - clientHeight`: the gutter a classic horizontal
  // scrollbar takes out of the box. It is a RENDERED quantity — a
  // `scrollbar-width: none` in a stylesheet is not evidence the rule reached this
  // element (#3529).
  const measure = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="tab-strip"]');
    if (!el) throw new Error("no tab strip");
    const spacer = document.createElement("span");
    spacer.style.cssText = "display:inline-block;width:2000px;flex:none";
    // FORGED BY A SPEC on purpose: a spacer that guarantees the row overflows.
    el.appendChild(spacer);

    // The CONTROL: the same box, same content, with the suppression removed. If
    // this platform draws overlay scrollbars, the control reads 0 too and the
    // whole check is meaningless — which is why it is measured rather than assumed.
    const control = el.cloneNode(true) as HTMLElement;
    control.style.scrollbarWidth = "auto";
    control.removeAttribute("data-testid");
    el.parentElement?.appendChild(control);

    const read = (n: HTMLElement) => ({
      gutter: n.offsetHeight - n.clientHeight,
      scrolls: n.scrollWidth > n.clientWidth,
    });
    return { strip: read(el), control: read(control) };
  });

  expect(
    measure.strip.scrolls,
    "the forced overflow did not take — the strip is not a horizontal scroller"
  ).toBe(true);
  expect(
    measure.control.gutter,
    "the CONTROL box painted no scrollbar either, so this measurement cannot tell " +
      "a suppressed scrollbar from an absent one (overlay scrollbars?) — the " +
      "assertion below would pass for the wrong reason"
  ).toBeGreaterThan(0);
  expect(
    measure.strip.gutter,
    "the tab strip paints a scrollbar sliver — design-system.md §3, 'tab strips " +
      "scroll without painting scrollbars'"
  ).toBe(0);
});

test("the empty upload card shows two doors and nothing below them (#3488 fix 2)", async ({
  page,
}) => {
  test.slow();
  await page.goto("/data?section=import");

  // The ruled two-door mobile pair (#1993), with the picker wearing the label the
  // desktop dropzone already used. "Upload" now names ONE control on this card.
  const actions = page.getByTestId("medical-upload-actions");
  await expect(actions).toBeVisible();
  await expect(page.getByTestId("medical-upload-choose-mobile")).toHaveText(
    "Choose files"
  );
  await expect(page.getByTestId("medical-upload-camera")).toBeVisible();

  // Nothing below them: no permanently disabled twin, and no promise to read
  // something in the background before there is a something.
  await expect(page.getByTestId("medical-upload-submit")).toHaveCount(0);
  await expect(page.getByText("in the background")).toHaveCount(0);

  // Choosing a file reveals the file list, the submit, and the sentence — the
  // explainer arrives when it has a subject.
  await page.getByTestId("medical-upload-input").setInputFiles({
    name: "lead-fold-census-1.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "metric,value,unit,date\nGlucose,94,mg/dL,2026-01-04\n"
    ),
  });
  await expect(page.getByTestId("medical-upload-selected")).toContainText(
    "lead-fold-census-1.csv"
  );
  const submit = page.getByTestId("medical-upload-submit");
  await expect(submit).toBeVisible();
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText("Upload");
  await expect(page.getByText("in the background")).toBeVisible();
});
