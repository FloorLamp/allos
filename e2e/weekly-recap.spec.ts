import { test, expect } from "./fixtures";
// Issue #32: the milestone entry on the record. The e2e seed plants recap input plus
// a "50 workouts logged" milestone; the recap half of this file's subject left Home
// with #5435 §4, so what is exercised here is the milestone's own surface.
test.describe("Weekly recap + milestones (#32)", () => {
  // THE RECAP BLOCK LEFT HOME FOR HISTORY (#5435 §4).
  //
  // Two cases stood here. The first asserted that the workouts row's VALUE is the count
  // alone — "4", never "4 (3 strength, 1 ride)" — with the breakdown in the row's
  // annotation beside it. The second swept every recap row for a parenthetical nested
  // inside another, the punctuation defect #3365 left behind when six cards became one
  // block. Both were read off `/`, and §4 retires the weekly recap lines from Home.
  //
  // WHAT RETIRED WITH THEM: the value/annotation split and the punctuation sweep as
  // browser claims about `/`. What did not: the composition itself —
  // `lib/recap.ts`/`lib/recap-scale.ts` and `getRecapCard`, with their own tests — and
  // the milestone entry's own surface, which is the case that remains in this file.

  // A label may legitimately contain parentheses (an exercise variant names its
  // implement), so the guarantee is about the COMPOSITION: it never wraps an
  // annotation in a bracket of its own, at any line, whatever the content.
  // THE RECAP BLOCK LEFT HOME FOR HISTORY (#5435 §4).
  //
  // Two cases stood here. The first asserted that the workouts row's VALUE is the count
  // alone — "4", never "4 (3 strength, 1 ride)" — with the breakdown in the row's
  // annotation beside it. The second swept every recap row for a parenthetical nested
  // inside another, the punctuation defect #3365 left behind when six cards became one
  // block. Both were read off `/`, and §4 retires the weekly recap lines from Home.
  //
  // WHAT RETIRED WITH THEM: the value/annotation split and the punctuation sweep as
  // browser claims about `/`. What did not: the composition itself —
  // `lib/recap.ts`/`lib/recap-scale.ts` and `getRecapCard`, with their own tests — and
  // the milestone entry's own surface, which is the case that remains in this file.

  test("timeline surfaces the milestone entry under the Milestone filter", async ({
    page,
  }) => {
    await page.goto("/history?kind=milestone");
    await expect(page.getByText("50 workouts logged").first()).toBeVisible(); // eslint-disable-line no-restricted-properties -- first-ok: asserts the milestone line renders — order-agnostic presence
    // THE CATEGORY IS ON THE ROW, NOT IN A BADGE. `/timeline` printed a "Milestone"
    // label on every card; the record's rows are one line at every viewport (#3958),
    // so the kind is the leading glyph and the machine-readable attribute — which is
    // the stable thing to assert anyway. Asserted on the row that carries the recap's
    // own milestone, so this cannot pass on some other kind's row.
    await expect(
      // eslint-disable-next-line no-restricted-properties -- first-ok: the recap fixture's own milestone line — deterministic
      page
        .getByTestId("history-row")
        .filter({ hasText: "50 workouts logged" })
        .first()
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
