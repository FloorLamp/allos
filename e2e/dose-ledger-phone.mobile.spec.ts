import { test, expect } from "./fixtures";
import { expectNoClippedContent } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_DOSE_LEDGER_PHONE,
  E2E_MEMBER_PASSWORD,
  DOSE_LEDGER_PHONE_IMPORTED_MED,
  DOSE_LEDGER_PHONE_ACTIVE_MED,
} from "./fixture-logins";
import { machineDateHits } from "@/lib/machine-date-census";

// THE DOSE RECORD AT PHONE WIDTH (#3478, re-homed by #3958).
//
// #3478's defect was a `w-auto` <select> sized to its WIDEST OPTION — every item the
// profile has ever owned, portal-imported names included — running off the right edge
// of a 390px screen with the app shell swallowing the last 108px in silence. That
// control was the dose ledger's Item filter, and the ledger's four routes folded into
// `/history`, which has no item select and no range row at all. The control is gone,
// so the two cases that measured it are gone with it.
//
// WHAT STAYS, AND WHY THE FIXTURE STAYS WITH IT. The 55-character imported name is
// still the longest string this app can be asked to lay out on a phone, and it still
// reaches TWO live surfaces: the rules editor's "Other item" select (#3631, below —
// the same `w-auto` shape, and the case that would regress) and the record's own
// empty state. So the dedicated profile keeps earning its seed rather than being
// deleted along with the route.
//
// Fixture (#868 hygiene): a DEDICATED profile (e2e/seed/intake.ts,
// seedDoseLedgerPhone). A 55-character medication name on a shared profile would
// widen controls under every neighbouring spec. Read-only — nothing is written.

test.describe("the dose record at phone width (#3478)", () => {
  test("a record with nothing in it says so, and prints no storage-format date", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DOSE_LEDGER_PHONE,
      password: E2E_MEMBER_PASSWORD,
    });
    // This profile owns two medications and has confirmed no dose, so its record is
    // genuinely empty — the state an absence assertion is otherwise flattered by, and
    // the one this fixture can prove is the real thing rather than a race.
    await page.goto("/history?kind=dose");

    const empty = page.getByTestId("history-feed");
    await expect(empty).toBeVisible();
    await expect(page.getByTestId("history-row")).toHaveCount(0);
    const message = page.locator("main");
    await expect(message).toContainText("Nothing recorded here yet.");

    // NO RANGE CHROME SURVIVED THE MOVE. The window note the ledger printed above its
    // rows — "Showing confirmed doses from … to …" — is the sentence #3478 item 2 was
    // about, and the record has no window to state.
    await expect(message).not.toContainText("Showing confirmed doses");

    // AND WHAT IT DOES PRINT CROSSES THE DISPLAY BOUNDARY, asked with the census's OWN
    // rule rather than a second spelling of it (lib/machine-date-census.ts).
    const text = (await message.textContent()) ?? "";
    expect(machineDateHits(text), text).toEqual([]);

    // Nothing on this route sits past an edge with no way to it — the class of defect
    // #3478 reported, asserted on the surface that replaced its subject.
    await expectNoClippedContent(page);
    await page.context().close();
  });

  // ── THE SIBLING CONTROL, #3631's "cheap once this lands" ────────────────────────
  //
  // `IntakeRulesEditor`'s "Other item" select (components/intake/IntakeRulesEditor.tsx)
  // is the SAME SHAPE as #3478's own ledger filter — a `w-auto` select whose options are
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
  // neighbour above.
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
      // floor still in place — measured off-canvas, as #3478's own probe did it.
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

    // THE PREMISE BEFORE THE VERDICT: without an option whose natural
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
