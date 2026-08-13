import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// The theme boot's safety net (#2183).
//
// The `dark` class on <html> is applied once per document by the inline boot
// script; the reported bug was that ONE hard navigation on which that script
// failed to run left the entire SPA session light until a manual toggle —
// `router.push` navigations inherit the document's class forever.
// components/ThemeReassert.tsx re-asserts the class (lib/theme.ts's one rule)
// post-hydration and on every route change, and logs one structured diagnostic
// when it finds the poisoned signature. These tests build the failure the clean
// harness could not reproduce and prove the healing plus the instrumentation.
//
// `serviceWorkers: "block"`: this spec rewrites and strips document responses
// with page.route, which cannot see SW-mediated fetches — and the SW is
// irrelevant to what is under test.
test.use({ colorScheme: "dark", serviceWorkers: "block" });

test("a poisoned session heals on the next client navigation", async ({
  page,
}) => {
  // OS-dark with nothing stored means "system" → dark; the boot script sets it.
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);

  // A real client navigation first: it proves hydration is complete, so the
  // mount-time re-assert for this document has already run and the strip below
  // cannot race it.
  const sidebar = page.locator("aside nav");
  await followLink(
    page,
    sidebar.getByRole("link", { name: "Upcoming" }),
    /\/upcoming$/
  );
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);

  // Simulate the poisoned state: the boot-set class is gone (the reported bug's
  // net effect, whatever its trigger), and nothing re-runs until a route change.
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

  // The next client navigation re-asserts the class — the session is healed
  // instead of staying light until a manual toggle.
  await followLink(
    page,
    sidebar.getByRole("link", { name: "Dashboard" }),
    /\/$/
  );
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
});

test("a document served without its boot script lands light but heals itself, logging the diagnostic", async ({
  page,
}) => {
  const consoleLines: string[] = [];
  page.on("console", (message) => consoleLines.push(message.text()));

  // Strip the inline theme-boot script from the served HTML — the hard
  // navigation whose boot never runs, built to order. The script is identified
  // by the one computation it inlines (its source carries no `<`, so the
  // element match is exact).
  await page.route("**/upcoming", async (route) => {
    const response = await route.fetch();
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("text/html")) {
      await route.fulfill({ response });
      return;
    }
    const html = (await response.text()).replace(
      /<script[^>]*>[^<]*localStorage\.getItem\([^<]*<\/script>/,
      ""
    );
    await route.fulfill({ response, body: html });
  });

  await page.goto("/upcoming");

  // Post-hydration the re-assert applies the same rule the boot script would
  // have: the document ends dark instead of poisoning the session.
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);

  // And the trigger was instrumented, not guessed: one structured client event
  // (scope "theme-reassert") recording that dark was expected while the class
  // was missing.
  await expect
    .poll(() => consoleLines.some((line) => line.includes("theme-reassert")))
    .toBe(true);
});

// The offline shell must respect OS dark even when NO script executes at all —
// the SW can serve the cached page into a document whose inline boot script is
// blocked or stale (#2183). The CSS-only `prefers-color-scheme` base in
// globals.css, scoped to [data-offline-shell], is what this proves: JavaScript
// is disabled for the whole test, so no boot script and no re-assert can help.
test.describe("offline shell without scripts", () => {
  test.use({ javaScriptEnabled: false });

  test("renders dark under OS dark preference with no script execution", async ({
    page,
  }) => {
    await page.goto("/offline");
    const shell = page.locator("[data-offline-shell]");
    await expect(shell).toBeVisible();

    // No script ran, so the class-based theme never engaged…
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

    // …yet the shell paints the dark base: the Botanical "Conservatory Night"
    // canvas and light text from the media fallback, not the light off-white
    // (#2701 — a script-less page is always the base palette, by design).
    expect(
      await shell.evaluate((el) => getComputedStyle(el).backgroundColor)
    ).toBe("rgb(9, 14, 11)");
    const heading = page.getByRole("heading", { name: "You're offline" });
    await expect(heading).toBeVisible();
    expect(await heading.evaluate((el) => getComputedStyle(el).color)).toBe(
      "rgb(231, 238, 226)"
    );
  });
});
