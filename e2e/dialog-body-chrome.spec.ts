import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";
import { hydratedClick, settledBoxes } from "./helpers";

// A DIALOG BODY RENDERS CONTENT, NEVER CHROME (issue #3361).
//
// #2774 converged the HOST: one responsive dialog primitive, one scroll owner,
// one declared size. It left the BODIES alone, and three of them were still
// wearing standalone-page chrome inside it — a bordered, padded, shadowed card
// floating inside a bordered, padded, shadowed panel, printing the panel's own
// title a second time. The rule and its escape-hatch pattern are written down
// beside the host decision table in docs/internals/overlays.md; this spec is
// the executable half.
//
// EVERY ASSERTION HERE IS A COMPUTED STYLE OR A MEASURED EDGE, never a class
// name. "No card" is a fact about what the browser painted — a class assertion
// would go green the day someone renames the utility and keeps the border.
//
// Fixture hygiene (#868): read-only throughout. Every test opens a dialog,
// measures it and leaves; nothing is submitted, so this spec writes NOTHING and
// is safe at any parallelism and under --repeat-each.

/**
 * The chrome a standalone card draws, read off the rendered element.
 *
 * `.card` is a 1.5px border + `p-4` + a shadow (app/globals.css); the two
 * screening pickers drew `rounded-xl border … p-4`. A body that owns none of it
 * reads zero on every one of these.
 */
async function cardChrome(el: Locator) {
  return el.evaluate((node) => {
    const cs = getComputedStyle(node);
    return {
      borderTopWidth: cs.borderTopWidth,
      borderLeftWidth: cs.borderLeftWidth,
      paddingTop: cs.paddingTop,
      paddingLeft: cs.paddingLeft,
      boxShadow: cs.boxShadow,
    };
  });
}

const NO_CARD_CHROME = {
  borderTopWidth: "0px",
  borderLeftWidth: "0px",
  paddingTop: "0px",
  paddingLeft: "0px",
  boxShadow: "none",
};

test.describe("a dialog body renders content, never chrome (#3361)", () => {
  test.describe("the quick-entry measurements sheet, on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("prints its title once, over a form that draws no card of its own", async ({
      page,
    }) => {
      // The same overlay the quick-log sheet's "Log measurements" row opens,
      // reached by url rather than by tap (lib/quick-log.ts / #1424).
      await page.goto("/?quick=log-measurements");
      const sheet = page.getByTestId("quick-entry-sheet");
      await expect(sheet).toBeVisible();
      await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
        "data-form",
        "measurements"
      );

      // ONE heading, and it is the HOST's. This is the owner's screenshot as an
      // assertion: the mount used to forget `presentation="modal"`, so the form
      // fell back to its card default and printed a second "Log measurements"
      // inside the panel — which the sheet then hid its own title to make room
      // for. A role query sees an `sr-only` heading too, so the count is the
      // honest reading of "how many times does this dialog say its name".
      const title = sheet.getByRole("heading", { name: "Log measurements" });
      await expect(title).toHaveCount(1);
      await expect(title).toBeVisible();

      // The description line survives — "modal" drops the card and the heading,
      // never the sentence that says what the form is for.
      await expect(
        sheet.getByText("body and vitals readings", { exact: false })
      ).toBeVisible();

      const form = sheet.getByTestId("measurements-quick-add");
      await expect(form).toBeVisible();
      expect(await cardChrome(form)).toEqual(NO_CARD_CHROME);
    });
  });

  test("the mental-health screening picker has no border of its own", async ({
    page,
  }) => {
    await page.goto("/records/specialty/mental-health");
    await hydratedClick(
      page,
      page.getByTestId("add-mental-health-screening-panel-toggle")
    );
    const form = page.getByTestId("instruments-form");
    await expect(form).toBeVisible();
    expect(await cardChrome(form)).toEqual(NO_CARD_CHROME);
  });

  test("the substance screening picker has no border of its own", async ({
    page,
  }) => {
    await page.goto("/records/specialty/substance-use");
    await hydratedClick(
      page,
      page.getByTestId("add-substance-screening-panel-toggle")
    );
    const form = page.getByTestId("substance-instruments-form");
    await expect(form).toBeVisible();
    expect(await cardChrome(form)).toEqual(NO_CARD_CHROME);
  });

  test.describe("a full-bleed body between `sm` and `md`", () => {
    // THE BAND THE BUG LIVED IN, and the reason this describe sets its own
    // viewport: neither project width is inside it. The dialog panel pads `px-4`
    // and steps to `px-6` at `md` (768px), while ProtocolForm's bleed used to
    // step at `sm` (640px) — so from 640px to 767px the form pulled 1.5rem back
    // against 1rem of padding and its footer hung half a rem past the panel on
    // each side. 700px is inside that band with room on either side.
    test.use({ viewport: { width: 700, height: 900 } });

    test("the protocol form's footer sits flush with the panel edge, not past it", async ({
      page,
    }) => {
      test.slow(); // next compiles this route on first hit

      await page.goto("/longevity#protocols");
      await hydratedClick(
        page,
        page.getByRole("main").getByTestId("new-protocol-toggle")
      );

      const panel = page.locator("[data-sheet-panel]");
      const footer = page.getByTestId("protocol-form-actions");
      await expect(panel).toBeVisible();
      await expect(footer).toBeVisible();

      // ONE settled layout for both reads — a bleed assertion built from two
      // independent boundingBox calls is exactly the shape settledBoxes exists
      // to retire.
      const [panelBox, footerBox] = await settledBoxes([panel, footer]);

      // A bleed that matches the host's padding EXACTLY puts the body's edge on
      // the panel's edge. `1` is the sub-pixel rounding of two device-pixel
      // reads, not a tolerance for being wrong: the defect this pins was 8px per
      // side, so a window that admits it would have to be eight times wider.
      const FLUSH_EPSILON = 1;
      expect(
        Math.abs(footerBox.x - panelBox.x),
        "the footer's left edge must sit on the panel's, not past it"
      ).toBeLessThanOrEqual(FLUSH_EPSILON);
      expect(
        Math.abs(footerBox.x + footerBox.width - (panelBox.x + panelBox.width)),
        "the footer's right edge must sit on the panel's, not past it"
      ).toBeLessThanOrEqual(FLUSH_EPSILON);
    });
  });
});
