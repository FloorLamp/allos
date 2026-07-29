import { test, expect } from "./fixtures";
import { loginAs, followLink } from "./nav";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TL_EMPTY } from "./fixture-logins";

// A deep-past day (the #1511 relative-or-deep-past rule) used only to prove that a
// DATE WINDOW is a filter like a category pill. Nothing is seeded on it — nothing is
// seeded on this profile at all.
const A_QUIET_DAY = "2026-01-18";

// The Timeline's base empty state names a next action (issue #1410).
//
// A brand-new account landing on the Timeline used to be told "No timeline events
// yet." and nothing else — the app's own good empty states (WidgetEmpty,
// StrengthExplorer) all name the next action. The two cases this spec separates are
// the whole design: an EMPTY ACCOUNT is fixed by putting data in, a FILTERED feed is
// fixed by widening the filter, and offering "log an activity" to someone who just
// clicked the Immunization pill would be answering a question they didn't ask.
//
// Fixture hygiene (#868): a DEDICATED login over a DEDICATED profile that holds
// nothing at all (e2e/seed/timeline.ts — seedTimelineEmpty). "Empty" is not a state
// any shared-seed profile can be put into, and a spec must not delete its way there.
// Read-only throughout, so the profile is still empty for the next --repeat-each
// pass.

test.describe("timeline base empty state (#1410)", () => {
  test("an empty account is offered the doors its timeline fills from", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TL_EMPTY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/timeline");
      const empty = page.getByTestId("timeline-empty");
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("No timeline events yet.");

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
      await page.goto("/timeline");
      await followLink(
        page,
        page.getByTestId("timeline-empty").getByRole("link", {
          name: "Add a body metric",
        }),
        /\/trends/
      );
      await page.goto("/timeline");
      await followLink(
        page,
        page.getByTestId("timeline-empty").getByRole("link", {
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
      // A category pill: the message names the category and offers no next action.
      await page.goto("/timeline?category=activity");
      const filtered = page.getByTestId("timeline-empty-filtered");
      await expect(filtered).toBeVisible();
      await expect(filtered).toContainText("No activity events yet.");
      await expect(filtered.getByRole("link")).toHaveCount(0);
      await expect(page.getByTestId("timeline-empty")).toHaveCount(0);

      // A date window is a filter too — same reasoning, same bare message.
      await page.goto(`/timeline?from=${A_QUIET_DAY}&to=${A_QUIET_DAY}`);
      const ranged = page.getByTestId("timeline-empty-filtered");
      await expect(ranged).toBeVisible();
      await expect(ranged.getByRole("link")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
