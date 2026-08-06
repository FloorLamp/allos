import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";
import { workerDbPath } from "./worker-env";

// Skin-lesion tracking on the Skin section of /records (#715, folded #1042): add a body-map-anchored lesion through the real
// form, see it in its identity CARD with the ABCDE observation + status shown, track a
// recheck follow-up on a watch lesion, attach a serial PHOTO (the "is this changing?"
// comparison), filter by status, edit, then delete. Drives the real UI end-to-end.
//
// Fixture discipline (shared seeded DB): a unique label marker scopes every action and a
// raw-connection cleanup in beforeAll AND afterAll makes the spec idempotent across CI
// retries — it only ever touches rows it created (skin_lesions + any care-plan follow-up
// or lesion_photos it seeds off them).
const DB_PATH = workerDbPath();
const LABEL = "E2ESkinWatchMole"; // collision-free identity marker (not in seed)

// Smallest valid PNG (1x1 transparent), base64 — a synthetic fixture image (no PHI).
// It must DECODE now, not merely pass a magic-byte sniff: since #1844 a lesion photo
// goes through the shared photo core, which re-encodes it and strips its metadata.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQBHYh4RAAAAAElFTkSuQmCC",
  "base64"
);

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

    await page.goto("/records/specialty/skin");
    await page.getByTestId("add-skin-lesion-panel-toggle").click();
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
      .first() // first-ok: the recheck-interval select in the scoped skin-followup form this spec drives
      .selectOption({ label: "3 months" });
    await settledClick(
      page,
      trackForm.getByRole("button", { name: "Track recheck" }).first() // first-ok: the Track-recheck button in the scoped skin-followup form this spec drives
    );
    await expect(card.getByTestId(/^skin-followup-state-/)).toContainText(
      "Recheck:",
      { timeout: 15000 }
    );

    // Attach a dated photo — the serial-comparison strip renders it through the
    // shared photo gallery (#1844). The upload form is explicit-submit (no
    // auto-submit on file change), so set the file then settledClick the button that
    // fires the POST.
    await card.getByTestId(/^add-lesion-photo-/).click();
    const upload = card.getByTestId(/^lesion-photo-upload-/);
    await expect(upload).toBeVisible();
    await upload.locator('input[type="file"]').setInputFiles({
      name: "mole.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await settledClick(page, upload.getByRole("button", { name: "Add photo" }));
    const tile = card.locator('[data-testid^="photo-gallery-item-"]');
    await expect(tile).toBeVisible({ timeout: 15000 });
    // The grid reads the ingest thumbnail; the lightbox opens the full image.
    await tile.click();
    const lightbox = page.getByTestId("photo-lightbox");
    await expect(lightbox.getByTestId("photo-lightbox-image")).toBeVisible();
    await lightbox.getByTestId("photo-lightbox-close").click();

    // Filter by "Removed" hides it; back to "All" shows it again. The status filter
    // is the family's shared FilterPills group since #1449, not a <select>.
    const list = page.getByTestId("skin-lesion-list");
    const skinFilter = list.getByTestId("skin-status-filter");
    await skinFilter.getByRole("button", { name: "Removed" }).click();
    await expect(
      list.getByTestId("lesion-card").filter({ hasText: LABEL })
    ).toHaveCount(0);
    await skinFilter.getByRole("button", { name: "All" }).click();
    await expect(
      list.getByTestId("lesion-card").filter({ hasText: LABEL })
    ).toBeVisible();

    // Edit the observation record: change the finding note.
    await card.getByRole("button", { name: "Record actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const editForm = card.getByTestId("skin-lesion-form");
    await editForm
      .getByLabel("Finding / note")
      .fill("Unchanged since baseline.");
    await settledClick(
      page,
      editForm.getByRole("button", { name: "Save", exact: true })
    );
    await expect(page.getByText("Lesion updated")).toBeVisible();
    // Renders on the save action's revalidated tree — a cold shard can outrun the default 5s (imaging/#1306 precedent).
    await expect(card).toContainText("Unchanged since baseline.", {
      timeout: 15_000,
    });

    // Delete the observation and confirm the card is gone. The row's "Delete" button
    // opens the confirm dialog (a client toggle); the dialog's Delete fires the POST.
    // exact:true scopes it off the lightbox's "Delete photo" control.
    await card.getByRole("button", { name: "Record actions" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
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
