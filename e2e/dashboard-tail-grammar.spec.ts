import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { expectNoClippedContent, openDashboardAll } from "./helpers";
import {
  E2E_LOGIN_ROUTINEUSUAL,
  E2E_LOGIN_WELLSYM,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// THE SHOW-EVERYTHING TAIL HAS ONE GRAMMAR (#3365).
//
// Cards act, lines report (#3077). In the browser that is three claims: the reporting
// groups render rows and not cards, same-origin atoms fold into ONE block with ONE
// header, and no card in the lane is headerless or repeats another card's title.
//
// EVERY ABSENCE ASSERTION BELOW CARRIES ITS POSITIVE CONTROL IN THE SAME TEST — a
// selector that cannot find the group would satisfy "no cards in here" on a tree
// where the tail vanished entirely, which is the failure this file exists to catch.
test.describe("the Show-everything tail's grammar (#3365)", () => {
  test("the reporting groups report as rows, and every card left in them acts", async ({
    page,
  }) => {
    await page.goto("/");
    await openDashboardAll(page);

    for (const group of ["read", "understand", "setup"] as const) {
      const section = page.getByTestId(`dashboard-everything-${group}`);
      await expect(section).toHaveCount(1);
      // THE POSITIVE CONTROL. Every claim below is an absence, and an absence goes
      // green the moment the selector stops finding anything — so the group must
      // first be shown to exist and to hold entries.
      const rows = section.getByTestId("dashboard-candidate");
      expect(await rows.count(), `${group} renders entries`).toBeGreaterThan(0);

      // CARDS ACT, LINES REPORT (#3077), asserted as the doctrine rather than as a
      // list of exceptions. A reporting group may still hold a card — an attention
      // fact carries its own snooze/dismiss, a coaching recommendation is the only
      // mount of its two writes — but every such card must HOST A WRITE. A card here
      // with no control is a readout wearing card chrome, which is exactly the defect
      // this grammar replaced, and it fails here whatever surface introduces it.
      // Counting controls rather than naming components is what keeps this from
      // becoming an allowlist that has to be maintained.
      const cards = await section.locator(".card").evaluateAll((nodes) =>
        nodes.map((node) => ({
          testId: node.getAttribute("data-testid"),
          controls: node.querySelectorAll(
            "button, form, input, select, textarea"
          ).length,
        }))
      );
      expect(
        cards.filter((card) => card.controls === 0),
        `${group}: a card that reports instead of acting`
      ).toEqual([]);
    }

    // Read is the strict case, and it is strict BY CONSTRUCTION: every reading the
    // page registers declares a row presentation, so nothing in this group can reach
    // the card branch at all. Stated separately from the doctrine check above because
    // it is a stronger claim and only true here.
    await expect(
      page.getByTestId("dashboard-everything-read").locator(".card")
    ).toHaveCount(0);

    // The six shipped recap atoms are ONE block under ONE header.
    const recap = page.locator('[data-moment-key^="recap:"]');
    await expect(recap).toHaveCount(1);
    await expect(recap.locator("h4")).toHaveCount(1);
    expect(
      await recap.getByTestId("dashboard-candidate").count()
    ).toBeGreaterThan(1);
  });

  // #3365's third amendment: "No empty-state prose in the tail — absence is not
  // content." One sentence outlived that ruling because its host had no way to
  // suppress it: `SymptomLogBar`'s "No symptoms logged." rendered inside the tail's
  // well-day card. #3366 retired that mount, so the sentence goes with it, and this
  // is where that is checked rather than assumed. The bar itself is unchanged — it
  // still says this in the illness cockpit and on the Cycles page, where a day with
  // no symptoms logged is the reader's actual question.
  //
  // ON THE WELL-DAY LOGIN, WHICH IS THE ONLY PLACE THE CLAIM MEANS ANYTHING. The card
  // was gated on a WELL day, so on the shared fixture — which carries an open illness
  // — it never rendered and this test would have passed on the unfixed tree too.
  // Measured: with the mount restored, the shared fixture stayed green and this login
  // went red.
  test("no empty-state sentence renders inside the tail", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_WELLSYM,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      await openDashboardAll(page);
      const lane = page.getByTestId("dashboard-all-contents");
      // The control: the lane rendered and holds entries, so the absence below is
      // about a populated tail and not a selector that found nothing.
      expect(
        await lane.getByTestId("dashboard-candidate").count()
      ).toBeGreaterThan(0);
      await expect(lane.getByTestId("symptom-log-bar")).toHaveCount(0);
      await expect(lane.getByTestId("symptom-none-logged")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("no two tail blocks share a moment header", async ({ page }) => {
    await page.goto("/");
    await openDashboardAll(page);
    const lane = page.getByTestId("dashboard-all-contents");

    // Every moment block states its moment once, and no two state the same one —
    // the six identical "Weekly recap" headers were the defect (#3365).
    const headers = await lane.locator("[data-moment-key] h4").allInnerTexts();
    // The control: there ARE headed blocks, so the uniqueness claim below is about a
    // populated set and not an empty one.
    expect(headers.length).toBeGreaterThan(0);
    expect([...new Set(headers)].length).toBe(headers.length);
  });

  test("expanding the tail never widens the page, and every door stays on its row", async ({
    page,
  }) => {
    await page.goto("/");
    await openDashboardAll(page);

    // A tail row's hover door is `absolute right-0`, which pins to the nearest
    // POSITIONED ancestor — and when no row provided one, every door fell through to
    // the viewport itself and its resting 4px translate gave the whole desktop a
    // horizontal scrollbar (#4078 regression). The positive control first: doors
    // exist in the tail, so both claims below are about rendered doors.
    const doors = page
      .getByTestId("dashboard-all-contents")
      .getByTestId("standing-door");
    expect(await doors.count()).toBeGreaterThan(0);

    // Claim one, the user's symptom: no sideways overflow with the tail expanded.
    // The escaped door is invisible at rest (opacity 0), so the helper's element
    // walk skips it — its document-level belt-and-braces branch is what catches
    // this one, because a viewport-anchored box evades the app shell's clip too.
    await expectNoClippedContent(page);

    // Claim two, the mechanism: each door's containing block is its own row — its
    // `offsetParent` (nearest positioned ancestor) lives inside the row's <li>. Box
    // geometry can't state this (the resting slide-in translate legitimately hangs
    // 4px past the row, into the band shell's overflow clip); the anchor can.
    const escaped = await doors.evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const row = node.closest("li");
          if (!row) return { text: node.textContent, why: "no <li> ancestor" };
          const anchor = node instanceof HTMLElement ? node.offsetParent : null;
          return anchor instanceof Element && row.contains(anchor)
            ? null
            : { text: node.textContent, why: "door anchored outside its row" };
        })
        .filter(Boolean)
    );
    expect(escaped).toEqual([]);
  });

  // READ-ONLY on the composed-morning fixture: it looks at the offer and never taps
  // it, so e2e/routine-usual.spec.ts still finds its rows where it left them.
  test("the usual-routine card is titled by what it does, not by the readout's name", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_ROUTINEUSUAL,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      await openDashboardAll(page);
      const card = page.getByTestId("usual-routine-atom");
      // The control: the offer is on screen, so the title claims below are about a
      // card that rendered.
      await expect(card).toBeVisible();
      await expect(card.locator("h3")).toHaveText(/^Your usual /);
      // "Nutrition today" headed BOTH this offer and the Read protein readout, so the
      // same words scrolled past twice meaning two different things (#3365). One
      // surface owns the name now, and it is never this one.
      await expect(card).not.toContainText("Nutrition today");
      await expect(
        page
          .getByTestId("dashboard-all-contents")
          .getByText("Nutrition today", { exact: true })
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
