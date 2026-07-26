import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { followLink } from "./helpers";
import { E2E_LOGIN_WHATSNEW, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { loadReleaseNotes, pullRequestUrl } from "../lib/release-notes";
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

      // Every bundled entry renders. The count comes from the checked-in file (not a
      // shared DB row), so an exact count is safe here.
      const entries = page.getByTestId("whats-new-entry");
      const total = NOTES.days.reduce((n, d) => n + d.entries.length, 0);
      await expect(entries).toHaveCount(total);

      // Days are newest-first, and the newest day's entries carry their title, body
      // and a link to the PR they came from.
      const days = page.getByTestId("whats-new-day");
      await expect(days.nth(0)).toHaveAttribute("data-date", NEWEST_DAY.date);
      for (const entry of NEWEST_DAY.entries) {
        await expect(days.nth(0)).toContainText(entry.title);
        await expect(
          days.nth(0).getByRole("link", { name: `#${entry.pr}`, exact: true })
        ).toHaveAttribute("href", pullRequestUrl(entry.pr));
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
