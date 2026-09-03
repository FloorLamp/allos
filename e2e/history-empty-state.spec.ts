import { test, expect } from "./fixtures";
import { loginAs, followLink } from "./nav";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TL_EMPTY } from "./fixture-logins";

// A deep-past day (the #1511 relative-or-deep-past rule) used only to prove that a
// DATE WINDOW is a filter like a category pill. Nothing is seeded on it — nothing is
// seeded on this profile at all.
const A_QUIET_DAY = "2026-01-18";

// The record's base empty state names a next action (issue #1410).
//
// A brand-new account landing here used to be told "No timeline events yet." and
// nothing else — the app's own good empty states name the next action.
// The two cases this spec separates are
// the whole design: an EMPTY ACCOUNT is fixed by putting data in, a FILTERED feed is
// fixed by widening the filter, and offering "log an activity" to someone who just
// clicked the Immunization pill would be answering a question they didn't ask.
//
// Fixture hygiene (#868): a DEDICATED login over a DEDICATED profile that holds
// nothing at all (e2e/seed/history.ts — seedTimelineEmpty). "Empty" is not a state
// any shared-seed profile can be put into, and a spec must not delete its way there.
// Read-only throughout, so the profile is still empty for the next --repeat-each
// pass.

test.describe("the record's base empty state (#1410)", () => {
  test("an empty account is offered the doors the record fills from", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TL_EMPTY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/history");
      const empty = page.getByTestId("history-empty");
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("Nothing recorded yet.");

      // Several distinct sources, not one arbitrary CTA: something you did, something
      // you measured, something a clinic gave you.
      const actions = empty.getByRole("link");
      await expect(actions).toHaveCount(3);
      await expect(actions).toHaveText([
        /Log an activity/,
        /Add a body metric/,
        /Import a document/,
      ]);

      // Each one actually lands somewhere — a next action that 404s is worse than no
      // next action. (Typed AppRoute hrefs make a dead pathname a build error; this
      // proves the built links navigate.)
      await followLink(
        page,
        empty.getByRole("link", { name: "Log an activity" }),
        /\/training/
      );
      await page.goto("/history");
      await followLink(
        page,
        page.getByTestId("history-empty").getByRole("link", {
          name: "Add a body metric",
        }),
        /\/trends/
      );
      await page.goto("/history");
      await followLink(
        page,
        page.getByTestId("history-empty").getByRole("link", {
          name: "Import a document",
        }),
        /\/data/
      );
    } finally {
      await page.context().close();
    }
  });

  test("a filtered feed keeps the bare message — the fix there is the filter", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TL_EMPTY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // A kind chip: the message stays bare and offers no next action.
      await page.goto("/history?kind=activity");
      const filtered = page.getByTestId("history-empty-filtered");
      await expect(filtered).toBeVisible();
      await expect(filtered).toContainText("Nothing recorded here yet.");
      await expect(filtered.getByRole("link")).toHaveCount(0);
      await expect(page.getByTestId("history-empty")).toHaveCount(0);

      // A date window is a filter too — same reasoning, same bare message.
      await page.goto(`/history?day=${A_QUIET_DAY}`);
      const ranged = page.getByTestId("history-empty-filtered");
      await expect(ranged).toBeVisible();
      await expect(ranged.getByRole("link")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  // ── AN EMPTY DAY NAMES ITS DAY (#4918 defects 1 and 4 of the frame) ──────────
  //
  // This is the exact screenshot: a day view with nothing on it. Its only date text
  // was the per-group sticky header, which renders ONCE PER GROUP OF ROWS — so a day
  // with no rows named no day at all, and the largest thing on the page was a `p-10`
  // dashed box. The name is the day bar's now, count included, and the box is compact
  // and says what it is about.
  //
  // THE PAST DAY AND TODAY ARE TWO CASES because the copy differs, and today is
  // reached through a future `?day=` that clamps rather than through a date literal —
  // the profile-local today is not the run's UTC date under the suite's rotating pin.
  test("an empty day is named in the bar, with a compact message about the rows", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TL_EMPTY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto(`/history?day=${A_QUIET_DAY}`);
      const name = page.getByTestId("timeline-day-name");
      await expect(name).toBeVisible();
      // "0 records", not "no records": the same grammar a day WITH rows prints, so
      // the count is the day's own and the empty case is not a second sentence.
      await expect(name).toHaveText(/^.+ — 0 records$/);
      // The retired header and its self-linking chevron are gone from this view.
      await expect(page.getByTestId("history-day-link")).toHaveCount(0);
      await expect(page.getByTestId("history-empty-filtered")).toHaveText(
        "No entries."
      );

      // …and the page's own subtitle, which describes the FEED, is not on the day
      // view above the day's name.
      await expect(page.locator("main")).not.toContainText(
        "Everything recorded, newest first."
      );

      await page.goto("/history?day=2099-01-01");
      await expect(page.getByTestId("timeline-day-name")).toHaveText(
        /^.+ — 0 records$/
      );
      await expect(page.getByTestId("history-empty-filtered")).toHaveText(
        "No entries yet today."
      );

      // THE CONVERSE, on the page that still owns both: the feed keeps its subtitle
      // and its day-header door. A guard that only asserted the day view's absences
      // would be green on a tree that had lost them everywhere.
      await page.goto("/history");
      await expect(page.locator("main")).toContainText(
        "Everything recorded, newest first."
      );
      await expect(page.getByTestId("timeline-day-name")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
