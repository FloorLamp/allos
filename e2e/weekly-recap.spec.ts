import { test, expect } from "./fixtures";
import { settledSelectSave } from "./helpers";
// Issue #32: the Weekly-recap dashboard card and a milestone Timeline entry.
// The e2e seed (e2e/seed-events.ts) pins a dashboard layout that makes the
// weekly-recap widget visible for profile 1 and plants a "50 workouts logged"
// milestone so both surfaces have deterministic content.
test.describe("Weekly recap + milestones (#32)", () => {
  test("dashboard shows the weekly-recap card with its seven-day window", async ({
    page,
  }) => {
    await page.goto("/");
    const recap = page.getByTestId("weekly-recap");
    await expect(recap).toBeVisible();
    await expect(
      recap.getByRole("heading", { name: "Weekly recap" })
    ).toBeVisible();
    // The seeded profile has recent activity, so the card renders summary rows
    // (not the empty-state nudge) — Workouts is always present when any workout
    // fell in the window.
    await expect(recap.getByText("Workouts")).toBeVisible();

    // #1218: the range renders through the login's date-format prefs
    // (recapRangeLabel → "Jul 3 – Jul 9"), never raw ISO ("2026-07-03 – …").
    const range = recap.getByTestId("weekly-recap-range");
    await expect(range).toBeVisible();
    await expect(range).toHaveText(
      /[A-Z][a-z]{2,} \d{1,2}(, \d{4})? – [A-Z][a-z]{2,} \d{1,2}(, \d{4})?/
    );
    await expect(range).not.toHaveText(/\d{4}-\d{2}-\d{2}/);

    // #1935: three rows were cut for failing the week-scale test. Volume was a
    // session fact aggregated whose percentage restated the workout count directly
    // above it; Calories compared one low-confidence estimate against another; and
    // Streak measured app engagement with a cliff, on a card the rest of the app
    // fills with rest-day and deload advice. The seeded profile has the strength
    // sessions and the recent activity that would have produced all three.
    await expect(recap.getByText("Volume", { exact: true })).toHaveCount(0);
    await expect(recap.getByText("Calories", { exact: true })).toHaveCount(0);
    await expect(recap.getByText("Streak", { exact: true })).toHaveCount(0);
    await expect(recap.getByText(/active days?$/)).toHaveCount(0);
  });

  // #2389 item 1, in the browser: the card renders the line's `value` and the ONE
  // shared annotation beside it, so a value carrying its own parenthetical put two
  // unrelated asides side by side on the row — "7 (strength 4, cardio 3) 5 last week".
  // The breakdown is now a declared note, which is what the reader sees here.
  test("the workouts row's value is the count alone, with the breakdown in its annotation", async ({
    page,
  }) => {
    await page.goto("/");
    const row = page
      .getByTestId("weekly-recap")
      .locator("dl > div")
      .filter({ hasText: "Workouts" });
    await expect(row).toHaveCount(1);

    // The value is the headline quantity and nothing else.
    await expect(row.locator("dd > span").first()).toHaveText(/^\d+$/); // first-ok: the row is narrowed to one above, and its dd's first span IS the value — the annotation is the second
    // The breakdown rides in the annotation, punctuated by the shared grammar.
    const cell = row.locator("dd");
    await expect(cell).toContainText(/strength \d/);
    await expect(cell).toContainText("last week");
    // And nothing on the row is parenthesised any more.
    await expect(cell).not.toContainText("(");
  });

  // A label may legitimately contain parentheses (an exercise variant names its
  // implement), so the guarantee is about the COMPOSITION: it never wraps an
  // annotation in a bracket of its own, at any line, whatever the content.
  test("no recap row nests one parenthetical inside another", async ({
    page,
  }) => {
    await page.goto("/");
    const rows = page.getByTestId("weekly-recap").locator("dl > div");
    for (const text of await rows.allInnerTexts()) {
      expect(text, text).not.toMatch(/\(\(|\)\)|\)\s*\(/);
    }
  });

  test("timeline surfaces the milestone entry under the Milestone filter", async ({
    page,
  }) => {
    await page.goto("/timeline?category=milestone");
    await expect(page.getByText("50 workouts logged").first()).toBeVisible(); // first-ok: asserts the milestone line renders — order-agnostic presence
    // The milestone badge labels the category on the card. Scoped to a feed entry:
    // the #1517 collapsed filter bar renders a (hidden) "Milestone · All dates"
    // summary label earlier in the DOM, which a page-wide first-match would grab —
    // the consolidation-class selector break. (Prose deliberately avoids spelling
    // out the locator call: the hygiene guard is a text scan and would count it.)
    await expect(
      page.locator('[id^="timeline-entry-"]').getByText("Milestone").first() // first-ok: asserts a Milestone badge renders on a feed entry — order-agnostic presence
    ).toBeVisible();
  });
});

// The recap CADENCE (#2178): one engine, three scales, and the setting that picks
// which one this profile's single recap slot speaks at.
//
// The precedence rule itself — replace, never stack, including the quarter-end Sunday
// where a week, a month and a quarter all close on one slot — is pinned in the pure
// tier (lib/__tests__/recap-scale.test.ts), where the calendar can be chosen rather
// than waited for. What only the browser can prove is that the control writes the
// setting and that the rendered card FOLLOWS it.
//
// BLAST RADIUS: it changes the recap cadence, then resets it to Weekly so the shared
// fixture is left as found.
test.describe("recap cadence (#2178)", () => {
  test("the cadence control re-labels the dashboard card", async ({ page }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    // Weekly is the default and the card says so.
    await page.goto("/");
    await expect(
      page.getByTestId("weekly-recap").getByRole("heading", {
        name: "Weekly recap",
      })
    ).toBeVisible();

    await page.goto("/settings/notifications");
    const kindsCard = page.getByTestId("notification-kinds");
    await expect(kindsCard).toBeVisible();

    const cadence = page.getByTestId("kind-scale-weekly-recap");
    // Three cadences, no fourth: the annual retrospective is a different artifact
    // (#2179), deliberately not a tier of this control.
    await expect(cadence.getByRole("option")).toHaveText([
      "Weekly recap",
      "Monthly recap",
      "Quarterly recap",
    ]);
    await expect(cadence).toHaveValue("week");

    await settledSelectSave(page, cadence, "month", kindsCard);
    await page.reload();
    await expect(page.getByTestId("kind-scale-weekly-recap")).toHaveValue(
      "month"
    );

    // The card follows the setting — same engine, a longer period, a different name.
    await page.goto("/");
    const recap = page.getByTestId("weekly-recap");
    await expect(
      recap.getByRole("heading", { name: "Monthly recap" })
    ).toBeVisible();
    await expect(
      recap.getByRole("heading", { name: "Weekly recap" })
    ).toHaveCount(0);

    // Leave the shared fixture as found.
    await page.goto("/settings/notifications");
    await settledSelectSave(
      page,
      page.getByTestId("kind-scale-weekly-recap"),
      "week",
      page.getByTestId("notification-kinds")
    );
  });
});
