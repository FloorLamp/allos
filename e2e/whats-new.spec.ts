import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { followLink, hydratedClick } from "./helpers";
import { E2E_LOGIN_WHATSNEW, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import {
  WHATS_NEW_PAGE_ENTRIES,
  loadReleaseNotes,
  pullRequestUrl,
  releaseNotesPage,
  type ReleaseNoteEntry,
} from "../lib/release-notes";
import { workerDbPath } from "./worker-env";

// Issue #1421 — the bundled "What's new" page and its per-login unread dot.
//
// Content assertions read the SAME checked-in lib/release-notes.json the page does
// (the disclaimer spec's pattern), so curating a new release wave doesn't break this
// spec — only removing the surface does.
//
// The fixture is a DEDICATED member login (#868) whose seen-marker this spec clears
// in beforeEach: the marker is login-scoped, so a --repeat-each iteration would
// otherwise inherit the one the previous iteration wrote, and driving it on the
// shared admin session would flip the dot for every other spec.

const DB_PATH = workerDbPath();

const NOTES = loadReleaseNotes();
const NEWEST_DAY = NOTES.days[0];

// Every distinct PR in `entries` draws exactly one link per bullet it has, each
// pointing at that PR. Shared by the newest-day pass and the repeat proof below.
async function expectPrLinks(
  day: Locator,
  entries: readonly ReleaseNoteEntry[]
): Promise<void> {
  const prCounts = new Map<number, number>();
  for (const entry of entries) {
    prCounts.set(entry.pr, (prCounts.get(entry.pr) ?? 0) + 1);
  }
  for (const [pr, expectedCount] of prCounts) {
    const links = day.getByRole("link", { name: `#${pr}`, exact: true });
    await expect(links).toHaveCount(expectedCount);
    for (let i = 0; i < expectedCount; i++) {
      await expect(links.nth(i)).toHaveAttribute("href", pullRequestUrl(pr));
    }
  }
}

// The first day, on the first page that renders it WHOLE, where one PR carries
// more than one bullet. Read from the same checked-in file the page reads, and
// resolved per PAGE rather than per day because a day can straddle the page
// bound — half a day's entries would give half the links and a false red.
const repeat = (() => {
  const pageCount = releaseNotesPage(NOTES, 1).pageCount;
  for (let n = 1; n <= pageCount; n++) {
    for (const day of releaseNotesPage(NOTES, n).days) {
      const counts = new Map<number, number>();
      for (const entry of day.entries) {
        counts.set(entry.pr, (counts.get(entry.pr) ?? 0) + 1);
      }
      if ([...counts.values()].some((c) => c > 1)) {
        return { page: n, date: day.date, entries: day.entries };
      }
    }
  }
  return null;
})();

function clearSeenMarker(): void {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `DELETE FROM login_settings
        WHERE key = 'whats_new_seen_date'
          AND login_id = (SELECT id FROM logins WHERE username = ?)`
    ).run(E2E_LOGIN_WHATSNEW);
  } finally {
    db.close();
  }
}

