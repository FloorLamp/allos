import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledClick } from "./helpers";
import { workerDbPath, frozenNow } from "./worker-env";

// Imaging-study CRUD on the #imaging section of /results (#702, #1042 phase 5): add a structured study through the real
// form, see it in the list with its modality + contrast shown, filter by modality,
// edit its impression, then delete it. Drives the real UI end-to-end.
//
// Fixture discipline (shared seeded DB): a unique body-region marker scopes every
// action and a raw-connection cleanup in beforeAll AND afterAll makes the spec
// idempotent across CI retries — it only ever touches rows it created.
const DB_PATH = workerDbPath();
const REGION = "E2EREGION1";
const DOSE_REGION = "E2EDOSEREGION1";
const PET_REGION = "E2EPETREGION1";
// Carries the "chest" token on purpose: the estimate resolves to the named
// "Chest X-ray" dataset entry, which is what the breakdown row cites.
const BREAKDOWN_REGION = "Chest E2EBREAKREGION1";
const EXCLUDED_REGION = "E2EEXCLREGION1";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        "DELETE FROM imaging_studies WHERE body_region IN (?, ?, ?, ?, ?)"
      )
      .run(REGION, DOSE_REGION, PET_REGION, BREAKDOWN_REGION, EXCLUDED_REGION);
  } finally {
    handle.close();
  }
}

