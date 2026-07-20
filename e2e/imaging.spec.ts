import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";

// Imaging-study CRUD on /imaging (#702): add a structured study through the real
// form, see it in the list with its modality + contrast shown, filter by modality,
// edit its impression, then delete it. Drives the real UI end-to-end.
//
// Fixture discipline (shared seeded DB): a unique body-region marker scopes every
// action and a raw-connection cleanup in beforeAll AND afterAll makes the spec
// idempotent across CI retries — it only ever touches rows it created.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const REGION = "E2EREGION1";
const DOSE_REGION = "E2EDOSEREGION1";
const PET_REGION = "E2EPETREGION1";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare("DELETE FROM imaging_studies WHERE body_region IN (?, ?, ?)")
      .run(REGION, DOSE_REGION, PET_REGION);
  } finally {
    handle.close();
  }
}

// A recent ISO date safely inside the trailing-3-year dose window (the app clock is
// frozen to the run's real "today").
function recentDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

test.describe("Imaging studies — add → view → filter → edit → delete (#702)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("stores a structured study and shows it factually", async ({ page }) => {
    test.slow();

    await page.goto("/imaging");
    const form = page.getByTestId("imaging-study-form");
    await expect(form).toBeVisible();

    // Add an MRI with contrast.
    await form.getByLabel("Modality").selectOption("mri");
    await form.getByLabel("Body region").fill(REGION);
    await form.getByLabel("Laterality").selectOption("left");
    await form.getByLabel("Contrast given").check();
    await form.getByLabel("Impression").fill("No acute abnormality.");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Study saved")).toBeVisible();

    // It appears in the list with its factual identity + contrast badge.
    const list = page.getByTestId("imaging-study-list");
    const row = list.getByRole("row").filter({ hasText: REGION });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`MRI Left ${REGION}`);
    await expect(row).toContainText("contrast");

    // Filtering by a different modality hides it; back to MRI shows it again.
    await list.getByLabel("Filter by modality").selectOption("ct");
    await expect(list.getByRole("row").filter({ hasText: REGION })).toHaveCount(
      0
    );
    await list.getByLabel("Filter by modality").selectOption("mri");
    await expect(
      list.getByRole("row").filter({ hasText: REGION })
    ).toBeVisible();

    // Edit it: change the impression.
    await list
      .getByRole("row")
      .filter({ hasText: REGION })
      .getByRole("button", { name: "Edit" })
      .click();
    const editForm = list.getByTestId("imaging-study-form");
    await editForm.getByLabel("Impression").fill("Interval improvement.");
    await editForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Study updated")).toBeVisible();
    await expect(
      list.getByRole("row").filter({ hasText: REGION })
    ).toContainText("Interval improvement.");

    // Delete it and confirm it's gone. The confirm click MUST be scoped to the
    // dialog: the page also carries one per-row aria-label="Delete" button for every
    // study (incl. the seeded rows), so an unscoped getByRole("button", { name:
    // "Delete" }) is a strict-mode collision.
    const survivor = list.getByRole("row").filter({ hasText: REGION });
    await survivor.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(list.getByRole("row").filter({ hasText: REGION })).toHaveCount(
      0
    );
  });

  test("shows a recorded dose and a cumulative radiation-dose total (#703)", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/imaging");
    const form = page.getByTestId("imaging-study-form");
    await expect(form).toBeVisible();

    // Add a CT with a recorded effective dose, dated inside the trailing window.
    await form.getByLabel("Modality").selectOption("ct");
    await form.getByLabel("Body region").fill(DOSE_REGION);
    await form.getByLabel("Study date").fill(recentDate());
    await form.getByLabel("Effective dose (mSv)").fill("10");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Study saved")).toBeVisible();

    // The list row shows the recorded-dose badge.
    const list = page.getByTestId("imaging-study-list");
    const row = list.getByRole("row").filter({ hasText: DOSE_REGION });
    await expect(row).toContainText("10 mSv");

    // The calm cumulative card renders, with a recorded portion and no alarmist copy.
    const card = page.getByTestId("radiation-dose-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("trailing 3 years");
    await expect(card).toContainText("Recorded:");
    await expect(card.getByTestId("radiation-dose-total")).toContainText("mSv");
    await expect(card).toContainText("Informational, not medical advice.");

    // Clean up the study we created.
    await row.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(
      list.getByRole("row").filter({ hasText: DOSE_REGION })
    ).toHaveCount(0);
  });

  test("a PET study estimates into the cumulative dose card without a recorded dose (#1034)", async ({
    page,
  }) => {
    test.slow();

    // Self-clean this test's marker BEFORE running: under --repeat-each the
    // file-scoped afterAll doesn't run between repeats, and a leftover PET row
    // would strict-mode-collide the single-row assertions below. Scoped to the
    // PET marker only so concurrently running neighbor tests are untouched.
    {
      const handle = new Database(DB_PATH);
      try {
        handle
          .prepare("DELETE FROM imaging_studies WHERE body_region = ?")
          .run(PET_REGION);
      } finally {
        handle.close();
      }
    }

    await page.goto("/imaging");
    const form = page.getByTestId("imaging-study-form");
    await expect(form).toBeVisible();

    // Add a PET study dated inside the trailing window with NO recorded dose —
    // the estimate path. The 'pet' option existing at all is part of #1034 (the
    // modality formerly fell to 'other' and contributed 0).
    await form.getByLabel("Modality").selectOption("pet");
    await form.getByLabel("Body region").fill(PET_REGION);
    await form.getByLabel("Study date").fill(recentDate());
    // Close the DateField calendar popup so it can't intercept the Add click.
    await page.keyboard.press("Escape");
    await settledClick(
      page,
      form.getByRole("button", { name: "Add", exact: true })
    );

    // The list row shows the PET display label (modality + region — the marker
    // region alone contains "PET", so assert the full label).
    const list = page.getByTestId("imaging-study-list");
    const row = list.getByRole("row").filter({ hasText: PET_REGION });
    await expect(row).toContainText(`PET ${PET_REGION}`);

    // The cumulative card now carries an estimated portion (the PET typical
    // dose), and the combined figure reads as an estimate ("≈"). No exact-total
    // assertion — the shared seed and neighbor tests contribute rows too.
    const card = page.getByTestId("radiation-dose-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Estimated:");
    await expect(card.getByTestId("radiation-dose-total")).toContainText("≈");

    // Clean up the study we created.
    await row.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(
      list.getByRole("row").filter({ hasText: PET_REGION })
    ).toHaveCount(0);
  });
});
