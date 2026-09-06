import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  expectNoClippedContent,
  openDashboardAll,
  openEverythingFold,
} from "./helpers";
import {
  CONTROL_BOX_PX,
  TAP_FLOOR_FLOAT_EPSILON_PX,
} from "@/lib/tap-floor-tokens";
import {
  E2E_LOGIN_ROUTINEUSUAL,
  E2E_LOGIN_WELLSYM,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// THE DASHBOARD HAS ONE GRAMMAR (#3365/#4076).
//
// Cards-act/lines-report (#3077) is dead as a rendering rule. In the browser that is
// three claims: EVERY group renders rows and no card at all, same-origin atoms fold
// into ONE block with ONE header, and no two blocks state the same title.
//
// EVERY ABSENCE ASSERTION BELOW CARRIES ITS POSITIVE CONTROL IN THE SAME TEST — a
// selector that cannot find the group would satisfy "no cards in here" on a tree
// where the tail vanished entirely, which is the failure this file exists to catch.
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

test.describe("the dashboard's row grammar (#3365/#4076)", () => {
  // THE GUARD INVERTS (#4076). It used to say "every card in a reporting group hosts
  // a write"; the ruling makes it "no card exists here at all", in any zone. Both
  // halves are asserted together — an empty page satisfies the absence, and a page
  // that kept the cards but lost the writes satisfies nothing anybody wanted.
  test("every group renders rows, no zone renders a card, and the writes came with them", async ({
    page,
  }) => {
    await page.goto("/");
    await openDashboardAll(page);

    let controls = 0;
    for (const group of [
      "act",
      "read",
      "understand",
      "setup",
      "active-states",
    ] as const) {
      const section = page.getByTestId(`dashboard-everything-${group}`);
      await expect(section).toHaveCount(1);
      // THE POSITIVE CONTROL. Every claim below is an absence, and an absence goes
      // green the moment the selector stops finding anything — so the group must
      // first be shown to exist and to hold entries.
      const rows = section.getByTestId("dashboard-candidate");
      expect(await rows.count(), `${group} renders entries`).toBeGreaterThan(0);
      // …and every entry is a ROW: `<li>` in the block's list, never a card shell.
      expect(
        await rows.evaluateAll(
          (nodes) => nodes.filter((node) => node.tagName !== "LI").length
        ),
        `${group}: an entry that is not a row`
      ).toBe(0);
      controls += await section
        .getByTestId("dashboard-row-controls")
        .locator("button")
        .count();
    }

    // NO CARD IN ANY ZONE, not only in the reporting groups — the acceptance line is
    // about `/`, so the sweep is the whole main region.
    //
    // THE SELECTOR IS PAGE-ROOTED ON PURPOSE. This read
    // `page.getByRole("main").locator("main .card, …")`, and chained CSS is resolved
    // RELATIVE TO THE ROOT the locator is scoped to — so it asked for a `<main>`
    // inside a `<main>` and matched nothing, ever. The guard could not fail.
    const cards = page.locator("main .card, main .card-quiet");
    await expect(cards).toHaveCount(0);

    // …AND THIS LOCATOR CAN SEE A CARD — asserted with the SAME locator object the
    // claim above uses, which is the whole point and is what the previous control
    // got wrong. That control forged a card and queried it back through
    // `document.querySelectorAll`, a different selector path: it proved that *a*
    // query can find a card, never that *this guard* can. A proof of falsifiability
    // that exercises a different path from the assertion it vouches for is worth
    // nothing, and it reads exactly like a rigorous one.
    const forged = await page.evaluateHandle(() => {
      const node = document.createElement("article");
      node.className = "card";
      node.textContent = "FORGED BY A SPEC on purpose — not a shipped card";
      document.querySelector("main")!.append(node);
      return node;
    });
    await expect(cards).toHaveCount(1);
    await forged.evaluate((node) => (node as Element).remove());
    await expect(cards).toHaveCount(0);

    // …AND THE WRITES SURVIVED THE CARDS. This is the converse the absence above
    // cannot state: the tail hosts real controls, on rows.
    expect(controls, "the tail hosts no write at all").toBeGreaterThan(0);
  });

  // THE ROW'S CLOSED SHAPE (#4076): "at most two trailing controls". The ruling
  // states it as an invariant and nothing was watching it, which is the shape this
  // issue's whole arc is about — a rule with no element re-accretes.
  //
  // A CONTROL IS SOMETHING A PERSON CAN OPERATE, and getting that wrong is how this
  // measurement first lied to me: counting every `input` in the slot reported 29 rows
  // over the cap, because each write carries its `dedupe_key` as a HIDDEN input and
  // the coaching row carries two forms' worth. Hidden payload is not an affordance.
  // So the filter is part of the claim, not a convenience.
  //
  // THE HEIGHT HALF IS NOW ASSERTED TOO (#4362 ruling 5). It was not, and the reason
  // is worth keeping: the snooze/dismiss overflow trigger rendered `h-10` (40px) on
  // 48 rows, a shared primitive with 34 call sites that predates the ruling and sat
  // beside a 34px "Mark taken" in the old card as well. Writing an exception for it
  // into this guard would have been the allowlist this repo bans, so it was reported
  // instead — and the owner shrank the trigger rather than minting the exception.
  // With no deviation left, the invariant's two claims are one measurement.
  //
  // MEASURED, NEVER A CLASS STRING. `h-(--control-box)` in a class list is a
  // DECLARATION; #3514's cascade bug read correctly in the stylesheet and did not
  // arrive at the element. So the number below comes from a rendered box.
  test("no row hosts more than two operable controls, and each is the control box", async ({
    page,
  }) => {
    await page.goto("/");
    await openDashboardAll(page);

    const rows = await page
      .getByTestId("dashboard-candidate")
      .evaluateAll((nodes) =>
        nodes.flatMap((node) => {
          const slot = node.querySelector(
            '[data-testid="dashboard-row-controls"]'
          );
          if (!slot) return [];
          const operable = [
            ...slot.querySelectorAll<HTMLElement>(
              "button, a, input, select, textarea"
            ),
          ].filter(
            (control) =>
              !(
                control instanceof HTMLInputElement && control.type === "hidden"
              ) && control.getBoundingClientRect().height > 0
          );
          return [
            {
              id: node.getAttribute("data-candidate-id"),
              controls: operable.length,
              // The rendered box of each one, rounded to the pixel the ruling names.
              // A `<form>` wrapper around a submit button contributes no box of its
              // own, so this measures the operable elements themselves.
              heights: operable.map((control) =>
                Math.round(control.getBoundingClientRect().height)
              ),
            },
          ];
        })
      );

    // The control: rows DO host controls on this fixture, so the cap below is a
    // claim about a populated set — an empty one satisfies any cap.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.controls > 2)).toEqual([]);
    // …and the cap is actually approached, or it is bounding nothing that exists.
    expect(rows.some((row) => row.controls === 2)).toBe(true);

    // THE ONE HEIGHT. Reported as the offending rows and their measured boxes, not as
    // a count: "Expected 34, Received 40" names no row to open.
    expect(
      rows.flatMap((row) =>
        row.heights
          .filter((height) => height !== CONTROL_BOX_PX)
          .map((height) => `${row.id}: ${height}px`)
      )
    ).toEqual([]);
    // The control for THAT claim: a box was actually measured at the ruled height.
    // The filter above returns an empty list on a row set that hosts no control at
    // all, which is the same green as one where every control is 34.
    expect(rows.flatMap((row) => row.heights)).toContain(CONTROL_BOX_PX);
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

  // WIDENED TO EVERY TITLE IN THE LANE (#4076). This read `[data-moment-key] h4` —
  // FOLDED headers only — so it was blind to the half of the defect that survived
  // #3365: on the seeded profile the Understand group held 6 card `<h2>`s titled
  // "Coaching observations" and 5 titled "Data quality", 11 duplicate-titled blocks
  // in one group, each also repeating its subtitle. Widening it was RED until those
  // families stopped rendering cards and gained the shared `groupKey` that lets them
  // fold, so it lands with that change and not before it.
  test("no two blocks in the tail share a title", async ({ page }) => {
    await page.goto("/");
    await openDashboardAll(page);
    // A CAPPED BAND'S FOLD MUST BE OPEN FIRST (#4065), or its blocks' headers are
    // real DOM nodes inside a closed native `<details>` — not rendered, so
    // `allInnerTexts()` reads them as the EMPTY STRING rather than their actual
    // title, and four genuinely different titles collapse onto one "duplicate"
    // that was never there. Opening both possible band folds (each a no-op where
    // the band didn't cap on this render) makes every block's real title readable,
    // which is what "no two blocks share a title" is actually a claim about.
    await openEverythingFold(page, "understand");
    await openEverythingFold(page, "setup");
    const lane = page.getByTestId("dashboard-all-contents");

    // Every heading the lane draws BELOW its five group labels: a moment block's
    // header, and anything else that titles a block. `h3` is the group label itself
    // ("Act", "Read", …) and is excluded by naming the levels a block may use.
    const headers = await lane.locator("h2, h4, h5").allInnerTexts();
    // The control: there ARE headed blocks, so the uniqueness claim below is about a
    // populated set and not an empty one.
    expect(headers.length).toBeGreaterThan(0);
    const seen = new Map<string, number>();
    for (const header of headers) seen.set(header, (seen.get(header) ?? 0) + 1);
    expect([...seen].filter(([, count]) => count > 1)).toEqual([]);
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
  test("the usual-routine row is titled by what it does, not by the readout's name", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_ROUTINEUSUAL,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      await openDashboardAll(page);
      const row = page
        .getByTestId("dashboard-candidate")
        .filter({ has: page.getByTestId("routine-usual-offer") });
      // The control: the offer is on screen, so the title claims below are about a
      // row that rendered.
      await expect(row).toHaveCount(1);
      // The control is a COUNT (#5320) and the promise is on the row beside it —
      // the dose chips and the food members' facts text — so nothing is printed
      // twice. The whole sentence is still the control's accessible name, which is
      // where a reader gets it.
      const offer = row.getByTestId("routine-usual-offer");
      await expect(offer).toContainText(/^Log /);
      await expect(offer).toHaveAttribute("aria-label", /^Your usual /);
      // "Nutrition today" headed BOTH this offer and the Read protein readout, so the
      // same words scrolled past twice meaning two different things (#3365). One
      // surface owns the name now, and it is never this one.
      await expect(row).not.toContainText("Nutrition today");
      await expect(
        page
          .getByTestId("dashboard-all-contents")
          .getByText("Nutrition today", { exact: true })
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
  // THE FACTS CELL CANNOT LOSE ITS ROW TO THE CONTROLS CELL (#5320).
  //
  // The P1 was not the offer card. It was that the row grammar had NO width bound on
  // its trailing cell at all: the cell is `shrink-0`, so a control that asked for
  // width simply took it, the facts cell got what was left, and six dose chips wrapped
  // one per line beside a card. So the guard is on the GRAMMAR — every Now row hosting
  // a control, not the one row that broke — because that is where the missing bound
  // was.
  //
  // AS A RELATIONSHIP, NOT AN ABSOLUTE. A facts cell 200px wide is correct on a phone
  // and broken on a desktop, so the claim is the facts cell against ITS OWN ROW. The
  // height half is the ruled absolute (#3938's one 34px box) and stays one.
  //
  // MEASURED, NEVER A CLASS STRING, for #3514's reason: `flex-1` in a class list is a
  // declaration, and the only thing that matters is the box that arrived.
  test("every Now row hosting a control keeps at least half its width for the facts, and holds its controls at the control box", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_ROUTINEUSUAL,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // BOTH VIEWPORTS ARE MEASURED BEFORE EITHER CLAIM IS MADE. Asserting inside
      // the loop throws on the first viewport that offends, and the one that would
      // have spoken loudest never runs: measured on the unfixed tree, the desktop
      // row's facts cell held 548px of 966 — the fixture's phrase is short — while
      // the SAME row at 390px held 0px of 358. A per-viewport assertion reported the
      // height defect and reported nothing at all about the width.
      const tooNarrow: string[] = [];
      const tooTall: string[] = [];
      for (const viewport of [DESKTOP, PHONE]) {
        await page.setViewportSize(viewport);
        await page.goto("/");
        const hosts = page.locator(
          '[data-testid="dashboard-candidate"][data-lane="now"]:has([data-testid="dashboard-row-controls"])'
        );
        // THE POSITIVE CONTROL, and here it is the whole ballgame: both claims below
        // are quantified over a set of rows and an EMPTY set satisfies either one.
        // Waiting on the CONTROL rather than on the row is also what makes the boxes
        // below a reading of the thing being measured instead of of an empty cell.
        await expect(
          hosts.first().getByTestId("dashboard-row-controls"), // eslint-disable-line no-restricted-properties -- first-ok: the claims below are over ALL of these rows and this only waits for the set to have rendered — on a dedicated fixture login (E2E_LOGIN_ROUTINEUSUAL), read-only
          `${viewport.width}px: Now hosts a row with a control`
        ).toBeVisible();
        const measured = await hosts.evaluateAll((rows) =>
          rows.map((row) => {
            const slot = row.querySelector(
              '[data-testid="dashboard-row-controls"]'
            )!;
            return {
              id: row.getAttribute("data-candidate-id"),
              // The row's own two-cell flex line, not the <li>: the <li> is the list
              // item and can carry motion transforms of its own.
              width: slot.parentElement!.getBoundingClientRect().width,
              facts: slot.previousElementSibling!.getBoundingClientRect().width,
              controls: slot.getBoundingClientRect().height,
            };
          })
        );
        // Collected as the offending rows and their measured boxes, not as a count:
        // "Expected true, Received false" names no row to open.
        tooNarrow.push(
          ...measured
            .filter((m) => m.facts + TAP_FLOOR_FLOAT_EPSILON_PX < m.width / 2)
            .map(
              (m) =>
                `${viewport.width}px ${m.id}: facts ${Math.round(m.facts)}px of a ${Math.round(m.width)}px row`
            )
        );
        tooTall.push(
          ...measured
            .filter(
              (m) => m.controls > CONTROL_BOX_PX + TAP_FLOOR_FLOAT_EPSILON_PX
            )
            .map(
              (m) =>
                `${viewport.width}px ${m.id}: controls cell ${Math.round(m.controls)}px`
            )
        );
      }
      expect(tooNarrow, "the facts cell keeps half its row").toEqual([]);
      expect(tooTall, "the controls cell is the control box").toEqual([]);
    } finally {
      await page.context().close();
    }
  });
});
