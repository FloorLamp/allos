import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The dedicated Sleep page (issue #1066). Profile 1 (the seeded admin) has the
// #160 SRI nights + the #1066 stage/nap fixture (e2e/seed-events.ts), so the page
// renders its hero and every section, the nav entry is present (data-gated), and
// the dashboard "last night" tile links through. The child fixture profile has NO
// sleep data, so it proves the nav gate hides the entry.
//
// Reads only; drives no writes on the shared profile-1 session, so it can't
// disturb neighbors.

test.describe("Sleep page (#1066)", () => {
  test("renders the last-night hero and every section on a sleep-seeded profile", async ({
    page,
  }) => {
    await page.goto("/sleep");

    const main = page.getByRole("main");

    // Hero: duration + the SEPARATE nap line (never summed into the night, #1118).
    const hero = main.getByTestId("sleep-hero");
    await expect(hero).toBeVisible();
    const duration = hero.getByTestId("sleep-hero-duration");
    await expect(duration).toBeVisible();
    const durationText = (await duration.innerText()).trim();
    // The seeded last night is a 5h overnight (23:00 → 04:00) — NOT 5h45m, which
    // is what a nap-summed total would read. The nap is its own line.
    expect(durationText).toBe("5h");
    const nap = hero.getByTestId("sleep-hero-nap");
    await expect(nap).toBeVisible();
    await expect(nap).toContainText("nap");
    await expect(nap).toContainText("45m");

    // The hero deep-links to the night's Timeline view ("see in day context").
    await expect(hero.getByTestId("sleep-hero-day-link")).toBeVisible();

    // Regularity (SRI) card — the same computation the healthspan pillar reads.
    const sri = main.getByTestId("sri-value");
    await expect(sri).toBeVisible();
    const sriValue = Number((await sri.innerText()).trim());
    expect(Number.isFinite(sriValue)).toBe(true);

    // Consistency strip + stage composition render on the seeded fixture.
    await expect(main.getByTestId("sleep-consistency")).toBeVisible();
    await expect(main.getByTestId("sleep-stages")).toBeVisible();
  });

  test("the Sleep nav entry is present for a sleep-tracking profile", async ({
    page,
  }) => {
    await page.goto("/");
    // The shared SidebarContent renders <Nav> in BOTH the desktop sidebar and the
    // mobile drawer (#794), so the /sleep href appears in two <nav>s in the DOM.
    const sleepNav = page.locator('nav a[href="/sleep"]').first(); // first-ok: shared responsive nav rendered in both viewports; either instance proves the gated leaf is present
    await expect(sleepNav).toBeVisible();
  });

  test("the dashboard last-night tile renders and links to the Sleep page", async ({
    page,
  }) => {
    await page.goto("/");
    const tile = page.getByTestId("sleep-last-night-widget");
    await expect(tile).toBeVisible();

    // The tile reads the SAME model as the hero — its duration matches.
    const tileDuration = (
      await tile.getByTestId("sleep-last-night-duration").innerText()
    ).trim();
    expect(tileDuration).toBe("5h");

    // The tile's header link points at the full page.
    await expect(
      tile.getByRole("link", { name: /last night/i })
    ).toHaveAttribute("href", "/sleep");
  });

  test("the nav gate HIDES the entry for a profile with no sleep data", async ({
    browser,
  }) => {
    // The child fixture profile has no sleep sessions → the sleep relevance bit is
    // false → the nav leaf is hidden. Isolated login context so it never touches
    // the shared admin session's active profile.
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      // A visible surface proves the shell rendered…
      const timeline = page
        .getByRole("link", { name: "Timeline", exact: true })
        .first(); // first-ok: shared responsive nav leaf rendered in both viewports; first instance confirms the shell mounted
      await expect(timeline).toBeVisible();
      // …and the Sleep leaf is absent for this sleep-less profile (both navs).
      await expect(page.locator('nav a[href="/sleep"]')).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("the Sleep page body does not scroll sideways at phone width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/sleep");
    await expect(page.getByTestId("sleep-hero")).toBeVisible();
    const noBodyScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    );
    expect(noBodyScroll).toBe(true);
  });
});
