import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
// PWA home-screen shortcuts (issue #1424, section A).
//
// Two halves, both asserted here because neither is observable any other way:
//
//   1. The MANIFEST the OS actually reads. `app/manifest.ts` composes the list
//      from lib/pwa-shortcuts.ts, but only a real request proves Next serves it,
//      that it stays session-free (a standalone launch starts unauthenticated),
//      and that the urls survive serialization intact.
//   2. The LANDING. A shortcut url is worthless if `?quick=` doesn't open the
//      surface it promises. Each case asserts the REAL existing overlay — the
//      activity editor, the shared quick-entry sheet, the command palette — not a
//      new one, which is the whole design constraint (#1476: no new entry paths).
//
// Runs in the `mobile` project by its `*.mobile.spec.ts` name: a home-screen
// shortcut is a phone affordance. The handler itself is viewport-agnostic (the
// url is an ordinary link), so nothing here depends on the mobile bar rendering.
//
// Fixture hygiene (#868): every test is READ-ONLY over the shared seed — opening
// an overlay writes nothing — and asserts presence, never a count of seeded rows.
// The one mutation-shaped assertion (the param disappearing) is a client-side
// router.replace, not a server write.

// The handler strips `?quick=` via router.replace once it has read it — an async
// client navigation, so a single synchronous page.url() read races it. Polled.
async function expectQuickParamCleared(page: Page): Promise<void> {
  await expect
    .poll(() => new URL(page.url()).searchParams.get("quick"))
    .toBeNull();
}

const SHORTCUT_URLS = [
  "/?quick=log-activity",
  "/?quick=log-dose",
  "/?quick=search",
];

test.describe("PWA manifest shortcuts", () => {
  test("the served manifest advertises the home-screen shortcut menu", async ({
    request,
  }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.ok()).toBe(true);

    const manifest = (await res.json()) as {
      shortcuts?: {
        name?: string;
        description?: string;
        url?: string;
        icons?: unknown[];
      }[];
    };

    const shortcuts = manifest.shortcuts ?? [];
    // Order is the OS menu order, so it is part of the contract, not incidental.
    expect(shortcuts.map((s) => s.url)).toEqual(SHORTCUT_URLS);

    for (const s of shortcuts) {
      // A menu row with no label is unusable, and one with no icon renders as a
      // blank tile on Android.
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.icons?.length ?? 0).toBeGreaterThan(0);
    }

    // The quick-log names come from QUICK_LOG_ITEMS (lib/pwa-shortcuts derives
    // them), which is what keeps the home screen and the in-app sheet saying the
    // same words. Pinned by value here so a rename has to be deliberate.
    expect(shortcuts.map((s) => s.name)).toEqual([
      "Log activity",
      "Log dose",
      "Search",
    ]);
  });

  test("the manifest is reachable without a session (a standalone launch starts anonymous)", async ({
    browser,
  }) => {
    // A cookie-less context: this is the state the OS is in when it installs the
    // app and reads the shortcut list. If the manifest were session-gated the
    // long-press menu would simply be empty.
    const ctx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const res = await ctx.request.get("/manifest.webmanifest");
      expect(res.ok()).toBe(true);
      const manifest = (await res.json()) as { shortcuts?: { url?: string }[] };
      expect((manifest.shortcuts ?? []).map((s) => s.url)).toEqual(
        SHORTCUT_URLS
      );
    } finally {
      await ctx.close();
    }
  });
});

test.describe("?quick= deep links", () => {
  test("log-activity opens the activity editor, and the param is dropped", async ({
    page,
  }) => {
    await page.goto("/?quick=log-activity");

    // The SAME editor the sheet's "Log activity" row opens (openCreate) — a dock,
    // not a bottom sheet, because a workout is a session lifecycle (#1428).
    await expect(page.getByTestId("activity-form")).toBeVisible();

    // The param is replaced away as soon as it is read, so a reload or a
    // back-navigation doesn't re-pop the editor over work in progress. Polled,
    // not read once: router.replace lands after the effect, asynchronously.
    await expectQuickParamCleared(page);
  });

  test("log-dose opens the shared quick-entry overlay on the dose form", async ({
    page,
  }) => {
    await page.goto("/?quick=log-dose");

    await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
    // `data-form` proves it opened the DOSE form specifically — the same overlay
    // mount the sheet uses, reached by url instead of by tap.
    await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
      "data-form",
      "dose"
    );
    await expectQuickParamCleared(page);
  });

  test("search opens the command palette", async ({ page }) => {
    await page.goto("/?quick=search");

    // Same palette the ⌘K shortcut and the mobile bar's magnifier open
    // (openGlobalSearch) — no second search surface.
    await expect(
      page.getByRole("combobox", { name: "Search or run a command" })
    ).toBeVisible();
    await expectQuickParamCleared(page);
  });

  test("a shortcut works from a page other than the dashboard", async ({
    page,
  }) => {
    // The handler lives in the app layout, not on the dashboard, so a shortcut
    // url pointing anywhere in scope behaves the same. (A future shortcut that
    // deep-links a specific page gets this for free.)
    await page.goto("/trends?quick=log-dose");

    await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
    // Stripping the param must preserve the path.
    await expectQuickParamCleared(page);
    expect(new URL(page.url()).pathname).toBe("/trends");
  });

  test("an unrecognized value opens nothing and still clears the param", async ({
    page,
  }) => {
    // A stale bookmark or a truncated share must NOT fall back to "log activity"
    // the way quickLogItem() does for the sheet — that would pop an editor the
    // user never asked for. It is a no-op, and the url stops advertising it.
    await page.goto("/?quick=not-a-real-shortcut");

    await expect(page.getByTestId("needs-attention")).toBeVisible();
    await expectQuickParamCleared(page);
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    await expect(page.getByTestId("activity-form")).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Search or run a command" })
    ).toHaveCount(0);
  });
});
