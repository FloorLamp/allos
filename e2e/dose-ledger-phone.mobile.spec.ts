import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { expectNoClippedContent } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_DOSE_LEDGER_PHONE,
  E2E_MEMBER_PASSWORD,
  DOSE_LEDGER_PHONE_IMPORTED_MED,
  DOSE_LEDGER_PHONE_ACTIVE_MED,
} from "./fixture-logins";
import { machineDateHits } from "@/lib/machine-date-census";

// THE DOSE LEDGER AT PHONE WIDTH (#3478).
//
// A `w-auto` <select> sizes to its WIDEST OPTION, and this control's options are
// every item the profile has ever owned — portal-imported names nobody chose, plus
// an " (inactive)" suffix. The owner's 2026-08-21 phone review found the control
// running off the right edge of a 390px screen with its chevron cut off: measured
// here before the fix, 447px wide with its right edge at 498px, and the app shell's
// `overflow-x` swallowing the last 108px in silence — no ellipsis, no scroller.
//
// ── WHY THIS IS GEOMETRIC AND NOT A CLASS ASSERTION ─────────────────────────────
//
// Every class in that tree is plausibly the intended one. `input` is the field
// primitive, `w-auto` is a deliberate override of its `w-full`, and the label is an
// ordinary flex row. What is wrong is not a class — it is what the WIDEST OPTION
// does to the box. So this reads `getBoundingClientRect()` on the rendered control,
// exactly as the geometry census does (scripts/ux-geometry-census.mjs), and a fix
// that satisfied the assertion while leaving the box past the edge is not available.
//
// ── IT PROVES THE FIXTURE CAN EXPRESS THE DEFECT BEFORE IT BELIEVES A VERDICT ────
//
// "The control fits" is trivially true of a control with nothing long in it, and
// the shipped demo seed IS that control: its longest medication label is
// "Atorvastatin (inactive)", 23 characters, which fits a phone at any width. A
// geometry census run against that corpus reports zero clipped elements on this
// route — correctly, and uselessly. So the premise is measured rather than assumed:
// the widest option's NATURAL width (the width the select would take with the flex
// content floor still in place) must still exceed the viewport. If the fixture name
// is ever shortened, that check fails and names the fixture, instead of this spec
// passing over a page that could not have been wrong.
//
// Fixture (#868 hygiene): a DEDICATED profile (e2e/seed/intake.ts,
// seedDoseLedgerPhone). A 55-character medication name on a shared profile would
// widen controls under every neighbouring spec. Read-only — nothing is written.

interface FilterGeometry {
  /** The viewport's content width, the edge every claim here is against. */
  viewportWidth: number;
  /** The select's own box, in document coordinates. */
  right: number;
  width: number;
  /**
   * What the select would be if nothing released the flex content floor — i.e. the
   * width the widest option asks for. This is the quantity the defect is made of.
   */
  naturalWidth: number;
  /** The rendered height of the filter row, so a fix that wraps instead of fitting shows up. */
  rowHeight: number;
  /** The page's own horizontal overflow inside the clipping shell. */
  mainScrollWidth: number;
  mainClientWidth: number;
}

async function filterGeometry(page: Page): Promise<FilterGeometry> {
  return page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>(
      '[data-testid="dose-ledger-item-filter"]'
    );
    if (!select) throw new Error("the ledger's Item filter did not render");
    const label = select.closest("label");
    if (!label) throw new Error("the Item filter has no label wrapper");
    const row = label.parentElement;
    if (!row) throw new Error("the Item filter's row is missing");
    const main = document.querySelector("main");
    if (!main) throw new Error("no <main> — the app shell did not render");

    // The NATURAL width, measured rather than derived from a class string: a clone
    // laid out off-canvas with the caps removed and the flex content floor back.
    // Hidden with `visibility` and not `display:none`, because a display-none clone
    // has no box at all and would read 0 — an answer that flatters the assertion.
    const probe = select.cloneNode(true) as HTMLSelectElement;
    probe.removeAttribute("data-testid");
    probe.style.position = "absolute";
    probe.style.left = "-10000px";
    probe.style.top = "0";
    probe.style.visibility = "hidden";
    probe.style.minWidth = "auto";
    probe.style.maxWidth = "none";
    probe.style.width = "auto";
    probe.style.textOverflow = "clip";
    document.body.appendChild(probe);
    const naturalWidth = probe.getBoundingClientRect().width;
    probe.remove();

    const r = select.getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      right: r.left + window.scrollX + r.width,
      width: r.width,
      naturalWidth,
      rowHeight: row.getBoundingClientRect().height,
      mainScrollWidth: main.scrollWidth,
      mainClientWidth: main.clientWidth,
    };
  });
}

async function openLedger(page: Page): Promise<void> {
  await page.goto("/medications/dose-history");
  // WAIT FOR THE CONTENT THIS MEASURES, not for the container. The options are what
  // give the control its width, and a select that has rendered with only its
  // "All items" placeholder fits any viewport — the state an overflow assertion is
  // flattered by.
  await expect(
    page
      .getByTestId("dose-ledger-item-filter")
      .locator("option", { hasText: DOSE_LEDGER_PHONE_IMPORTED_MED })
  ).toHaveCount(1);
}

