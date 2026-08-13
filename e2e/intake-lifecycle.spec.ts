import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";
import { settledClick, settledFill } from "./helpers";

// Intake lifecycle stale-actor fixes (#2133/#2131). Both tests OWN their fixtures
// (create-and-clean, unique names) so the shared seed profile is left as found.
//
// 1. Pause/Resume is STATE-NAMED: a row still rendering "Pause" after another
//    tab/device already paused the item must surface the typed refusal — never
//    resume it while toasting "Supplement paused" (the #2133 inversion).
// 2. A retired dose renders in the edit form's "Retired doses" section with its
//    Restore affordance, and restoring puts the SAME dose row back on the
//    schedule (#2131).

function withDb<T>(fn: (db: InstanceType<typeof Database>) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

async function addIntakeItem(
  page: import("@playwright/test").Page,
  name: string
) {
  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await settledFill(page, addDialog.getByLabel("Name"), name);
  await settledClick(
    page,
    addDialog.getByRole("button", { name: "Add", exact: true })
  );
  await expect(
    page.getByTestId("supplement-row").filter({ hasText: name })
  ).toBeVisible();
}

async function deleteIntakeItem(
  page: import("@playwright/test").Page,
  name: string
) {
  const row = page
    .getByTestId("supplement-row")
    .filter({ hasText: name })
    .first(); // first-ok: spec-owned unique name; a multi-dose item renders one row per dose and any of ITS rows opens the same item menu
  await row.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await settledClick(
    page,
    page.getByRole("button", { name: "Delete", exact: true })
  );
  await expect(
    page.getByTestId("supplement-row").filter({ hasText: name })
  ).toHaveCount(0);
}

test("a stale tab's Pause refuses with the typed outcome instead of resuming (#2133)", async ({
  page,
}) => {
  const NAME = "E2E CAS Zinc";
  await page.goto("/nutrition?tab=supplements");
  await addIntakeItem(page, NAME);

  // Another device pauses the item while this tab keeps its stale render.
  withDb((db) =>
    db.prepare("UPDATE intake_items SET active = 0 WHERE name = ?").run(NAME)
  );

  const row = page.getByTestId("supplement-row").filter({ hasText: NAME });
  await row.getByRole("button", { name: "Supplement actions" }).click();
  // The stale render still offers "Pause" — the tap must refuse, not invert.
  await page.getByRole("menuitem", { name: "Pause" }).click();
  // The "added" success toast from the fixture setup may still be on screen, so
  // match the refusal toast by its own text.
  await expect(
    page.getByTestId("toast").filter({ hasText: "Already paused" })
  ).toBeVisible();

  // The wrong write did NOT happen: the item is still paused.
  const active = withDb(
    (db) =>
      (
        db
          .prepare("SELECT active FROM intake_items WHERE name = ?")
          .get(NAME) as { active: number }
      ).active
  );
  expect(active).toBe(0);

  // Clean up: a fresh render files the paused item under the collapsed "Paused"
  // disclosure; open it, then delete.
  await page.reload();
  await page.locator("summary").filter({ hasText: "Paused" }).click();
  await deleteIntakeItem(page, NAME);
});

test("a retired dose offers Restore in the edit form and rejoins the schedule (#2131)", async ({
  page,
}) => {
  const NAME = "E2E Restore Fish Oil";
  await page.goto("/nutrition?tab=supplements");
  await addIntakeItem(page, NAME);

  // A previously retired Evening dose (kept for its logged history). Seeded
  // directly: the retire path itself is covered at the action tier; this spec
  // owns the RENDERED affordance.
  const doseId = withDb((db) => {
    const itemId = (
      db.prepare("SELECT id FROM intake_items WHERE name = ?").get(NAME) as {
        id: number;
      }
    ).id;
    return Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort, retired)
           VALUES (?, '500 mg', 'Evening', 'any', 5, 1)`
        )
        .run(itemId).lastInsertRowid
    );
  });

  await page.reload();
  const row = page.getByTestId("supplement-row").filter({ hasText: NAME });
  await row.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();

  const retired = page.getByTestId("retired-doses");
  await expect(retired).toBeVisible();
  await expect(retired).toContainText("500 mg · Evening");
  await settledClick(page, page.getByTestId(`restore-dose-${doseId}`));

  // Rendering from state: with nothing left to restore, the section is gone —
  // and the restored dose joined the editable dose rows.
  await expect(page.getByTestId("retired-doses")).toHaveCount(0);
  const editPanel = page.getByTestId("supplement-edit-panel");
  await expect(
    editPanel.getByRole("combobox", { name: "Amount" }).nth(1)
  ).toHaveValue("500 mg");

  // The SAME dose row is live again (id stability is the point of retire).
  const retiredFlag = withDb(
    (db) =>
      (
        db
          .prepare("SELECT retired FROM intake_item_doses WHERE id = ?")
          .get(doseId) as { retired: number }
      ).retired
  );
  expect(retiredFlag).toBe(0);

  await page.getByRole("button", { name: "Cancel" }).click();
  await deleteIntakeItem(page, NAME);
});
