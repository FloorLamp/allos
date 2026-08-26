import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { dismissToast, hydratedClick, settledClick } from "./helpers";
import {
  expectDesktopSpecialtySubmit,
  expectPhoneSpecialtySubmit,
} from "./specialty-form-actions";
import { workerDbPath } from "./worker-env";

// Dental-record CRUD on the Dental section of /records (#705, folded #1042): add a tooth-anchored procedure through the
// real form, see it in the list with its tooth + status shown, filter by status,
// track a recheck follow-up on a watch finding, edit, then delete. Drives the real UI
// end-to-end.
//
// Fixture discipline (shared seeded DB): a unique tooth marker scopes every action and
// a raw-connection cleanup in beforeAll AND afterAll makes the spec idempotent across
// CI retries — it only ever touches rows it created (dental_procedures + any care-plan
// follow-up it seeds off them).
const DB_PATH = workerDbPath();
const TOOTH = "97"; // out of the 1–32 seeded range → collision-free marker
const NAME = "E2EDentalWatch";
const PHONE = { width: 390, height: 844 };

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `DELETE FROM care_plan_items
          WHERE source_kind = 'dental'
            AND source_dental_procedure_id IN
              (SELECT id FROM dental_procedures WHERE tooth = ?)`
      )
      .run(TOOTH);
    handle.prepare("DELETE FROM dental_procedures WHERE tooth = ?").run(TOOTH);
  } finally {
    handle.close();
  }
}

test.describe("Dental records — add → view → filter → track recheck → edit → delete (#705)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("stores a tooth-anchored record and shows it factually", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/specialty/dental");
    await page.getByTestId("add-dental-record-panel-toggle").click();
    const form = page.getByTestId("dental-procedure-form");
    await expect(form).toBeVisible();
    const add = form.getByRole("button", { name: "Add", exact: true });
    await expectDesktopSpecialtySubmit({
      form,
      actions: form.getByTestId("dental-procedure-actions"),
      primaryOwner: form.getByTestId("dental-procedure-primary-action"),
      submit: add,
      name: "dental add",
    });
    await page.setViewportSize(PHONE);
    await expectPhoneSpecialtySubmit({
      form,
      actions: form.getByTestId("dental-procedure-actions"),
      primaryOwner: form.getByTestId("dental-procedure-primary-action"),
      submit: add,
      fillsActions: true,
      name: "phone dental add",
    });

    // Add a caries WATCH finding on tooth #97 with a recheck interval.
    await form.getByLabel("Procedure / finding").fill(NAME);
    await form.getByLabel("Status").selectOption("watch");
    await form.getByLabel("Tooth").fill(TOOTH);
    await form.getByLabel("Finding / note").fill("Watch for recurrent decay.");
    await settledClick(page, add);
    await expect(page.getByText("Record saved")).toBeVisible();

    // It appears in the list with its display label, tooth, and a status badge.
    const list = page.getByTestId("dental-procedure-list");
    const row = list.getByRole("row").filter({ hasText: NAME });
    // Renders on the save action's revalidated tree — a cold shard can outrun the default 5s (imaging/#1306 precedent).
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(`#${TOOTH}`);
    await expect(row).toContainText("watch");
    await dismissToast(page, "Record saved");
    await page.reload();
    await expect(row).toBeVisible();

    // Filtering by "Completed" hides it; back to "Watch" shows it again. The status
    // filter is the family's shared FilterPills group since #1449, not a <select>.
    const dentalFilter = list.getByTestId("dental-status-filter");
    await dentalFilter.getByRole("button", { name: "Completed" }).click();
    await expect(list.getByRole("row").filter({ hasText: NAME })).toHaveCount(
      0
    );
    await dentalFilter.getByRole("button", { name: "Watch" }).click();
    await expect(list.getByRole("row").filter({ hasText: NAME })).toBeVisible();

    // Track a recheck follow-up on it — the row's control turns into a tracked state.
    const trackForm = row.getByTestId(/^track-dental-followup-/);
    const interval = trackForm.getByLabel("Recheck interval");
    const track = trackForm.getByRole("button", { name: "Track recheck" });
    expect(
      await trackForm.evaluate((form) => {
        const select = form.querySelector("select")!.getBoundingClientRect();
        const button = form.querySelector("button")!.getBoundingClientRect();
        const bounds = form.getBoundingClientRect();
        return [
          bounds.left >= 0 && bounds.right <= innerWidth,
          Math.abs(select.top - button.top) < 8,
        ];
      })
    ).toEqual([true, true]);
    await interval.selectOption({ label: "6 months" });
    await track.click();
    await expect(page.getByTestId(/^dental-followup-state-/)).toContainText(
      "Recheck:",
      { timeout: 15000 }
    );

    // Edit it: change the finding note.
    await hydratedClick(
      page,
      list
        .getByRole("row")
        .filter({ hasText: NAME })
        .getByLabel("Record actions")
    );
    await page.getByRole("menuitem", { name: "Edit" }).click();
    let editForm = list.getByTestId("dental-procedure-form");
    await expectPhoneSpecialtySubmit({
      form: editForm,
      actions: editForm.getByTestId("dental-procedure-actions"),
      primaryOwner: editForm.getByTestId("dental-procedure-primary-action"),
      submit: editForm.getByRole("button", { name: "Save", exact: true }),
      adjacent: editForm.getByRole("button", {
        name: "Cancel",
        exact: true,
      }),
      name: "phone dental edit",
    });
    await hydratedClick(
      page,
      editForm.getByRole("button", { name: "Cancel", exact: true })
    );
    await expect(editForm).toHaveCount(0);

    await hydratedClick(
      page,
      list
        .getByRole("row")
        .filter({ hasText: NAME })
        .getByLabel("Record actions")
    );
    await page.getByRole("menuitem", { name: "Edit" }).click();
    editForm = list.getByTestId("dental-procedure-form");
    await editForm.getByLabel("Finding / note").fill("Interval stable.");
    await settledClick(
      page,
      editForm.getByRole("button", { name: "Save", exact: true })
    );
    await expect(page.getByText("Record updated")).toBeVisible();
    await expect(list.getByRole("row").filter({ hasText: NAME })).toContainText(
      "Interval stable.",
      { timeout: 15_000 }
    );
    await dismissToast(page, "Record updated");
    await page.reload();
    await expect(list.getByRole("row").filter({ hasText: NAME })).toContainText(
      "Interval stable."
    );

    // Delete it through the shared record-actions menu and confirm it's gone.
    const survivor = list.getByRole("row").filter({ hasText: NAME });
    const actions = survivor.getByLabel("Record actions");
    // Since #3501 the trigger names the ROW it acts on, not just its kind — below
    // `md` this menu is a sheet that has left the row behind by the time anyone
    // reads its heading. The tooth is part of that name because it is part of how
    // the list prints the record (lib/dental.ts, dentalDisplayLabel).
    await expect(actions).toHaveAttribute(
      "title",
      `Record actions for ${NAME} \u00b7 #${TOOTH}`
    );
    await hydratedClick(page, actions);
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(list.getByRole("row").filter({ hasText: NAME })).toHaveCount(
      0
    );
  });
});