test.describe("the dose ledger at phone width (#3478)", () => {
  test("the Item select is laid out inside the viewport, however long its widest imported name", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DOSE_LEDGER_PHONE,
      password: E2E_MEMBER_PASSWORD,
    });
    await openLedger(page);
    const g = await filterGeometry(page);

    // THE PREMISE, ASSERTED BEFORE THE VERDICT. Without a name whose natural width
    // exceeds the phone, everything below is true of a page that cannot be wrong.
    expect(
      g.naturalWidth,
      `the fixture's widest option asks for only ${Math.round(g.naturalWidth)}px in a ` +
        `${g.viewportWidth}px viewport, so this spec is measuring a control that could ` +
        `not overflow. Lengthen DOSE_LEDGER_PHONE_IMPORTED_MED in e2e/logins/intake.ts.`
    ).toBeGreaterThan(g.viewportWidth);

    // THE VERDICT. The rendered box, against the edge the reader has.
    expect(
      Math.round(g.right),
      `the Item select's right edge is ${Math.round(g.right)} in a ${g.viewportWidth}px ` +
        `viewport (width ${Math.round(g.width)}, natural ${Math.round(g.naturalWidth)})`
    ).toBeLessThanOrEqual(g.viewportWidth);

    // The page does not compensate by overflowing sideways inside the clipping shell
    // — the failure mode `document.scrollWidth` can never see (#1063).
    expect(g.mainScrollWidth).toBeLessThanOrEqual(g.mainClientWidth + 1);

    // AND NOT BY WRAPPING TO A TALLER ROW. Stopping the overflow by unrolling the
    // control onto another line is a DIFFERENT trade and has to be visible as one.
    //
    // WHAT THIS BOUNDS: the rendered height, in CSS pixels, of the wrapping filter
    // row that holds the kind pills and the Item control at 390px. MEASURED
    // 2026-08-23 on this route at both commits — 84px on origin/main and 84px with
    // the fix, two wrapped lines either way. A third line costs one more 38px
    // control plus the row's 12px `gap-3`, so the three-line state reads ~134px.
    // 100px sits above every two-line rendering (16px of headroom for a font or
    // border change) and comfortably below the three-line one this exists to catch.
    const FILTER_ROW_TWO_LINE_CEILING_PX = 100;
    expect(
      g.rowHeight,
      `the filter row is ${Math.round(g.rowHeight)}px tall — the overflow may have ` +
        `been traded for another wrapped line`
    ).toBeLessThanOrEqual(FILTER_ROW_TWO_LINE_CEILING_PX);

    // The class guard the census would apply to the whole page, applied here too:
    // nothing else on this route sits past an edge with no way to it.
    await expectNoClippedContent(page);
    await page.context().close();
  });

  test("an empty ledger says it is empty first, names the kind it is filtered to, and prints no storage-format date", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DOSE_LEDGER_PHONE,
      password: E2E_MEMBER_PASSWORD,
    });
    await openLedger(page);

    const emptyState = page.getByTestId("dose-ledger-empty");
    await expect(emptyState).toBeVisible();

    // THE STATE LEADS. Element order inside the ledger, read from the DOM rather
    // than from a screenshot: the empty sentence comes before the launcher that used
    // to open the page.
    const order = await page.getByTestId("dose-ledger").evaluate((root) => {
      const nodes = [...root.querySelectorAll("[data-testid]")];
      return nodes.map((n) => n.getAttribute("data-testid") ?? "");
    });
    expect(order.indexOf("dose-ledger-empty")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("dose-ledger-add")).toBeGreaterThan(
      order.indexOf("dose-ledger-empty")
    );

    // ONE SENTENCE, NAMING THE FILTERED KIND. This route opens pre-filtered to
    // medications, so it may not send the reader to Supplements.
    await expect(emptyState).toContainText("medication doses");
    await expect(emptyState).toContainText("confirm a dose on Medications.");
    await expect(emptyState).not.toContainText("Supplements");
    // The window note is folded IN rather than stacked above: nothing else on the
    // page is still saying "Showing confirmed doses …".
    await expect(page.getByTestId("dose-ledger")).not.toContainText(
      "Showing confirmed doses"
    );

    // AND ITS DATES CROSS THE DISPLAY BOUNDARY, asked with the census's OWN rule
    // rather than a second spelling of it (lib/machine-date-census.ts). The
    // POPULATED half of this route is censused by e2e/machine-date-census.spec.ts;
    // this sentence only exists in the empty state, which that census's shared-seed
    // profile never renders.
    const text = (await emptyState.textContent()) ?? "";
    expect(machineDateHits(text), text).toEqual([]);

    await page.context().close();
  });
  // ── THE SIBLING CONTROL, #3631's "cheap once this lands" ────────────────────────
  //
  // `IntakeRulesEditor`'s "Other item" select (components/intake/IntakeRulesEditor.tsx)
  // is the SAME SHAPE as the ledger filter above — a `w-auto` select whose options are
  // item names nobody chose — and it was fixed alongside #3478 with the same one class.
  // It was pinned BY INSPECTION ONLY, because reaching it means driving to a
  // medication's edit form and adding a keep-apart rule with two items present.
  //
  // WHAT MADE IT CHEAP, said honestly because #3631 asks: NOT the census corpus this
  // change adds — the census photographs resting states and cannot drive a form, so no
  // seed value reaches this control. It was #3478's OWN fixture: `seedDoseLedgerPhone`
  // already gives this profile exactly two items, the 55-character imported one and one
  // ordinary active one, so the active med's rule editor offers a single "other" whose
  // name is the long one. Plus `?action=edit`, which opens the form without driving an
  // overflow menu. Two navigations and two clicks, and no write — the rule row is
  // client state and is never saved, so this stays as read-only and repeat-safe as its
  // neighbours above.
  test("the rules editor's Other item select is laid out inside the viewport too (#3631)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DOSE_LEDGER_PHONE,
      password: E2E_MEMBER_PASSWORD,
    });

    // The active medication's own page, opened straight into the editor.
    await page.goto("/medications");
    const href = await page
      .locator(`a[href^="/medications/"]`, {
        hasText: DOSE_LEDGER_PHONE_ACTIVE_MED,
      })
      .first() // first-ok: the dedicated fixture profile owns exactly two medications, and this locator is already filtered to the active one's name
      .getAttribute("href");
    expect(
      href,
      "the active medication's card did not render a link"
    ).toBeTruthy();
    await page.goto(`${href}?action=edit`);

    // Add a keep-apart rule: the sentence whose blank is the Other item select.
    await page.getByTestId("intake-add-rule").click();
    await page.getByTestId("intake-rule-add-keep-apart").click();

    const select = page.getByLabel("Other item");
    // WAIT FOR THE CONTENT THIS MEASURES. A select rendered with no options fits any
    // viewport, and empty is the state that flatters an overflow assertion (#3384).
    await expect(
      select.locator("option", { hasText: DOSE_LEDGER_PHONE_IMPORTED_MED })
    ).toHaveCount(1);

    const g = await select.evaluate((el) => {
      const s = el as HTMLSelectElement;
      // The natural width — what the widest option asks for with the flex content
      // floor still in place — measured off-canvas, exactly as the ledger filter above.
      const probe = s.cloneNode(true) as HTMLSelectElement;
      probe.style.position = "absolute";
      probe.style.left = "-10000px";
      probe.style.top = "0";
      probe.style.visibility = "hidden";
      probe.style.minWidth = "auto";
      probe.style.maxWidth = "none";
      probe.style.width = "auto";
      probe.style.textOverflow = "clip";
      document.body.appendChild(probe);
      const naturalWidth = probe.getBoundingClientRect().width;
      probe.remove();
      const r = s.getBoundingClientRect();
      const main = document.querySelector("main");
      // THE ANCESTOR CHAIN, kept rather than deleted once it had done its job. A
      // failure here reads "the select is 119px too wide" and says nothing about
      // WHICH box refused to shrink — and the answer was two levels above the select
      // both times it was measured. A reviewer will reach for this as scaffolding;
      // it is what makes the next red self-describing (#2774).
      const chain: string[] = [];
      for (
        let p: HTMLElement | null = s;
        p && p !== document.body;
        p = p.parentElement
      ) {
        const cs = getComputedStyle(p);
        chain.push(
          `${p.tagName.toLowerCase()}${p.dataset.testid ? `[${p.dataset.testid}]` : ""} ` +
            `w=${Math.round(p.getBoundingClientRect().width)} ` +
            `min-w=${cs.minWidth} display=${cs.display}`
        );
      }
      return {
        viewportWidth: document.documentElement.clientWidth,
        right: r.left + window.scrollX + r.width,
        width: r.width,
        naturalWidth,
        chain,
        mainScrollWidth: main?.scrollWidth ?? 0,
        mainClientWidth: main?.clientWidth ?? 0,
      };
    });

    // THE PREMISE BEFORE THE VERDICT, same as above: without an option whose natural
    // width exceeds the phone, everything below is true of a control that could not
    // have been wrong.
    expect(
      g.naturalWidth,
      `the Other item select's widest option asks for only ${Math.round(g.naturalWidth)}px ` +
        `in a ${g.viewportWidth}px viewport, so this spec is measuring a control that ` +
        `could not overflow. Lengthen DOSE_LEDGER_PHONE_IMPORTED_MED in e2e/logins/intake.ts.`
    ).toBeGreaterThan(g.viewportWidth);

    expect(
      Math.round(g.right),
      `the Other item select's right edge is ${Math.round(g.right)} in a ` +
        `${g.viewportWidth}px viewport (width ${Math.round(g.width)}, natural ` +
        `${Math.round(g.naturalWidth)}). Ancestors, outward:\n${g.chain.join("\n")}`
    ).toBeLessThanOrEqual(g.viewportWidth);

    // And not traded for the page overflowing sideways inside the clipping shell.
    expect(g.mainScrollWidth).toBeLessThanOrEqual(g.mainClientWidth + 1);

    await page.context().close();
  });
});
