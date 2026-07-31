import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_BADGE,
  APP_BADGE_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The installed-PWA app-icon badge (issue #1424, section B).
//
// What this pins, and why it needs a browser: the badge is a client effect over a
// SERVER-rendered number. The pure tier can prove `appBadgeAction(0)` clears, and
// the chokepoint guard can prove the component is mounted on both hero branches —
// but only a real render proves the number reaching `navigator.setAppBadge` is
// the one the user is actually looking at, and only a real dismissal proves the
// badge comes OFF when the last item is resolved. A badge that sets but never
// clears is the failure mode this exists to catch: a "3" welded to a home-screen
// icon long after everything is done.
//
// The Badging API is stubbed via addInitScript (Chromium rejects the real call
// outside an installed app), recording every call so ORDER and ARGUMENTS are
// assertable, not just "something happened".
//
// Fixture hygiene (#868): this spec OWNS the App Badge fixture — a dedicated
// write-granted login on a bare profile whose entire care-tier set is the two
// age-derived preventive findings. It resets that profile's dismissals at test
// start, so every run (and every --repeat-each pass) begins from the same
// non-empty hero and can drive it to genuinely empty without touching a profile
// any other spec reads.

// A raw context from loginAs does NOT inherit the `mobile` project's `use` block,
// so the phone viewport has to be restated (dashboard-now.mobile.spec.ts's
// documented gotcha).
const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

type BadgeCall = { op: "set"; count?: number } | { op: "clear" };

function openDb(): Database.Database {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  return db;
}

// The one mutable precondition: this profile's suppressions. Cleared so the hero
// starts non-empty on every run.
function clearDismissals(): void {
  const db = openDb();
  try {
    db.prepare(
      `DELETE FROM upcoming_dismissals
        WHERE profile_id = (SELECT id FROM profiles WHERE name = ?)`
    ).run(APP_BADGE_PROFILE);
  } finally {
    db.close();
  }
}

// Stub the Badging API before any app script runs, recording the call log on the
// window. Chromium HAS setAppBadge but rejects it outside an installed app, so
// the real one would prove nothing about which value we asked for.
async function stubBadging(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: BadgeCall[] = [];
    (window as unknown as { __badgeCalls: BadgeCall[] }).__badgeCalls = calls;
    Object.defineProperty(navigator, "setAppBadge", {
      configurable: true,
      value: (count?: number) => {
        calls.push({ op: "set", count });
        return Promise.resolve();
      },
    });
    Object.defineProperty(navigator, "clearAppBadge", {
      configurable: true,
      value: () => {
        calls.push({ op: "clear" });
        return Promise.resolve();
      },
    });
  });
}

function badgeCalls(page: Page): Promise<BadgeCall[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __badgeCalls: BadgeCall[] }).__badgeCalls ?? []
  );
}

test.describe("app-icon badge", () => {
  test("mirrors the hero's Needs-attention count, then clears when the hero empties", async ({
    browser,
  }) => {
    clearDismissals();

    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_BADGE, password: E2E_MEMBER_PASSWORD },
      PHONE_CONTEXT
    );
    try {
      await stubBadging(page);
      await page.goto("/");

      // --- SET: the badge is the number on screen, not a number of its own. ---
      const countEl = page.getByTestId("attention-count");
      await expect(countEl).toBeVisible();
      const shown = Number((await countEl.textContent())?.trim());
      expect(shown).toBeGreaterThan(0);

      await expect(async () => {
        const calls = await badgeCalls(page);
        expect(calls).toContainEqual({ op: "set", count: shown });
      }).toPass({ timeout: 10_000, intervals: [200, 500, 1000] }); // topass-ok: the badge is a post-hydration effect with no POST to settle on, so there is nothing for settledClick/followLink to await

      // --- CLEAR: drive the hero to genuinely empty through the app's own
      // dismiss control, then prove the badge comes off. ---
      const hero = page.getByRole("main").getByTestId("needs-attention");
      const triggers = hero.getByRole("button", { name: "Snooze or dismiss" });

      // Dismiss until the hero has nothing left. Bounded so a regression that
      // stops actually dismissing fails on the assertion below rather than
      // spinning to the test timeout. The menu closes itself on submit (so the
      // menuitem detaches — settledClick can't be used here, same as
      // needs-attention-menu.spec.ts); the retrying count assertion is what
      // waits for the revalidated hero.
      for (let guard = 0; guard < 10; guard += 1) {
        const before = await triggers.count();
        if (before === 0) break;
        // Re-queried each pass: the hero re-renders after every dismissal, so
        // "the next one" is always the first remaining.
        await triggers
          .first() // first-ok: spec-owned fixture — rows are dismissed one at a time until none remain, so "first" is just "the next one"
          .click();
        await page
          .getByRole("menu")
          .getByRole("menuitem", { name: "Dismiss" })
          .click();
        // The menu closing is the action having RUN; the row count dropping is
        // the server having revalidated. The generous window is for `next dev`
        // (the local default), where a revalidate under parallel workers can
        // outrun the 5s default — CI runs a production build and settles fast.
        await expect(page.getByRole("menu")).toHaveCount(0);
        await expect(triggers).toHaveCount(before - 1, { timeout: 20_000 });
      }

      await expect(page.getByTestId("attention-all-clear")).toBeVisible();

      await expect(async () => {
        const calls = await badgeCalls(page);
        expect(calls.at(-1)).toEqual({ op: "clear" });
      }).toPass({ timeout: 10_000, intervals: [200, 500, 1000] }); // topass-ok: same post-hydration effect, now on the re-rendered all-clear branch
    } finally {
      await page.context().close();
      // Leave the fixture as we found it, so a later run starts non-empty even if
      // the seeder isn't re-run.
      clearDismissals();
    }
  });

  test("degrades silently when the browser has no Badging API", async ({
    browser,
  }) => {
    // Deliberately does NOT touch the fixture's dismissals and asserts nothing
    // about the count: it shares a profile with the test above, which spends its
    // life mutating exactly that state. Asserting only "the hero rendered and
    // nothing threw" keeps the two order-independent under local parallel
    // workers (CI runs workers:1, but a spec that only holds there is a trap).
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_BADGE, password: E2E_MEMBER_PASSWORD },
      PHONE_CONTEXT
    );
    try {
      // Firefox and iOS Safari simply don't have these. Removing them is the
      // honest simulation — the effect must no-op, not throw into the console and
      // not break the page it is mounted on.
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        // @ts-expect-error deleting an optional platform API for the test
        delete Navigator.prototype.setAppBadge;
        // @ts-expect-error deleting an optional platform API for the test
        delete Navigator.prototype.clearAppBadge;
      });

      await page.goto("/");
      await expect(page.getByTestId("needs-attention")).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });
});
