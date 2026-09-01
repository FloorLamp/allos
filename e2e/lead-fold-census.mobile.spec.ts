import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { LEAD_MAX_CHARS } from "@/lib/lead-fold-census";
import { stageMediaFiles } from "./helpers";

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

test("(1)(2)(3) every intro leads in two lines and the probe catches its known wall", async ({
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
      // A plain click, not `settledClick`: a native <details> toggles in the
      // browser and posts nothing, so a helper that waits for an action POST would
      // wait for a request this design deliberately does not make.
      await page.getByTestId(`${route.testId}-fold-summary`).click();
      const detail = page.getByTestId(`${route.testId}-detail`);
      await expect(detail).toBeVisible();
      expect(
        ((await detail.textContent()) ?? "").trim().length
      ).toBeGreaterThan(20);
    }

    if (route.path === "/integrations/health-connect") {
      // (3) PROOF THE CENSUS CAN FAIL. Put back the exact long-form shape that
      // #3490 removed, in the live element the route census already measured.
      // The next navigation discards the forged DOM, so no cleanup or second
      // browser test is needed.
      await lead.evaluate((el) => {
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
        "the census did not see the known 72-word wall grow the lead"
      ).toBeGreaterThanOrEqual(6);
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

/**
 * The tab strips this census must find. A floor AND a ceiling per route, for the
 * same reason every other count here has one: "no strip paints a scrollbar" is
 * true of a page with no strips.
 */
const STRIP_ROUTES: { path: string; strips: number; why: string }[] = [
  {
    path: "/data?section=import",
    strips: 2,
    why: "#3488's two Data strips, including the upload method buttons.",
  },
  {
    path: "/records",
    strips: 1,
    why: "The equal-width tab treatment.",
  },
];

/** Every tab strip on the page. */
const STRIP_SELECTOR = '[data-testid="tab-strip"], [role="tablist"]';

test("no tab strip paints a scrollbar, and every one still scrolls (#3488 fix 3)", async ({
  page,
}) => {
  test.slow();

  // Headless Chromium's overlay scrollbars consume no geometry, so a gutter-only
  // check passes unsuppressed rows. Read the live computed suppression against an
  // unsuppressed control; the paired values discriminate instead of comparing a
  // browser constant (#3488/#3529).
  const found: string[] = [];
  for (const route of STRIP_ROUTES) {
    await page.goto(route.path);
    await expect(page.getByRole("main")).toBeVisible();
    const readings = await page.evaluate((selector) => {
      // Visible strips only: tab-first pages have responsive-exclusive copies,
      // and a display:none box cannot overflow or paint a scrollbar. The hidden
      // count still prevents a disappearing strip from passing silently.
      const all = [...document.querySelectorAll<HTMLElement>(selector)];
      const els = all.filter((n) => n.clientWidth > 0);

      // Build the unsuppressed control from scratch; a clone would carry the rule
      // being tested and prove nothing.
      const control = document.createElement("div");
      control.style.cssText = "overflow-x:auto;width:200px";
      const wide = document.createElement("span");
      wide.style.cssText = "display:inline-block;width:2000px;height:20px";
      control.appendChild(wide);
      document.body.appendChild(control);

      const read = (n: HTMLElement) => {
        const cs = getComputedStyle(n);
        const borders =
          parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
        return {
          scrollbarWidth: cs.scrollbarWidth,
          webkit: getComputedStyle(n, "::-webkit-scrollbar").display,
          gutter: n.offsetHeight - n.clientHeight - borders,
          overflows: n.scrollWidth > n.clientWidth,
          canScroll: cs.overflowX === "auto" || cs.overflowX === "scroll",
        };
      };

      // Clamp instead of adding content, which could land in a new grid row. This
      // makes every treatment genuinely overflow before its scroll is asserted.
      const strips = els.map((el) => {
        // FORGED BY A SPEC on purpose: a clamp that guarantees the row overflows.
        el.style.width = "40px";
        return read(el);
      });
      return {
        strips,
        hidden: all.length - els.length,
        control: read(control),
      };
    }, STRIP_SELECTOR);

    expect(
      readings.strips.length,
      `${route.path}: expected ${route.strips} visible tab strip(s) ` +
        `(${readings.hidden} hidden) — ${route.why}`
    ).toBe(route.strips);

    // The control keeps the computed reading discriminating.
    expect(
      readings.control.scrollbarWidth,
      "an unsuppressed scroller no longer reports scrollbar-width:auto, so this " +
        "reading cannot tell a suppressed strip from an unsuppressed one"
    ).toBe("auto");

    for (const [i, r] of readings.strips.entries()) {
      const at = `${route.path} strip ${i + 1}`;
      expect(r.overflows, `${at}: the forced overflow did not take`).toBe(true);
      expect(
        r.canScroll,
        `${at}: suppressing the scrollbar must not stop the row scrolling`
      ).toBe(true);
      expect(
        r.scrollbarWidth,
        `${at}: paints a scrollbar — design-system.md §3, "tab strips scroll ` +
          `without painting scrollbars"`
      ).toBe("none");
      expect(
        r.webkit,
        `${at}: the ::-webkit-scrollbar half of the suppression did not reach it`
      ).toBe("none");
      // The geometric half, recorded: 0 on both the strip and the control today,
      // and a real signal the day this browser paints classic scrollbars again.
      expect(r.gutter).toBeLessThanOrEqual(readings.control.gutter);
    }
    found.push(`${route.path}:${readings.strips.length}`);
  }

  expect(found).toEqual(STRIP_ROUTES.map((r) => `${r.path}:${r.strips}`));
});

test("the empty upload card shows two doors and nothing below them (#3488 fix 2)", async ({
  page,
}) => {
  test.slow();
  await page.goto("/data?section=import");

  // ONE door (#3286), wearing the label the desktop dropzone already used —
  // "Upload" still names exactly one control on this card, the submit. The two
  // ways in (#1993) now sit together inside the dialog it opens.
  const door = page.getByTestId("medical-upload-choose");
  // useInnerText, because the door also carries a " or drop them here" span that
  // is hidden by a class below `sm` — naming a drag gesture on a phone would be
  // instructions for a device the reader is not holding. textContent reads hidden
  // text happily, so the default matcher would be asserting on something nobody
  // at this viewport can see.
  await expect(door).toHaveText("Choose files", { useInnerText: true });

  // Assert on the row: inactive panels stay mounted, so a page-wide text query
  // would also read the hidden Paste CSV panel.
  await expect(page.getByTestId("medical-upload-submit-row")).toHaveCount(0);
  await expect(page.getByTestId("medical-upload-submit")).toHaveCount(0);

  // Choosing a file reveals the file list, the submit, and the sentence — the
  // explainer arrives when it has a subject.
  await stageMediaFiles(page, "medical-upload-input", {
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
  await expect(page.getByTestId("medical-upload-submit-row")).toContainText(
    "in the background"
  );
});
