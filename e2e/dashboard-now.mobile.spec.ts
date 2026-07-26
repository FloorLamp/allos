import { test, expect } from "./fixtures";
import { type Browser, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_NOWSTRIP,
  E2E_LOGIN_NOWSAFETY,
  NOW_STRIP_APPOINTMENT,
} from "./fixture-logins";

// The dashboard "Now" strip + collapsible Needs-attention hero (issue #1413), at a
// phone viewport.
//
// Every test drives a SPEC-OWNED fixture login (e2e/fixture-logins.ts): the strip's
// content is time-of-day dependent and the hero's collapse preference is stored per
// LOGIN, so toggling it on a shared login would leak a collapsed hero into every
// other spec's dashboard. The NOWSTRIP fixture carries a just-finished session (the
// strip's top-ranked signal, time-of-day independent) plus one appointment due
// today (a stable non-zero attention count).
//
// Viewport note (the #1416 lesson): a context built by `loginAs` via
// `browser.newContext()` does NOT inherit the project's viewport, so every context
// below restates the phone viewport + hasTouch explicitly. Without that these
// "mobile" assertions would silently run at the default desktop size and the
// `md:` breakpoint behavior would be tested backwards.

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 900 }, hasTouch: false };

async function openDashboard(
  browser: Browser,
  creds: { username: string },
  contextOptions: Record<string, unknown> = PHONE
): Promise<Page> {
  const page = await loginAs(
    browser,
    { username: creds.username, password: E2E_MEMBER_PASSWORD },
    contextOptions
  );
  await page.goto("/");
  return page;
}

test("the phone dashboard drops the page header and leads with the Now strip (#1413 A/C)", async ({
  browser,
}) => {
  const page = await openDashboard(browser, { username: E2E_LOGIN_NOWSTRIP });
  try {
    // Section C: below `md` there is no "Dashboard" page heading at all — the nav
    // already says where you are, and the orientation text cost a chunk of a much
    // shorter screen.
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true })
    ).toHaveCount(0);

    // Section A: the strip renders BOTH of this fixture's firing signals — the
    // just-finished session's recap and, because the e2e clock is pinned inside
    // the profile's midday intake anchor, today's nutrition.
    const strip = page.getByTestId("now-strip");
    await expect(strip).toBeVisible();
    await expect(
      strip.getByTestId("now-strip-card-session-recap")
    ).toBeVisible();
    await expect(
      strip.getByTestId("now-strip-card-nutrition-today")
    ).toBeVisible();

    // Exactly two — NOW_STRIP_CAP. A third would push the user's own grid back
    // below the fold, which is the problem the strip exists to solve.
    await expect(strip).toHaveAttribute("data-count", "2");

    // The perishable card leads: a recap window closes in 60 minutes, a mealtime
    // window recurs three times a day.
    const ids = await strip
      .locator("[data-testid^='now-strip-card-']")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-testid") ?? "")
      );
    expect(ids).toEqual([
      "now-strip-card-session-recap",
      "now-strip-card-nutrition-today",
    ]);

    // The date survives on the strip's corner, since the header that used to carry
    // it is gone on a phone.
    await expect(strip.getByTestId("now-strip-date")).toBeVisible();

    // The two-card band must stay a BAND: at 390px the page itself must never
    // scroll sideways (the repo's responsive rule), which is the risk a 2-column
    // strip on a phone actually carries.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await page.context().close();
  }
});

