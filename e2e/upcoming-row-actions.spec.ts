import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";
import { dismissToast, hydratedClick } from "./helpers";
import { practiceIdentity } from "@/lib/practice";
// Upcoming row composition (issue #1446).
//
// The all-pages census found every overdue row on /upcoming rendering TWO
// identical "⋯" overflow buttons side by side. The cause was never an
// overdue-specific branch: a preventive visit/screening item carries a
// `preventiveRuleKey` (→ the override menu) AND the default suppressible flag
// (→ the snooze/dismiss menu), and those were two independent OverflowMenu
// components. The overdue band merely happened to be all-preventive on the
// census's fresh profile.
//
// These specs assert the row CONTRACT rather than a pixel layout:
//   1. no row ever renders more than one overflow trigger,
//   2. a preventive row renders exactly one, and that one menu still offers BOTH
//      halves (the overrides and snooze/dismiss) — the merge, not a deletion,
//
// Fixture policy (#868): the composition assertions are READ-ONLY over the shared
// seeded profile — they open a menu and press Escape, and never write. So they take no
// exact counts of shared rows (a neighbour spec marks preventive items done or
// overrides them) and never name a single catalog rule: every assertion is
// either per-row, a lower bound, or "any preventive row". Deliberately NOT a
// dedicated fixture profile: those assertions do not need another persisted subject.
//
// THE PRACTICE-ROW CASE AT THE BOTTOM DOES WRITE, and it owns its subject: the row it
// drives only exists while a weekly practice floor is unmet, so it seeds that target
// itself and removes it and its session again. It touches no row the assertions above
// count.

async function openUpcoming(page: Page): Promise<Locator> {
  await page.goto("/upcoming");
  const main = page.getByRole("main");
  // The header count renders only once the attention model has been collected,
  // so it is the page's "ready" signal.
  await expect(main.getByTestId("upcoming-total")).toBeVisible();
  return main;
}

test.describe("Upcoming row actions (#1446)", () => {
  test("no row renders more than one overflow trigger, and a preventive row's single menu keeps both halves", async ({
    page,
  }) => {
    const main = await openUpcoming(page);
    const allRows = main.locator('[data-testid^="upcoming-item-"]');
    const count = await allRows.count();
    // A lower bound, never an exact count — neighbours mutate this shared list.
    expect(count).toBeGreaterThan(3);

    // THE regression assertion: never more than one kebab per row, page-wide.
    // Before the fix every preventive row here reported 2. (A row with nothing
    // to put behind a kebab — a structural signal that is neither suppressible
    // nor preventive — legitimately renders none, so the bound is ≤ 1; the
    // exactly-one case is pinned on a preventive row below.)
    for (let i = 0; i < count; i++) {
      const row = allRows.nth(i);
      const testId = await row.getAttribute("data-testid");
      const triggers = await row.getByTestId("overflow-menu-trigger").count();
      expect(
        triggers,
        `row ${testId} should render at most one overflow trigger`
      ).toBeLessThanOrEqual(1);
    }

    // A preventive row (visit/screening) is the shape that regressed: it has
    // both an override menu and a snooze menu to offer. Located by key prefix,
    // never by a specific rule, so a catalog edit or a neighbour's "mark done"
    // can't break the spec.
    // eslint-disable-next-line no-restricted-properties -- first-ok: any preventive row proves the shape — order-agnostic
    const preventiveRow = main
      .locator(
        '[data-testid^="upcoming-item-visit:"], [data-testid^="upcoming-item-screening:"]'
      )
      .first();
    await expect(preventiveRow).toBeVisible();
    await expect(
      preventiveRow.getByTestId("overflow-menu-trigger")
    ).toHaveCount(1);

    // The single menu still carries BOTH halves — the override items AND
    // snooze/dismiss. This is what distinguishes the fix (a merge) from simply
    // deleting one of the two menus.
    await preventiveRow.getByLabel("More actions").click();
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("menuitem", { name: "Not applicable" })
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Declined" })
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "1 week" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Dismiss" })).toBeVisible();
    // Escape closes without writing anything, keeping this spec read-only.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});

// ── THE PRACTICE ROW MOUNTS THE DOMAIN'S ONE CONTROL (#4424 ruling 7) ──────────
//
// This row used to front `app/(app)/upcoming/PracticeLogButton.tsx` and its own
// `logUpcomingPractice` action — a second door onto the shared core, with no duration,
// no confirm and no live lifecycle. It mounts `LogPracticeButton` now, so the three
// arrive by convergence rather than by being re-added to a copy.
//
// SPEC-OWNED FIXTURE (#868), because the row only exists while a weekly practice floor
// is UNMET: the shared profile's practices are not reliably behind, and a shared row
// tapped here would move a neighbour's counts. Seeded and removed by this test.
test("the practice row logs through the shared control, with the duration the deleted door discarded", async ({
  page,
}) => {
  const name = `E2E Upcoming Practice ${frozenNow().getTime()}`;
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  let targetId = 0;
  try {
    targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week)
           VALUES (1, 'practice', ?, ?, 3)`
        )
        .run(name, practiceIdentity(name)).lastInsertRowid
    );

    await page.goto("/upcoming");
    const row = page.locator(
      `[data-testid="upcoming-item-practice:${targetId}"]`
    );
    await expect(row).toHaveCount(1);

    // THE SHARED CONTROL, by its own marker — the wellness card, the protocol rows and
    // the quick sheet all render this same element, which is what `rowControl: shared`
    // claims. The stepper is the half the deleted door had no field for at all.
    const control = row.getByTestId("practice-log-control");
    await expect(control).toBeVisible();
    const duration = control.getByTestId("practice-duration-input");
    await expect(duration).toBeVisible();
    await duration.fill("35");

    await hydratedClick(page, control.getByTestId("practice-log-button"));
    await dismissToast(page, /Logged/);

    // THE STORE, not the toast: what the deleted door wrote was a session with a null
    // duration whatever the reader had in mind, so the assertion is the column.
    await expect
      .poll(
        () =>
          (
            db
              .prepare(
                `SELECT duration_min FROM practice_logs
                WHERE profile_id = 1 AND practice = ?`
              )
              .get(name) as { duration_min: number | null } | undefined
          )?.duration_min ?? null
      )
      .toBe(35);
  } finally {
    db.prepare(
      "DELETE FROM practice_logs WHERE profile_id = 1 AND practice = ?"
    ).run(name);
    if (targetId)
      db.prepare("DELETE FROM frequency_targets WHERE id = ?").run(targetId);
    db.close();
  }
});
