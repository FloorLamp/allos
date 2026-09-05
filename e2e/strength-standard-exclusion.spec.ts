import { test, expect } from "./fixtures";
// #1922: a machine lift is excluded from the free-weight strength standards, and
// the Analyze panel now says SO rather than omitting the level badge in silence.
//
// The silence is what the issue's audit blames for the free-text workaround: a
// lifter who sees no level concludes the app wants a different NAME, types
// "Overhead Press" for a machine press, and earns a barbell standing they did not
// perform. Explaining the omission removes the incentive without refusing anything
// (#798 — informational, never blocking).
//
// The seeded adult (profile 1) has a Leg Press history, which is exactly the case:
// a catalogued machine movement that no barbell population table covers. The
// standards-gap logic itself is pinned exhaustively in
// lib/__tests__/strength-standards.test.ts; this asserts the panel renders it.

test("the Analyze panel explains why a machine lift has no level (#1922)", async ({
  page,
}) => {
  await page.goto("/training?tab=analyze&kind=strength&item=Leg%20Press");

  const main = page.getByRole("main");
  // The panel is showing the machine lift…
  await expect(main.getByText("Leg Press").first()).toBeVisible(); // eslint-disable-line no-restricted-properties -- first-ok: asserts the selected lift is on screen — order-agnostic presence
  // …with no Benchmarks ladder, because no barbell table covers it…
  await expect(main.getByText("Benchmarks", { exact: true })).toHaveCount(0);
  // …and the reason stated, instead of nothing at all.
  await expect(main.getByText(/free-weight norms/)).toBeVisible();
  await expect(main.getByText(/machine lifts/)).toBeVisible();
});

test("a covered free-weight lift still shows its level, unexplained (#1922)", async ({
  page,
}) => {
  // The control: the note is scoped to the machine case, so a lift that DOES place
  // shows its ladder and carries no exclusion copy. Without this, the assertions
  // above would pass on a page that printed the note everywhere.
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");

  const main = page.getByRole("main");
  await expect(main.getByText("Benchmarks", { exact: true })).toBeVisible();
  await expect(main.getByText(/free-weight norms/)).toHaveCount(0);
});
