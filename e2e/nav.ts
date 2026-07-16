import {
  expect,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";

// followLink now lives in the blessed interaction module (issue #868). Re-exported
// here so existing `import { followLink } from "./nav"` call sites keep working.
export { followLink } from "./helpers";

// Sign in as the given credentials in a brand-new, explicitly cookie-less context
// (so it does NOT inherit the admin storageState). Returns the member's page; the
// caller owns closing its context. Used by the #391 specs to drive an isolated,
// non-admin session — its own server-side active profile — without touching the
// shared admin session that every other spec relies on.
export async function loginAs(
  browser: Browser,
  creds: { username: string; password: string }
): Promise<Page> {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill('input[name="username"]', creds.username);
  await page.fill('input[name="password"]', creds.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
  return page;
}

// Open the Cmd/Ctrl-K command palette reliably. The same pre-hydration swallow
// (issue #500) applies to the keyboard shortcut: a keypress fired before the
// document-level keydown handler is wired does nothing, so the palette never
// opens and the very first assertion (its search input) fails under parallel-run
// contention. Re-press until the input appears — guarded on visibility so a press
// after it has opened can't toggle it shut.
export async function openCommandPalette(page: Page): Promise<Locator> {
  const input = page.getByRole("combobox", {
    name: "Search or run a command",
  });
  await expect(async () => {
    if (!(await input.isVisible())) {
      await page.keyboard.press("Control+KeyK");
    }
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20000, intervals: [300, 700, 1500] });
  return input;
}
