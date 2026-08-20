import { test, expect } from "./fixtures";
import { openGoalFact } from "./goal-form-helpers";
// The body-goal target must recompute when the metric switches (issue #631).
// Before the fix it was an uncontrolled input pre-filled once from the goal's
// stored value: editing a WEIGHT goal (e.g. 78 kg) and switching the metric to
// Resting HR left the `78` in the field, so a submit stored a weight-scale number
// as a 78 bpm target. The seed has a "Cut to 78 kg" body-weight goal; editing it
// and switching the metric must clear the field rather than carry the value.
//
// SINCE #3220 THE METRIC AND THE TARGET ARE TWO SEPARATE FACTS, each behind its own
// chip, so this spec routes through the chip row to reach them. The invariant is
// unchanged and so is what it protects — the value must not survive the switch.

test("editing a weight body-goal and switching the metric clears the target (issue #631)", async ({
  page,
}) => {
  await page.goto("/training?tab=goals");
  const main = page.getByRole("main");

  // Anchor on the goal card's own level-3 heading — the Goal pacing watch card
  // ("'Cut to 78 kg' is off pace…") also contains the text and sits earlier in
  // the DOM, so a bare hasText + first-match grabs the pacing card (which has no
  // "Goal actions" button).
  const card = main
    .locator("div.card")
    .filter({
      has: page.getByRole("heading", { name: "Cut to 78 kg", exact: true }),
    })
    .first(); // first-ok: filtered to the goal card by its own heading; .first() is defensive (see comment above)
  await expect(card).toBeVisible();

  // Open the goal's action menu (portaled OverflowMenu) → Edit.
  await card.getByRole("button", { name: "Goal actions" }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Edit" }).click();

  const form = page.getByTestId("goal-form");
  await expect(form).toBeVisible();

  // EDIT MODE READS BACK (#3220): the row states the stored goal as a sentence
  // before anything is opened, which is what makes the rest of this spec a check on
  // the SWITCH rather than on the prefill.
  await expect(form.getByTestId("goal-fact-subject")).toHaveText("Bodyweight");
  await expect(form.getByTestId("goal-fact-target")).toHaveText("78 kg");

  const target = page.locator("#goal-body-target");
  await openGoalFact(form, "target");
  await expect(target).toHaveValue("78");

  // Switch the metric to Resting HR — the target must clear so a bpm number can't
  // inherit the weight value. The three body metrics live in the SUBJECT editor
  // now: which metric this goal is about is what the goal is about.
  await openGoalFact(form, "subject");
  await form.getByRole("button", { name: "Resting HR" }).click();
  await openGoalFact(form, "target");
  await expect(target).toHaveValue("");

  // Switching back to Bodyweight recomputes the original derived target.
  await openGoalFact(form, "subject");
  await form.getByRole("button", { name: "Bodyweight" }).click();
  await openGoalFact(form, "target");
  await expect(target).toHaveValue("78");
});