// A recent ISO date safely inside the trailing-3-year dose window (the app clock is
// frozen to the run's real "today").
function recentDate(): string {
  const d = frozenNow();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

async function submitWithToast(
  page: Page,
  button: Locator,
  message: string
): Promise<void> {
  // A cold Server Action response can outlive the toast it triggers. Observe the
  // transient feedback concurrently while settledClick still owns durability.
  await Promise.all([
    expect(page.getByText(message)).toBeVisible({ timeout: 15_000 }),
    settledClick(page, button),
  ]);
}

test.describe("Imaging studies — add → view → filter → edit → delete (#702)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("stores a structured study and shows it factually", async ({ page }) => {
    test.slow();

    await page.goto("/results/imaging");
    const add = page.getByTestId("add-imaging-panel-toggle");
    await expect(add).toHaveClass(/\bbtn\b/);
    await hydratedClick(page, add);
    const dialog = page.getByRole("dialog", { name: "Add imaging study" });
    await expect(dialog).toBeVisible();
    const form = dialog.getByTestId("imaging-study-form");
    await expect(form).toBeVisible();

    // Add an MRI with contrast.
    await form.getByLabel("Modality").selectOption("mri");
    await form.getByLabel("Body region").fill(REGION);
    await form.getByLabel("Laterality").selectOption("left");
    await form.getByLabel("Contrast given").check();
    await form.getByLabel("Impression").fill("No acute abnormality.");
    await submitWithToast(
      page,
      form.getByRole("button", { name: "Add", exact: true }),
      "Study saved"
    );

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
      .getByLabel("Record actions")
      .click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const editForm = list.getByTestId("imaging-study-form");
    await expect(editForm).not.toHaveClass(/\bcard\b/);
    await editForm.getByLabel("Impression").fill("Interval improvement.");
    await submitWithToast(
      page,
      editForm.getByRole("button", { name: "Save", exact: true }),
      "Study updated"
    );
    // The toast fires right after the save action returns; the ROW text only updates
    // once the save action's revalidated tree lands (ImagingStudyForm.handle — toast
    // → onDone). That re-render can outrun the default 5s on a
    // starved shard, so give this the heavy-refresh budget (the #1306 precedent).
    await expect(
      list.getByRole("row").filter({ hasText: REGION })
    ).toContainText("Interval improvement.", { timeout: 15_000 });

    // Delete it through the row's shared record-actions menu.
    const survivor = list.getByRole("row").filter({ hasText: REGION });
    await survivor.getByLabel("Record actions").click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
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

    await page.goto("/results/imaging");
    // The rare-entry CTA opens the imaging form in a modal.
    await hydratedClick(page, page.getByTestId("add-imaging-panel-toggle"));
    const form = page.getByTestId("imaging-study-form");
    await expect(form).toBeVisible();

    // Add a CT with a recorded effective dose, dated inside the trailing window.
    await form.getByLabel("Modality").selectOption("ct");
    await form.getByLabel("Body region").fill(DOSE_REGION);
    await form.getByLabel("Study date").fill(recentDate());
    await form.getByLabel("Effective dose (mSv)").fill("10");
    await submitWithToast(
      page,
      form.getByRole("button", { name: "Add", exact: true }),
      "Study saved"
    );

    // The list row shows the recorded-dose badge.
    const list = page.getByTestId("imaging-study-list");
    const row = list.getByRole("row").filter({ hasText: DOSE_REGION });
    await expect(row).toContainText("10 mSv");

    // The calm cumulative card renders, with a recorded portion and no alarmist copy.
    const card = page.getByTestId("radiation-dose-card");
    await expect(card).toBeVisible();
    // The trailing window is a SECONDARY lens now (#2970) — the headline is all
    // records, labelled with how far back it reaches, and never ages downward.
    await expect(card).toContainText("Last 3 years:");
    await expect(card).toContainText("From your records, since");
    await expect(card).toContainText("Recorded:");
    await expect(card.getByTestId("radiation-dose-total")).toContainText("mSv");
    await expect(card).not.toContainText("Informational, not medical advice.");

    // Clean up the study we created.
    await row.getByLabel("Record actions").click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
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

    await page.goto("/results/imaging");
    // The rare-entry CTA opens the imaging form in a modal.
    await hydratedClick(page, page.getByTestId("add-imaging-panel-toggle"));
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
    // Assert the SUBMIT OUTCOME, exactly as the two sibling tests do. This test
    // used to click blind through settledClick, which resolves on any same-origin
    // POST — including one carrying a REFUSAL. `addImagingStudy` surfaces a
    // failure as an inline `role="alert"` and renders no row, so a refused submit
    // was indistinguishable from a slow one: it surfaced 20 s later as a bare
    // "element(s) not found" on the row locator, naming neither the refusal nor
    // its reason (recurring-failure census, docs/internals/e2e-hygiene.md).
    // Waiting for "Study saved" fails AT the submit, with the inline error in the
    // snapshot, whenever the action does not actually succeed.
    await submitWithToast(
      page,
      form.getByRole("button", { name: "Add", exact: true }),
      "Study saved"
    );

    // The list row shows the PET display label (modality + region — the marker
    // region alone contains "PET", so assert the full label).
    const list = page.getByTestId("imaging-study-list");
    await expect(list).toBeVisible();
    const row = list.getByRole("row").filter({ hasText: PET_REGION });
    // Post-submit re-render ceiling. The toast above already proved the write
    // succeeded, so reaching this timeout now means one specific thing — the row
    // never repainted — rather than any of "refused", "slow" or "never submitted".
    // The ceiling is measured, not a sleep: the post-action repaint runs ~0.3 s
    // unthrottled and ~8 s under a 25× CPU throttle.
    await expect(row).toContainText(`PET ${PET_REGION}`, { timeout: 20_000 });

    // The cumulative card now carries an estimated portion (the PET typical
    // dose), and the combined figure reads as an estimate ("≈"). No exact-total
    // assertion — the shared seed and neighbor tests contribute rows too.
    const card = page.getByTestId("radiation-dose-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Estimated:");
    await expect(card.getByTestId("radiation-dose-total")).toContainText("≈");

    // Clean up the study we created.
    await row.getByLabel("Record actions").click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(
      list.getByRole("row").filter({ hasText: PET_REGION })
    ).toHaveCount(0);
  });

  test("the cumulative total names the studies behind it and the ones it left out (#2970)", async ({
    page,
  }) => {
    test.slow();

    // Self-clean this test's markers BEFORE running, like the PET sibling: under
    // --repeat-each the file-scoped afterAll doesn't run between repeats, and a
    // leftover row would collide with the single-row assertions below.
    {
      const handle = new Database(DB_PATH);
      try {
        handle
          .prepare("DELETE FROM imaging_studies WHERE body_region IN (?, ?)")
          .run(BREAKDOWN_REGION, EXCLUDED_REGION);
      } finally {
        handle.close();
      }
    }

    await page.goto("/results/imaging");

    // A chest X-ray with NO recorded dose — the estimate path, and the common case:
    // in the audited record every study had a NULL dose, so the card showed figures
    // no row could account for.
    await hydratedClick(page, page.getByTestId("add-imaging-panel-toggle"));
    const xrayForm = page.getByTestId("imaging-study-form");
    await expect(xrayForm).toBeVisible();
    await xrayForm.getByLabel("Modality").selectOption("x-ray");
    await xrayForm.getByLabel("Body region").fill(BREAKDOWN_REGION);
    await xrayForm.getByLabel("Study date").fill(recentDate());
    await page.keyboard.press("Escape");
    await submitWithToast(
      page,
      xrayForm.getByRole("button", { name: "Add", exact: true }),
      "Study saved"
    );

    // An ultrasound on the same day — a true 0 mSv, and one of the three classes of
    // study that contributed nothing without ever saying so.
    await hydratedClick(page, page.getByTestId("add-imaging-panel-toggle"));
    const usForm = page.getByTestId("imaging-study-form");
    await expect(usForm).toBeVisible();
    await usForm.getByLabel("Modality").selectOption("ultrasound");
    await usForm.getByLabel("Body region").fill(EXCLUDED_REGION);
    await usForm.getByLabel("Study date").fill(recentDate());
    await page.keyboard.press("Escape");
    await submitWithToast(
      page,
      usForm.getByRole("button", { name: "Add", exact: true }),
      "Study saved"
    );

    // The list row now carries an ESTIMATED dose chip, marked as an estimate.
    const list = page.getByTestId("imaging-study-list");
    const xrayRow = list.getByRole("row").filter({ hasText: BREAKDOWN_REGION });
    await expect(xrayRow).toContainText("est.", { timeout: 20_000 });

    // Open the breakdown: the contributing study is named with its figure, and the
    // ultrasound is named as excluded with the reason.
    const card = page.getByTestId("radiation-dose-card");
    await expect(card).toBeVisible();
    const details = card.getByTestId("radiation-dose-breakdown");
    if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
      await details.locator("summary").click();
    }
    await expect(details).toHaveJSProperty("open", true);

    const contribution = details
      .getByTestId("radiation-dose-contribution")
      .filter({ hasText: BREAKDOWN_REGION });
    await expect(contribution).toContainText("est.");
    await expect(contribution).toContainText("Typical for Chest X-ray");

    const exclusion = details
      .getByTestId("radiation-dose-exclusion")
      .filter({ hasText: EXCLUDED_REGION });
    await expect(exclusion).toContainText("No ionizing radiation.");

    // Clean up both studies we created.
    for (const marker of [BREAKDOWN_REGION, EXCLUDED_REGION]) {
      const row = list.getByRole("row").filter({ hasText: marker });
      await hydratedClick(page, row.getByLabel("Record actions"));
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await expect(
        list.getByRole("row").filter({ hasText: marker })
      ).toHaveCount(0);
    }
  });
});
