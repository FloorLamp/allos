import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// The rendered half of the #2615 census sweep. Both claims are about what a
// caregiver can READ off the household surface, so both are asserted on the text
// the page actually produces — never on a screenshot.
//
//   1. AVATAR INITIALS. "Riley (child)" rendered "R(" — the first character of the
//      second whitespace token, which is a bracket. The initials are `aria-hidden`
//      (the name is always beside them), so `avatar-initials` is how a test reads
//      them.
//   2. THE DUE-DOSE ROWS — RETIRED WITH THEIR SURFACE. A card listed the same
//      supplement twice at the same amount with two identical Confirm buttons, and
//      the fold that fixed it was asserted here. #1463 §1 removed the card's dose
//      rows outright (the card is a summary; Upcoming multi-view owns the action),
//      so the slot-naming and folding claims moved with the rows: they are pinned on
//      the Upcoming row in e2e/intake-short-labels.mobile.spec.ts and on
//      `planBandRender`'s own tests. Claim 1 is unaffected and stays here.

const DB_PATH = workerDbPath();

// Seeded by scripts/seed.ts — the parenthetical name the defect was found on.
const RILEY = "Riley (child)";

function rileyId(): number {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    const row = handle
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(RILEY) as { id: number } | undefined;
    if (!row) throw new Error(`${RILEY} is not seeded`);
    return row.id;
  } finally {
    handle.close();
  }
}

test("a parenthetical profile name does not put a bracket in its avatar (#2615)", async ({
  page,
}) => {
  // Admin reaches every profile, so the household page carries a card per profile.
  const profileId = rileyId();
  await page.goto("/household");
  const card = page.locator(
    `[data-testid="household-card"][data-profile-id="${profileId}"]`
  );
  await expect(card).toBeVisible();
  await expect(card).toContainText(RILEY);

  const initials = card.getByTestId("avatar-initials");
  await expect(initials).toHaveText("RC");
  // The defect, stated as the thing that must never come back.
  await expect(initials).not.toContainText("(");
});