test.describe("in-app release notes (#1421)", () => {
  test.beforeEach(() => clearSeenMarker());

  test("the page renders the bundled notes and the running build", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_WHATSNEW,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/whats-new");
      await expect(
        page.getByRole("heading", { name: "What's new" })
      ).toBeVisible();

      // "What am I running" lives with "what's new": either a 7-char hash or the
      // explicit unknown fallback when neither COMMIT_SHA nor git can answer.
      await expect(page.getByTestId("whats-new-version")).toHaveText(
        /^[0-9a-f]{7}$|^unknown$/
      );

      // The page is BOUNDED (#2528): one page of entries, never the whole
      // append-only file. The count comes from the checked-in file (not a shared DB
      // row), so an exact count is safe here.
      const entries = page.getByTestId("whats-new-entry");
      const first = releaseNotesPage(NOTES, 1);
      await expect(entries).toHaveCount(first.shown);
      expect(first.shown).toBeLessThanOrEqual(WHATS_NEW_PAGE_ENTRIES);

      // Days are newest-first, and the newest day's entries carry their title, body
      // and a link to the PR they came from.
      const days = page.getByTestId("whats-new-day");
      await expect(days.nth(0)).toHaveAttribute("data-date", NEWEST_DAY.date);
      // The newest day may itself be split by the page bound, so assert over the
      // entries page 1 actually carries for it.
      for (const entry of first.days[0].entries) {
        await expect(days.nth(0)).toContainText(entry.title);
      }
      // Every PR on the newest day draws exactly as many links as it has bullets.
      // Assert over the DISTINCT PRs: a per-entry locator goes strict-mode
      // ambiguous the moment one PR carries two, which is a violation rather than
      // a failure. Counts come from the fixture, so dropping one link cannot pass
      // as long as another remains.
      await expectPrLinks(days.nth(0), first.days[0].entries);

      // Older notes stay reachable rather than dropped: the pager says how much
      // history there is and walks to it.
      const pager = page.getByTestId("whats-new-pagination");
      await expect(pager).toContainText(`of ${first.total}`);
      if (first.pageCount > 1) {
        // hydratedClick, not followLink: a pager's Next is a RELATIVE navigation, so
        // a retried click would walk to page 3 instead of re-asserting page 2.
        await hydratedClick(page, pager.getByRole("link", { name: "Next" }));
        await page.waitForURL(/\/whats-new\?page=2$/);
        const second = releaseNotesPage(NOTES, 2);
        await expect(page.getByTestId("whats-new-entry")).toHaveCount(
          second.shown
        );
        await expect(page.getByTestId("whats-new-day").nth(0)).toHaveAttribute(
          "data-date",
          second.days[0].date
        );
        await page.goto("/whats-new");
      }

      // ONE PR CAN CARRY TWO BULLETS (#4116), PROVEN ON WHICHEVER DAY ACTUALLY
      // CARRIES ONE. A PR that closes two unrelated issues gets one bullet each —
      // #4034 shipped the equipment picker and haptics together — so `#4034`
      // resolves to two links, and the renderer drawing only one is the defect
      // this proves against.
      //
      // It used to be asserted on the NEWEST day, which made it a claim about
      // today's curation rather than about the renderer: the 2026-08-30 batch is
      // 29 bullets with every PR distinct, and it turned this case red without
      // touching a line of product code. This file's own header promises the
      // opposite ("curating a new release wave doesn't break this spec"), so the
      // proof now finds the day and walks to its page.
      //
      // If the checked-in file ever carries NO repeat at all, `repeat` is null and
      // the expect below fails loudly — the case is unavailable, which is worth
      // knowing, rather than quietly passing on nothing.
      expect(
        repeat,
        "lib/release-notes.json carries no PR with two bullets on one page, so the repeat case cannot be exercised"
      ).not.toBeNull();
      if (repeat) {
        if (repeat.page !== 1)
          await page.goto(`/whats-new?page=${repeat.page}`);
        const day = page.locator(
          `[data-testid="whats-new-day"][data-date="${repeat.date}"]`
        );
        await expect(day).toHaveCount(1);
        await expectPrLinks(day, repeat.entries);
        if (repeat.page !== 1) await page.goto("/whats-new");
      }

      // Operator notes render in their own callout, not mixed into the entry list.
      // Scoped to the newest DAY's section: the callout renders once per day that
      // carries notes, so a page-wide locator goes strict-mode ambiguous the moment
      // two days have them (which batch 4 of 2026-07-25 made true).
      if (NEWEST_DAY.operatorNotes.length > 0) {
        const callout = days.nth(0).getByTestId("whats-new-operator-notes");
        await expect(callout).toBeVisible();
        for (const note of NEWEST_DAY.operatorNotes) {
          await expect(callout).toContainText(note);
        }
      }
    } finally {
      await page.close();
    }
  });

  test("the unread dot shows for a login that hasn't looked, and clears on the visit", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_WHATSNEW,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/settings");
      // Both entry points render for a login with unseen notes: the shared sidebar
      // footer (one per viewport — the mobile drawer isn't mounted) and the Settings
      // footer beside the version. Exact counts, because both are this page's own.
      await expect(page.getByTestId("whats-new-link")).toHaveCount(2);
      await expect(page.getByTestId("whats-new-dot")).toHaveCount(2);

      // Either link is fine — both are this page's own and target the same route,
      // so the index carries no row-identity meaning (nth(0) is the sidebar's).
      await followLink(
        page,
        page.getByTestId("whats-new-link").nth(0),
        /\/whats-new$/
      );
      await expect(
        page.getByRole("heading", { name: "What's new" })
      ).toBeVisible();

      // Visiting IS the dismissal: the page marks the notes seen for this login and
      // revalidates the shell, so the sidebar dot clears in place (the retrying
      // expect is the wait for that round trip).
      await expect(page.getByTestId("whats-new-dot")).toHaveCount(0);

      // …and it stays cleared on a fresh server render of both entry points.
      await page.goto("/settings");
      await expect(page.getByTestId("whats-new-link")).toHaveCount(2);
      await expect(page.getByTestId("whats-new-dot")).toHaveCount(0);
    } finally {
      await page.close();
    }
  });
});
