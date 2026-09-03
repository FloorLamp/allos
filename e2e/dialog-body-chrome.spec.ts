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

  test.describe("the title gap has ONE owner (#3361)", () => {
    // Every dialog body gets its gap under the title from the HOST's content
    // region (`mt-3` on `[data-sheet-content]`, components/BottomSheet.tsx).
    // Call sites used to stack their own `mt-4` on top of it — 28px under a
    // dialog title, decided by nobody. #3388 fixed the two hosts it was already
    // touching (AddEntryPanel's modal branch, covering all seventeen
    // `presentation="modal"` mounts, and ProtocolForm); the remaining eighteen
    // wrappers were swept here. Between the two PRs the app was INCONSISTENT
    // between dialogs, which reads worse than uniformly wrong, so these two
    // tests pin both halves of the rule.
    //
    // MARGIN IS READ OFF THE RENDERED ELEMENT, never a class name — same reason
    // as the rest of this file. A `toHaveClass` check goes green the day the
    // margin arrives from somewhere else.

    /** The computed top margin of an element, in CSS pixels. */
    async function marginTopPx(el: Locator): Promise<number> {
      return el.evaluate(
        (node) => parseFloat(getComputedStyle(node).marginTop) || 0
      );
    }

    test("a swept dialog body carries no top margin of its own", async ({
      page,
    }) => {
      test.slow(); // next compiles /trends on first hit

      await page.goto("/trends");
      await hydratedClick(page, page.getByTestId("log-measurements-toggle"));

      // WAIT FOR THE CONTENT, NOT THE CONTAINER (#3384). The body region mounts
      // before the measurements form arrives inside it, and an empty box has a
      // perfectly innocent margin — a read taken against the placeholder would
      // pass without ever having looked at the thing this test names.
      const form = page.getByTestId("measurements-quick-add");
      await expect(form).toBeVisible();
      await expect(
        form.locator("#measurements-group-body-fields")
      ).toBeVisible();

      const body = page.getByTestId("log-measurements-modal-body");
      const content = page.locator("[data-sheet-content]");

      expect(
        await marginTopPx(body),
        "the dialog body must not add its own gap under the title"
      ).toBe(0);

      // ...and the owner is still there. Asserting only the zero would go green
      // on a tree where the gap had been deleted outright rather than given one
      // owner, which is a different bug with the same diff signature.
      expect(
        await marginTopPx(content),
        "the host's content region owns the gap under the title"
      ).toBeGreaterThan(0);
    });

    test("a description-to-form gap is not a title gap, and survives", async ({
      page,
    }) => {
      // THE GUARD'S SILENCE, and the reason the sweep was not a `sed`. In six
      // dialogs the first child is a `<p className="mt-2">` DESCRIPTION and the
      // `mt-4` sits on the form BELOW it. That margin spaces the form from the
      // sentence above, not from the title, and deleting it would collapse the
      // two together. This is one of the six (MedicationListActions); if a
      // future sweep takes them too, this goes red instead of shipping quietly.
      //
      // Read-only like the rest of this file: the dialog is opened and measured,
      // never submitted, so no share link is created.
      await page.goto("/medications");
      await hydratedClick(page, page.getByTestId("medication-share-open"));

      const content = page.locator("[data-sheet-content]");
      const form = content.locator("form");
      await expect(form).toBeVisible();
      // The specific child this test is about, before anything is measured.
      await expect(page.getByTestId("medication-share-create")).toBeVisible();

      // `> p:first-child` — being the FIRST child is the whole discriminator
      // between the swept set and this one, so the selector says so. An
      // index-into-a-list locator would keep matching if the description ever
      // stopped leading, which is exactly the case this test exists to catch,
      // and lib/__tests__/e2e-hygiene.test.ts is right to ban that shape.
      // (That guard scans lines, comments included, so this note names the
      // banned form in prose rather than spelling it.)
      const description = content.locator("> p:first-child");
      await expect(description).toHaveCount(1);
      await expect(description).toContainText("read-only link");

      expect(
        await marginTopPx(form),
        "the form must stay spaced from the description above it"
      ).toBeGreaterThan(0);
    });
  });

  test.describe("a full-bleed body between `sm` and `md`", () => {
    // THE BAND THE BUG LIVED IN, and the reason this describe sets its own
    // viewport: neither project width is inside it. The dialog panel pads `px-4`
    // and steps to `px-6` at `md` (768px), while ProtocolForm's bleed used to
    // step at `sm` (640px) — so from 640px to 767px the form pulled 1.5rem back
    // against 1rem of padding and its footer hung half a rem past the panel on
    // each side. 700px is inside that band with room on either side.
    test.use({ viewport: { width: 700, height: 900 } });

    // MEASURED AGAINST THE EDGE THE FOOTER ACTUALLY PAINTS TO (#4534), which is
    // the panel's CONTENT edge below `md`, not its border edge. This test used to
    // compare the footer's box with the panel's box and pass on a rule that never
    // reached either edge: the sheet's content region declares `overflow-x-hidden`
    // below `md` (#3360), so a `-mx-4` bleed moved the BOX and nothing else.
    // Measured at 700px on the tree that carried it — footer box [14, 686],
    // panel box [14, 686], content box [30, 670], painted [30, 670]. Box-flush,
    // 16px short per side on screen, and green. That is the #4534 defect class
    // sitting inside the guard written for it, so the comparison moved to the
    // content box and the form stopped claiming a bleed it could not spend.
    //
    // BOTH HALVES STAY. #3361's bug was a footer hanging PAST the panel, so the
    // containment assertion is kept beside the flush one — flush alone is
    // satisfied by a footer that overhangs equally on both sides.
    test("the protocol form's footer sits flush with the edge it paints to, and never past the panel", async ({
      page,
    }) => {
      test.slow(); // next compiles this route on first hit

      await page.goto("/longevity#protocols");
      await hydratedClick(
        page,
        page.getByRole("main").getByTestId("new-protocol-toggle")
      );

      const panel = page.locator("[data-sheet-panel]");
      const content = page.locator("[data-sheet-content]");
      const footer = page.getByTestId("protocol-form-actions");
      await expect(panel).toBeVisible();
      await expect(footer).toBeVisible();

      // ONE settled layout for all three reads — a bleed assertion built from
      // independent boundingBox calls is exactly the shape settledBoxes exists
      // to retire.
      const [panelBox, contentBox, footerBox] = await settledBoxes([
        panel,
        content,
        footer,
      ]);

      // A bleed that matches the host's padding EXACTLY puts the body's edge on
      // the edge it can paint to. `1` is the sub-pixel rounding of two
      // device-pixel reads, not a tolerance for being wrong: the defect this pins
      // was 8px per side, so a window that admits it would have to be eight times
      // wider.
      const FLUSH_EPSILON = 1;
      expect(
        Math.abs(footerBox.x - contentBox.x),
        "the footer's left edge must sit on the edge it paints to"
      ).toBeLessThanOrEqual(FLUSH_EPSILON);
      expect(
        Math.abs(
          footerBox.x + footerBox.width - (contentBox.x + contentBox.width)
        ),
        "the footer's right edge must sit on the edge it paints to"
      ).toBeLessThanOrEqual(FLUSH_EPSILON);

      // AND NEVER PAST THE PANEL, which is the half #3361 was filed for.
      expect(
        {
          left: footerBox.x >= panelBox.x - FLUSH_EPSILON,
          right:
            footerBox.x + footerBox.width <=
            panelBox.x + panelBox.width + FLUSH_EPSILON,
        },
        "the footer hung past the panel"
      ).toEqual({ left: true, right: true });
    });
  });
});
