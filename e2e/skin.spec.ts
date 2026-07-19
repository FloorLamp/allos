import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { settledClick, settledUpload } from "./helpers";

// Skin-lesion tracking on /skin (#715): add a body-map-anchored lesion through the real
// form, see it in its identity CARD with the ABCDE observation + status shown, track a
// recheck follow-up on a watch lesion, attach a serial PHOTO (the "is this changing?"
// comparison), filter by status, edit, then delete. Drives the real UI end-to-end.
//
// Fixture discipline (shared seeded DB): a unique label marker scopes every action and a
// raw-connection cleanup in beforeAll AND afterAll makes the spec idempotent across CI
// retries — it only ever touches rows it created (skin_lesions + any care-plan follow-up
// or lesion_photos it seeds off them).
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const LABEL = "E2ESkinWatchMole"; // collision-free identity marker (not in seed)

// A minimal valid PNG (signature + a truncated body) — enough for the magic-byte sniff.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("e2e-synthetic-fixture-bytes"),
]);

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `DELETE FROM lesion_photos
          WHERE lesion_id IN (SELECT id FROM skin_lesions WHERE label = ?)`
      )
      .run(LABEL);
    handle
      .prepare(
        `DELETE FROM care_plan_items
          WHERE source_kind = 'skin'
            AND source_skin_lesion_id IN
              (SELECT id FROM skin_lesions WHERE label = ?)`
      )
      .run(LABEL);
    handle.prepare("DELETE FROM skin_lesions WHERE label = ?").run(LABEL);
  } finally {
    handle.close();
  }
}

test.describe("Skin lesions — add → view → track recheck → photo → filter → edit → delete (#715)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("tracks a mole factually and compares it over time", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/skin");
    const form = page.getByTestId("skin-lesion-form");
    await expect(form).toBeVisible();

    // Add a WATCH lesion on the scalp with an ABCDE observation + a recheck interval.
    await form.getByLabel("Label / location").fill(LABEL);
    await form.getByLabel("Region").selectOption("scalp");
    await form.getByLabel("Status").selectOption("watch");
    await form.getByRole("checkbox", { name: /Evolving/ }).check();
    await form.getByLabel("Finding / note").fill("Even brown, watch it.");
    await form.getByLabel("Recheck in (days)").fill("91");
    await settledClick(
      page,
      form.getByRole("button", { name: "Add", exact: true })
    );
    await expect(page.getByText("Lesion saved")).toBeVisible();

    // It appears as its own identity card with a watch badge + the ABCDE letters.
    const card = page.getByTestId("lesion-card").filter({ hasText: LABEL });
    await expect(card).toBeVisible();
    await expect(card).toContainText("watch");
    await expect(card).toContainText("ABCDE E");

    // Track a recheck follow-up on it — the row's control turns into a tracked state.
    const trackForm = card.getByTestId(/^track-skin-followup-/);
    await trackForm
      .locator("select")
      .first()
      .selectOption({ label: "3 months" });
    await settledClick(
      page,
      trackForm.getByRole("button", { name: "Track recheck" }).first()
    );
    await expect(card.getByTestId(/^skin-followup-state-/)).toContainText(
      "Recheck:",
      { timeout: 15000 }
    );

    // Attach a dated photo — the serial-comparison strip renders a thumbnail.
    await card.getByTestId(/^add-lesion-photo-/).click();
    const upload = card.getByTestId(/^lesion-photo-upload-/);
    await expect(upload).toBeVisible();
    await settledUpload(page, upload.locator('input[type="file"]'), {
      name: "mole.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await expect(
      card.getByRole("img", { name: /Lesion photo from/ })
    ).toBeVisible({ timeout: 15000 });

    // Filter by "Removed" hides it; back to "All statuses" shows it again.
    const list = page.getByTestId("skin-lesion-list");
    await list.getByLabel("Filter by status").selectOption("removed");
    await expect(
      list.getByTestId("lesion-card").filter({ hasText: LABEL })
    ).toHaveCount(0);
    await list.getByLabel("Filter by status").selectOption("");
    await expect(
      list.getByTestId("lesion-card").filter({ hasText: LABEL })
    ).toBeVisible();

    // Edit the observation record: change the finding note.
    await card.getByRole("button", { name: "Edit" }).first().click();
    const editForm = card.getByTestId("skin-lesion-form");
    await editForm
      .getByLabel("Finding / note")
      .fill("Unchanged since baseline.");
    await settledClick(
      page,
      editForm.getByRole("button", { name: "Save", exact: true })
    );
    await expect(page.getByText("Lesion updated")).toBeVisible();
    await expect(card).toContainText("Unchanged since baseline.");

    // Delete the observation and confirm the card is gone. The row's "Delete" button
    // opens the confirm dialog (a client toggle); the dialog's Delete fires the POST.
    // exact:true scopes it off the photo strip's "Delete photo" remove control.
    await card
      .getByRole("button", { name: "Delete", exact: true })
      .first()
      .click();
    await settledClick(
      page,
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete", exact: true })
    );
    await expect(
      list.getByTestId("lesion-card").filter({ hasText: LABEL })
    ).toHaveCount(0);
  });
});
