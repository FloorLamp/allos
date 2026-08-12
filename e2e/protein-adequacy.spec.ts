import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { frozenNow, workerDbPath } from "./worker-env";
// Protein adequacy on /nutrition (issue #767). The seeded profile (scripts/seed.ts) has
// ~2 weeks of food-group servings and a weight history but NO tracked protein, so
// the card renders over the ESTIMATED basis: a floor from logged foods vs a goal-scaled
// g/kg target band. Asserts the card + its load-bearing caveats.
//
// Value->presence (one-question-one-computation): the floor/target GRAMS are pinned
// by lib/__tests__/protein.test.ts / protein-today.test.ts and the builder by
// lib/__db_tests__/protein-adequacy-builder.test.ts. This spec asserts the card's
// basis + caveat SHAPE (floor wording, g/kg + g/day units, informational framing),
// never the computed gram numbers.
//
// IT OWNS ITS PRECONDITION, because its precondition is an ABSENCE (#767's estimated
// basis means "nothing tracked today"), and an absence is the one fixture state another
// spec can destroy just by doing its job. `offline-food-log.spec.ts` quick-adds 30g of
// protein to this same profile for this same day and — correctly, it is testing
// durability — leaves the row behind. Whichever of the two runs second used to decide
// whether this one saw `estimated` or `combined`.
//
// It never bit while `--shard` split by test COUNT, which happened to keep the two in
// different shards and therefore different worker databases. #2590's duration-balanced
// planner reshuffled the buckets, they landed on one worker, and this went red on three
// unrelated PRs at once. The sharding change did not break it; it removed the accident
// that was hiding it. So the fix is HERE: clear the day's tracked protein first, which
// makes the assertion independent of what else shares the worker and of the order the
// planner happens to pick. Read-only otherwise.
function clearTrackedProteinToday(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare("DELETE FROM protein_log WHERE profile_id = 1 AND date = ?").run(
      frozenNow().toISOString().slice(0, 10)
    );
  } finally {
    db.close();
  }
}

test("the protein-adequacy card shows an estimated floor vs a goal-scaled band (#767)", async ({
  page,
}) => {
  clearTrackedProteinToday();
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
});
