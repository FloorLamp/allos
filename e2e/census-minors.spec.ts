import { test, expect } from "./fixtures";
import { type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { workerDbPath } from "./worker-env";

// The rendered half of the #2615 census sweep. Both claims are about what a
// caregiver can READ off the household surface, so both are asserted on the text
// the page actually produces — never on a screenshot.
//
//   1. AVATAR INITIALS. "Riley (child)" rendered "R(" — the first character of the
//      second whitespace token, which is a bracket. The initials are `aria-hidden`
//      (the name is always beside them), so `avatar-initials` is how a test reads
//      them.
//   2. THE DUE-DOSE ROWS. A card listed the same supplement twice at the same
//      amount with two identical Confirm buttons — the morning and the evening
//      dose, with nothing on either row saying which. And the list ran unrolled to
//      a dozen rows while the page-side equivalent folded.
//
// SPEC-OWNED FIXTURE (#868) for claim 2: the fold is a property of HOW MANY due
// doses one card carries, and the seeded household profile (id 2) carries exactly
// the two that e2e/household-rollup.spec.ts asserts are individually visible.
// Adding a third there would fold that spec's rows out of sight, so this one builds
// its own profile and destroys it again.

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

// One supplement, three doses, same amount: the shape of the reported defect, with
// a third dose so the fold threshold (AGGREGATE_MIN_ROWS = 3) is crossed.
const FOLD_ITEM = "Household Fold Omega (e2e)";
const FOLD_AMOUNT = "600 mg";
const FOLD_BUCKETS = ["Morning", "Midday", "Evening"] as const;

interface FoldFixture {
  profileId: number;
  profileName: string;
}

function createFoldFixture(testInfo: TestInfo): FoldFixture {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    const suffix = `${process.pid}-${testInfo.repeatEachIndex}`;
    const profileName = `Fold Case (e2e) ${suffix}`;
    let profileId = 0;
    handle
      .transaction(() => {
        profileId = createFixtureProfile(handle, profileName);
        const item = handle
          .prepare(
            `INSERT INTO intake_items
               (profile_id, name, condition, obligation, active, source)
             VALUES (?, ?, 'daily', 'should', 1, 'manual')`
          )
          .run(profileId, FOLD_ITEM);
        FOLD_BUCKETS.forEach((bucket, i) => {
          handle
            .prepare(
              `INSERT INTO intake_item_doses
                 (item_id, amount, time_of_day, food_timing, sort)
               VALUES (?, ?, ?, 'any', ?)`
            )
            .run(Number(item.lastInsertRowid), FOLD_AMOUNT, bucket, i);
        });
      })
      .immediate();
    return { profileId, profileName };
  } finally {
    handle.close();
  }
}

function destroyFoldFixture(fixture: FoldFixture): void {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    handle
      .transaction(() => {
        handle
          .prepare(
            `DELETE FROM intake_item_doses WHERE item_id IN
               (SELECT id FROM intake_items WHERE profile_id = ?)`
          )
          .run(fixture.profileId);
        handle
          .prepare("DELETE FROM intake_items WHERE profile_id = ?")
          .run(fixture.profileId);
        destroyFixtureProfile(handle, fixture.profileId);
      })
      .immediate();
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

test("household due doses name their slot and fold past the shared threshold (#2615)", async ({
  page,
}, testInfo) => {
  const fixture = createFoldFixture(testInfo);
  try {
    await page.goto("/household");
    const card = page.locator(
      `[data-testid="household-card"][data-profile-id="${fixture.profileId}"]`
    );
    await expect(card).toBeVisible();

    // FOLDED. Three due doses cross AGGREGATE_MIN_ROWS, so the card states the
    // count and costs three lines instead of twelve. The count is never hidden.
    const aggregate = card.getByTestId("household-dose-aggregate");
    await expect(aggregate).toHaveJSProperty("open", false);
    await expect(
      card.getByTestId("household-dose-aggregate-summary")
    ).toHaveText(/3 doses due/);
    // The rows themselves are behind the disclosure, not merely below it.
    const folded = card.getByTestId("household-due-dose");
    await expect(folded).toHaveCount(3);
    for (const row of await folded.all()) await expect(row).toBeHidden();

    // A native <details> summary: a pure client toggle, no POST and no navigation.
    await hydratedClick(
      page,
      card.getByTestId("household-dose-aggregate-summary")
    );
    await expect(aggregate).toHaveJSProperty("open", true);

    // DISTINGUISHED. Three rows for one supplement at one amount — what tells them
    // apart is the slot, and each row now says it.
    const rows = card.getByTestId("household-due-dose");
    await expect(rows).toHaveCount(3);
    for (const bucket of FOLD_BUCKETS) {
      const row = rows.filter({ hasText: bucket });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(FOLD_ITEM);
      await expect(row).toContainText(FOLD_AMOUNT);
    }

    // …and so does each Confirm, whose visible label is deliberately short. Three
    // controls that announced the same words are what made the card unusable with
    // a screen reader; the accessible names are now pairwise distinct.
    const names = await card
      .getByTestId("household-confirm-dose")
      .evaluateAll((buttons) =>
        buttons.map((b) => b.getAttribute("aria-label") ?? "")
      );
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
    for (const bucket of FOLD_BUCKETS) {
      expect(names.some((n) => n.includes(bucket))).toBe(true);
    }
  } finally {
    destroyFoldFixture(fixture);
  }
});
