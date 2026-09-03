// PHONE VIEWPORT — a full-bleed card inside an animated fold PAINTS full-bleed.
//
// THE DEFECT (owner, 2026-09-02, two screenshots): below `sm` a `.card` or `band`
// computes its #3920 pull (margin-inline −16px, padding-inline 16px, box x 0 → 390)
// and then paints inset by the page gutter on both sides, with its text on the fill
// edge. The dashboard's Show everything fold and Records → Care → Overview both showed
// it, and pages without a fold did not: `.motion-disclose::details-content` (#4055)
// clipped BOTH axes with `overflow: hidden`, so the fold's own contents box cut the
// card's overhang. The rule now clips the block axis only.
//
// WHY A HIT TEST AND NOT A RECT. `getBoundingClientRect` reported x 0 / width 390 the
// whole time — the box was right, the PAINT was clipped. `elementFromPoint` at x 2 is
// the assertion that can tell the two apart: before the fix it returned the page
// container; after it, the card. The rect check rides along so a future rule that
// un-pulls the card fails here too.

import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { E2E_LOGIN_DASHBOARD_ALL, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { openCareOverviewSection, openDashboardAll } from "./helpers";
import { loginAs } from "./nav";

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

type Paint = {
  left: number;
  right: number;
  contentLeft: number;
  hitAtEdge: boolean;
};

/** The first matching element inside `foldSelector`: its box, and whether a point
 *  2px inside the viewport edge, level with it, resolves to it. */
async function paintOf(
  page: Page,
  foldSelector: string,
  cardSelector: string
): Promise<Paint> {
  return page.evaluate(
    ({ foldSelector, cardSelector }) => {
      const fold = document.querySelector(foldSelector);
      const card = fold?.querySelector(cardSelector) as HTMLElement | null;
      if (!card) throw new Error(`no ${cardSelector} inside ${foldSelector}`);
      const r = card.getBoundingClientRect();
      const y = r.top + Math.min(20, r.height / 2);
      const hit = document.elementFromPoint(2, y);
      // Where the first text sits. A `.card` spends the gutter as its own padding; a
      // `band` spends it through its rows (#3920) — so the honest check is the text.
      const text = card.querySelector("h2, h3, h4, dt, li, p, label");
      return {
        left: r.left,
        right: window.innerWidth - r.right,
        contentLeft: text ? text.getBoundingClientRect().left : NaN,
        hitAtEdge: hit === card || card.contains(hit),
      };
    },
    { foldSelector, cardSelector }
  );
}

/** Polls until the fold's 200ms continuity motion has settled and the element paints
 *  at the viewport edge, then pins the rest of the geometry. The poll IS the settle:
 *  a fixed sleep would assert nothing about the motion having finished. */
async function expectFullBleed(
  page: Page,
  foldSelector: string,
  cardSelector: string,
  label: string
): Promise<void> {
  await expect
    .poll(
      async () => (await paintOf(page, foldSelector, cardSelector)).hitAtEdge,
      { message: `${label}: paints at the viewport edge` }
    )
    .toBe(true);
  const paint = await paintOf(page, foldSelector, cardSelector);
  expect(paint.left, `${label}: left edge`).toBe(0);
  expect(paint.right, `${label}: right edge`).toBe(0);
  // The content keeps the page gutter — the fill moved, the text did not (#3920).
  expect(paint.contentLeft, `${label}: content gutter`).toBeGreaterThanOrEqual(
    16
  );
}

test("a Show everything band paints to both viewport edges on a phone", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_DASHBOARD_ALL, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
  await page.goto("/");
  await openDashboardAll(page);
  await expectFullBleed(
    page,
    '[data-testid="dashboard-all"]',
    ".band",
    "Show everything band"
  );
});

test("a Care overview card paints to both viewport edges on a phone", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_DASHBOARD_ALL, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
  await page.goto("/records/care/overview");
  await openCareOverviewSection(page, "records-background");
  await expectFullBleed(
    page,
    '[data-testid="records-background"]',
    ".card",
    "Care overview card"
  );
});
