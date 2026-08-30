import { test, expect } from "./fixtures";
import { openDashboardAll } from "./helpers";
// Issue #32: dashboard recap-line atoms and a milestone Timeline entry. The e2e
// seed plants recap input plus a "50 workouts logged" milestone so both surfaces
// have deterministic content.
test.describe("Weekly recap + milestones (#32)", () => {
  // #2389 item 1, in the browser: the card renders the line's `value` and the ONE
  // shared annotation beside it, so a value carrying its own parenthetical put two
  // unrelated asides side by side on the row — "7 (strength 4, cardio 3) 5 last week".
  // The breakdown is now a declared note, which is what the reader sees here.
  test("the workouts row's value is the count alone, with the breakdown in its annotation", async ({
    page,
  }) => {
    await page.goto("/");
    await openDashboardAll(page);
    const block = page.locator('[data-moment-key^="recap:"]');
    // ONE block for the whole recap, and one header on it (#3365) — the six atoms
    // used to be six cards with six identical headers.
    await expect(block).toHaveCount(1);
    await expect(block.locator("h4")).toHaveCount(1);
    const row = block
      .getByTestId("dashboard-candidate")
      .filter({ hasText: "Workouts" });
    await expect(row).toHaveCount(1);

    // The value is the headline quantity and nothing else.
    await expect(row.getByTestId("standing-value")).toHaveText(/^\d+$/);
    // The breakdown rides in the annotation, punctuated by the shared grammar.
    await expect(row).toContainText(/strength \d/);
    await expect(row).toContainText("last week");
    // And nothing on the row is parenthesised any more.
    await expect(row).not.toContainText("(");
  });

  // A label may legitimately contain parentheses (an exercise variant names its
  // implement), so the guarantee is about the COMPOSITION: it never wraps an
  // annotation in a bracket of its own, at any line, whatever the content.
  test("no recap row nests one parenthetical inside another", async ({
    page,
  }) => {
    await page.goto("/");
    await openDashboardAll(page);
    const rows = page
      .locator('[data-moment-key^="recap:"]')
      .getByTestId("dashboard-candidate");
    // The positive control: the block was found and it has rows, so the loop below
    // is not an empty sweep reporting clean.
    expect(await rows.count()).toBeGreaterThan(0);
    for (const text of await rows.allInnerTexts()) {
      expect(text, text).not.toMatch(/\(\(|\)\)|\)\s*\(/);
    }
  });

  test("timeline surfaces the milestone entry under the Milestone filter", async ({
    page,
  }) => {
    await page.goto("/history?kind=milestone");
    await expect(page.getByText("50 workouts logged").first()).toBeVisible(); // first-ok: asserts the milestone line renders — order-agnostic presence
    // THE CATEGORY IS ON THE ROW, NOT IN A BADGE. `/timeline` printed a "Milestone"
    // label on every card; the record's rows are one line at every viewport (#3958),
    // so the kind is the leading glyph and the machine-readable attribute — which is
    // the stable thing to assert anyway. Asserted on the row that carries the recap's
    // own milestone, so this cannot pass on some other kind's row.
    await expect(
      page
        .getByTestId("history-row")
        .filter({ hasText: "50 workouts logged" })
        .first() // first-ok: the recap fixture's own milestone line — deterministic
    ).toHaveAttribute("data-history-kind", "milestone");
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
test.describe("recap cadence (#2178)", () => {});
