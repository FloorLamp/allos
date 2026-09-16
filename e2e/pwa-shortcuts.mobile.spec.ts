import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { QUICK_PARAM } from "@/lib/pwa-shortcuts";
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
// history.replaceState, not a server write.

// The handler strips `?quick=` synchronously with history.replaceState once its
// effect runs. Wait for the handler's own effect marker to name the exact value it
// consumed, then read the browser's live location. page.url() is a Playwright-side
// cache whose same-document update notification can lag under shard load (#1992).
//
// `opened` is the SECOND half of that marker (#5922) and is asserted with the first,
// because consuming a value and opening its surface are two questions and this suite
// used to ask only one. `""` means the value was consumed and nothing opened.
//
// WHAT THIS SUITE STILL CANNOT SEE. Every worker's server here is `next start` with
// NODE_ENV=production (e2e/fixtures.ts), so React effects run once. `next dev` turns
// on StrictMode and runs them twice, and #5922 was a teardown that landed between the
// two passes — invisible to a browser suite by construction, which is why five green
// `goto("/?quick=log-stool")` call sites in bristol-stool.spec.ts coexisted with a
// deep link that opened nothing for a person. That half is pinned one tier down, in
// components/__tests__/quick-entry-last-good.test.tsx.
async function expectQuickParamCleared(
  page: Page,
  expected: string,
  opened: string
): Promise<void> {
  const marker = page.getByTestId("quick-shortcut-handler");
  await expect(marker).toHaveAttribute("data-consumed", expected);
  await expect(marker).toHaveAttribute("data-opened", opened);
  const quick = await page.evaluate(
    (param) => new URL(window.location.href).searchParams.get(param),
    QUICK_PARAM
  );
  expect(quick).toBeNull();
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
    // back-navigation doesn't re-pop the editor over work in progress.
    await expectQuickParamCleared(page, "log-activity", "activity");
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
    await expectQuickParamCleared(page, "log-dose", "overlay:dose");
  });

  test("search opens the command palette", async ({ page }) => {
    await page.goto("/?quick=search");

    // Same palette the ⌘K shortcut and the mobile bar's magnifier open
    // (openGlobalSearch) — no second search surface.
    await expect(
      page.getByRole("combobox", { name: "Search or run a command" })
    ).toBeVisible();
    await expectQuickParamCleared(page, "search", "search");
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
    await expectQuickParamCleared(page, "log-dose", "overlay:dose");
    expect(new URL(page.url()).pathname).toBe("/trends");
  });

  test("an unrecognized value is consumed and SAYS it opened nothing", async ({
    page,
  }) => {
    // A stale bookmark or a truncated share. `shortcutAction` is strict on purpose —
    // popping an editor nobody asked for would be worse — so the right outcome is the
    // dashboard, unchanged. What #5922 added is that the handler states that outcome
    // instead of leaving "the param vanished and nothing happened" to be inferred.
    await page.goto("/?quick=not-a-shortcut");

    await expectQuickParamCleared(page, "not-a-shortcut", "");
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0); // testid-scope-ok: the quick-entry sheet portals to <body> (BottomSheet), one copy
    await expect(page.getByTestId("activity-form")).toHaveCount(0); // testid-scope-ok: the activity editor portals to <body>, one copy
  });
});
