import { test, expect } from "@playwright/test";

// Protein adequacy on /nutrition (issue #767). The seeded profile (scripts/seed.ts) has
// ~2 weeks of food-group servings and a weight history but NO integration protein_g, so
// the card renders over the ESTIMATED basis: a floor from logged foods vs a goal-scaled
// g/kg target band. Read-only — asserts the card + its load-bearing caveats.
//
// Value->presence (one-question-one-computation): the floor/target GRAMS are pinned
// by lib/__tests__/protein.test.ts / protein-today.test.ts and the builder by
// lib/__db_tests__/protein-adequacy-builder.test.ts. This spec asserts the card's
// basis + caveat SHAPE (floor wording, g/kg + g/day units, informational framing),
// never the computed gram numbers.

test("the protein-adequacy card shows an estimated floor vs a goal-scaled band (#767)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  const card = page.getByTestId("protein-adequacy");
  await expect(card).toBeVisible();

  // No tracked protein in the seed → the estimated (floor) basis.
  await expect(card).toHaveAttribute("data-basis", "estimated");

  // The intake line is stated as a FLOOR from logged foods — never a precise/authoritative
  // number (the whole point of #767's honest wording).
  const intake = page.getByTestId("protein-intake");
  await expect(intake).toContainText(/floor/i);
  await expect(intake).toContainText(/logged foods/i);
  await expect(intake).toContainText(/g\/day/i);

  // The target is a goal-scaled g/kg band.
  const target = page.getByTestId("protein-target");
  await expect(target).toContainText(/g\/kg/i);
  await expect(target).toContainText(/g\/day/i);

  // And the card carries the informational, not-prescriptive framing.
  await expect(card).toContainText(/informational/i);
});