test("desktop keeps the page header (#1413 C is a phone-only drop)", async ({
  browser,
}) => {
  // Same login, same page — only the viewport differs, which is the whole claim.
  const page = await openDashboard(
    browser,
    { username: E2E_LOGIN_NOWSTRIP },
    DESKTOP
  );
  try {
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true })
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("a promoted card renders exactly ONCE — the strip is a reference, not a copy (#1413 A)", async ({
  browser,
}) => {
  const page = await openDashboard(browser, { username: E2E_LOGIN_NOWSTRIP });
  try {
    await expect(page.getByTestId("now-strip")).toBeVisible();
    // The recap card lives in the strip and NOT also in its standalone slot below.
    await expect(page.getByTestId("session-recap-card")).toHaveCount(1);
    await expect(
      page.getByTestId("now-strip").getByTestId("session-recap-card")
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("the attention hero collapses to a pinned line, keeps its count, and persists (#1413 B / #449)", async ({
  browser,
}) => {
  const page = await openDashboard(browser, { username: E2E_LOGIN_NOWSTRIP });
  try {
    const hero = page.getByTestId("needs-attention");
    await expect(hero).toBeVisible();
    // Wait for hydration rather than sleeping — the toggle is a client control, so
    // a pre-hydration click would be swallowed (the #1416 data-ready precedent).
    await expect(hero).toHaveAttribute("data-ready", "true");

    // `data-saved-count` counts SETTLED preference writes and always starts at 0 on
    // a fresh mount, so the expected value is simply "how many times this test has
    // toggled". Tracked explicitly rather than sampled from the DOM: a sample taken
    // between a click and its response reads the PRE-click value and then under-
    // counts (which is exactly how the first version of this test failed).
    let saves = 0;

    // The collapse preference PERSISTS, so a previous --repeat-each pass may have
    // left it collapsed. Normalize to expanded instead of assuming it: a fixture
    // this spec mutates has to be re-entrant, not merely spec-owned.
    if ((await hero.getAttribute("data-collapsed")) === "true") {
      await hero.getByTestId("attention-collapse-toggle").click();
      await expect(hero).toHaveAttribute("data-collapsed", "false");
      saves += 1;
      await expect(hero).toHaveAttribute("data-saved-count", String(saves));
    }

    // Expanded: the seeded due-today appointment is one of the listed rows.
    await expect(hero).toContainText(NOW_STRIP_APPOINTMENT);
    const count = await hero.getByTestId("attention-count").textContent();
    expect(Number(count)).toBeGreaterThan(0);

    await hero.getByTestId("attention-collapse-toggle").click();
    await expect(hero).toHaveAttribute("data-collapsed", "true");

    // THE #449 CONTRACT: collapsed is not hidden. The card, its count, and the
    // highest-severity band all still render; only the item rows are compacted
    // away, and they are out of the accessibility tree while collapsed.
    await expect(hero).toBeVisible();
    await expect(hero.getByTestId("attention-count")).toBeVisible();
    await expect(hero.getByTestId("attention-count")).toHaveText(count ?? "");
    await expect(hero.getByTestId("attention-top-band")).toBeVisible();
    await expect(
      hero.getByRole("link", { name: NOW_STRIP_APPOINTMENT })
    ).toHaveCount(0);

    // It survives a reload — the preference is stored per login.
    //
    // Deliberately NOT settledClick: e2e/helpers.ts documents it as unreliable on
    // exactly this page — the dashboard carries background action-POST traffic, so
    // the wait can settle on a BYSTANDER POST while the real write is still in
    // flight, and the reload then aborts it. (Observed on the first attempt at
    // this test: the toggle POST landed only after the reloaded page had already
    // rendered the stale preference.) The card's `data-saved-count` is the
    // race-free settle instead — it advances only when this write has actually
    // come back, so the reload below cannot outrun it.
    saves += 1;
    await expect(hero).toHaveAttribute("data-saved-count", String(saves));

    await page.reload();
    const heroAfter = page.getByTestId("needs-attention");
    await expect(heroAfter).toHaveAttribute("data-collapsed", "true");
    await expect(heroAfter.getByTestId("attention-count")).toHaveText(
      count ?? ""
    );

    // And it is genuinely two-way: expanding restores the rows. (Persisting this
    // final expand is not asserted — the normalization above makes the spec
    // re-entrant regardless of which state it leaves behind.)
    await expect(heroAfter).toHaveAttribute("data-ready", "true");
    await heroAfter.getByTestId("attention-collapse-toggle").click();
    await expect(heroAfter).toHaveAttribute("data-collapsed", "false");
    await expect(heroAfter).toContainText(NOW_STRIP_APPOINTMENT);
  } finally {
    await page.context().close();
  }
});

test("a safety-tier item renders the hero expanded with NO collapse control (#1413 B / #942)", async ({
  browser,
}) => {
  // This fixture's severe PHQ-9 makes the crisis finding fire — a
  // `safety-ungated` item the dismissal bus can never hide and the collapse
  // preference can never compact.
  const page = await openDashboard(browser, { username: E2E_LOGIN_NOWSAFETY });
  try {
    const hero = page.getByTestId("needs-attention");
    await expect(hero).toBeVisible();
    await expect(hero).toHaveAttribute("data-locked", "true");
    await expect(hero).toHaveAttribute("data-collapsed", "false");
    // No toggle at all: a control that would refuse to act reads as a bug.
    await expect(hero.getByTestId("attention-collapse-toggle")).toHaveCount(0);
    // The safety item itself is on the card, expanded.
    await expect(hero).toContainText("Mental-health check-in");
    await expect(hero.getByTestId("attention-count")).toBeVisible();
  } finally {
    await page.context().close();
  }
});
