import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledClick } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_RECS_ENRICH, E2E_MEMBER_PASSWORD } from "./fixture-logins";
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
// A second CT with the SAME recorded dose. Two studies at 10.05 mSv are what make the
// card's addition checkable on the surface: each row prints 10.1, so the headline owes
// the reader 20.2 — it printed 20.1, because every figure was rounded independently of
// the sum (#2970 R5). One such study cannot show it; two can.
const DOSE_SUM_REGION = "E2EDOSESUMREGION1";
const PET_REGION = "E2EPETREGION1";
// Carries the "chest" token on purpose: the estimate resolves to the named
// "Chest X-ray" dataset entry, which is what the breakdown row cites.
const BREAKDOWN_REGION = "Chest E2EBREAKREGION1";
const EXCLUDED_REGION = "E2EEXCLREGION1";
// A second chest X-ray, dated OUTSIDE the trailing-3-year lens. Without a study older
// than the lens, every rendered figure on this card is the same number twice: the
// headline and the "Last 3 years" line cannot be told apart, and neither can the
// since-date and the lens start. Both swaps shipped green against a fixture where
// every study was recent (#2970 R3/R4).
const OLD_REGION = "Chest E2EOLDREGION1";
// An UNDATED ultrasound: undated AND non-ionizing, so "Add a date to include it" would
// be false for it however the date is fixed (#2970 R2).
const UNDATED_REGION = "E2EUNDATEDREGION1";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        "DELETE FROM imaging_studies WHERE body_region IN (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        REGION,
        DOSE_REGION,
        DOSE_SUM_REGION,
        PET_REGION,
        BREAKDOWN_REGION,
        EXCLUDED_REGION,
        OLD_REGION,
        UNDATED_REGION
      );
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

// A date safely OUTSIDE the trailing-3-year lens, still inside the record — the study
// the truncating headline used to drop, and the only thing that makes the headline and
// the lens two DIFFERENT numbers on the surface.
function oldDate(): string {
  const d = frozenNow();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

// The year the lens starts in — what the since-label must NOT be showing.
function lensStartYear(): string {
  const d = frozenNow();
  d.setFullYear(d.getFullYear() - 3);
  return String(d.getFullYear());
}

// The figure out of a rendered "… 1.2 mSv" fragment.
function msvFigure(text: string): number {
  const m = /([\d.]+)\s*mSv/.exec(text);
  expect(m, `no mSv figure in: ${text}`).not.toBeNull();
  return Number(m![1]);
}

// The same figure as TEXT — the digits on the screen, not a number parsed out of them.
function printedFigure(text: string): string {
  const m = /(\d[\d.]*)\s*mSv/.exec(text);
  expect(m, `no mSv figure in: ${text}`).not.toBeNull();
  return m![1];
}

// Add printed figures the way a reader adds them: exact decimal arithmetic on the digits
// shown, no rounding at any step. Rounding here is what made the pure-tier version of
// this check vacuous (#2970 R5) — it re-formatted the row sum, and the last rounding
// erased the disagreement the reader can see.
function addPrintedFigures(figures: string[]): string {
  const places = Math.max(
    0,
    ...figures.map((f) => (f.split(".")[1] ?? "").length)
  );
  let total = 0n;
  for (const f of figures) {
    const [whole, frac = ""] = f.split(".");
    total += BigInt(whole + frac.padEnd(places, "0"));
  }
  const digits = total.toString().padStart(places + 1, "0");
  const frac = places > 0 ? digits.slice(digits.length - places) : "";
  const trimmed = frac.replace(/0+$/, "");
  return `${digits.slice(0, digits.length - places)}${trimmed ? `.${trimmed}` : ""}`;
}

// Wait for the toast stack to drain. This spec's breakdown test adds FOUR studies in a
// row, and `submitWithToast` matches the toast text strictly — a toast still on screen
// from the previous add is a second match, which fails as a strict-mode violation
// rather than as anything about the study being saved.
async function toastsCleared(page: Page): Promise<void> {
  await expect(page.getByText("Study saved")).toHaveCount(0, {
    timeout: 15_000,
  });
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

    // Add a CT with a recorded effective dose, dated inside the trailing window. A
    // reported CT dose prints two decimals, so 10.05 is an ordinary value, not a
    // pathological one — the row shows it at the display precision, 10.1.
    await form.getByLabel("Modality").selectOption("ct");
    await form.getByLabel("Body region").fill(DOSE_REGION);

    // A study happened; it is not scheduled. A date typed in 2099 used to reach the
    // dose card and make it say "From your records, since January 1, 2099." (#2970), so
    // the field carries the profile's today as its max and the browser refuses the
    // value. An ordinary recent date is of course accepted — the cap is on the future,
    // not on entry.
    const studyDate = form.getByLabel("Study date");
    await studyDate.fill("2099-01-01");
    await expect(studyDate).toHaveJSProperty(
      "validationMessage",
      "Date is outside the allowed range."
    );
    await studyDate.fill(recentDate());
    await expect(studyDate).toHaveJSProperty("validationMessage", "");

    await form.getByLabel("Effective dose (mSv)").fill("10.05");
    await submitWithToast(
      page,
      form.getByRole("button", { name: "Add", exact: true }),
      "Study saved"
    );

    await toastsCleared(page);

    // A second CT at the same dose: two rows of 10.1 that the headline has to account
    // for. With one such study the card's arithmetic cannot be checked at all.
    await hydratedClick(page, page.getByTestId("add-imaging-panel-toggle"));
    const secondForm = page.getByTestId("imaging-study-form");
    await expect(secondForm).toBeVisible();
    await secondForm.getByLabel("Modality").selectOption("ct");
    await secondForm.getByLabel("Body region").fill(DOSE_SUM_REGION);
    await secondForm.getByLabel("Study date").fill(recentDate());
    await secondForm.getByLabel("Effective dose (mSv)").fill("10.05");
    await submitWithToast(
      page,
      secondForm.getByRole("button", { name: "Add", exact: true }),
      "Study saved"
    );

    // The list row shows the recorded-dose badge.
    const list = page.getByTestId("imaging-study-list");
    const row = list.getByRole("row").filter({ hasText: DOSE_REGION });
    await expect(row).toContainText("10.1 mSv", { timeout: 20_000 });

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

    // THE READER'S OWN CHECK, on the rendered card: read the figure off every row of
    // the breakdown, add the digits shown, and compare with the digits in the headline.
    // Nothing here rounds. Rounding each row independently of the sum printed two rows
    // of 10.1 under a headline of 20.1 (#2970 R5), and the pure-tier assertion that was
    // meant to catch it re-formatted the row sum, which erased the difference.
    const details = card.getByTestId("radiation-dose-breakdown");
    if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
      await details.locator("summary").click();
    }
    await expect(details).toHaveJSProperty("open", true);
    const rowFigures = await details
      .getByTestId("radiation-dose-contribution-figure")
      .allInnerTexts();
    // Both CTs are in there, plus whatever else this profile's record holds — the check
    // is over ALL the rows the card is showing, which is what a reader would add.
    expect(rowFigures.length).toBeGreaterThanOrEqual(2);
    expect(addPrintedFigures(rowFigures.map(printedFigure))).toBe(
      printedFigure(await card.getByTestId("radiation-dose-total").innerText())
    );

    // Clean up the studies we created.
    for (const marker of [DOSE_REGION, DOSE_SUM_REGION]) {
      const created = list.getByRole("row").filter({ hasText: marker });
      await hydratedClick(page, created.getByLabel("Record actions"));
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
          .prepare(
            "DELETE FROM imaging_studies WHERE body_region IN (?, ?, ?, ?)"
          )
          .run(BREAKDOWN_REGION, EXCLUDED_REGION, OLD_REGION, UNDATED_REGION);
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

    await toastsCleared(page);

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

    await toastsCleared(page);

    // A chest X-ray from FIVE years ago — inside the record, outside the 3-year lens.
    // It is what makes the headline and the lens two different numbers, and what makes
    // the since-label a date the clock cannot produce on its own.
    await hydratedClick(page, page.getByTestId("add-imaging-panel-toggle"));
    const oldForm = page.getByTestId("imaging-study-form");
    await expect(oldForm).toBeVisible();
    await oldForm.getByLabel("Modality").selectOption("x-ray");
    await oldForm.getByLabel("Body region").fill(OLD_REGION);
    await oldForm.getByLabel("Study date").fill(oldDate());
    await page.keyboard.press("Escape");
    await submitWithToast(
      page,
      oldForm.getByRole("button", { name: "Add", exact: true }),
      "Study saved"
    );

    await toastsCleared(page);

    // An UNDATED ultrasound: it can never count, and no date would change that.
    await hydratedClick(page, page.getByTestId("add-imaging-panel-toggle"));
    const undatedForm = page.getByTestId("imaging-study-form");
    await expect(undatedForm).toBeVisible();
    await undatedForm.getByLabel("Modality").selectOption("ultrasound");
    await undatedForm.getByLabel("Body region").fill(UNDATED_REGION);
    await submitWithToast(
      page,
      undatedForm.getByRole("button", { name: "Add", exact: true }),
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

    // The five-year-old X-ray is in the headline's rows…
    await expect(
      details
        .getByTestId("radiation-dose-contribution")
        .filter({ hasText: OLD_REGION })
    ).toContainText("est.");

    // …and NOT in the 3-year lens, so the two figures differ. Both surface swaps the
    // review found — headline↔lens, and since-date↔lens-start — shipped green while
    // every study in this fixture was recent, because nothing rendered could tell the
    // two numbers apart (#2970 R3/R4).
    const headline = msvFigure(
      await card.getByTestId("radiation-dose-total").innerText()
    );
    const lens = msvFigure(
      await card.getByTestId("radiation-dose-window").innerText()
    );
    expect(headline).toBeGreaterThan(lens);

    // The since-label names the OLDEST CONTRIBUTING STUDY, not the window start the
    // clock would produce.
    const since = card.getByTestId("radiation-dose-since");
    await expect(since).toContainText(oldDate().slice(0, 4));
    await expect(since).not.toContainText(lensStartYear());

    // The undated ULTRASOUND is named for what it is, and is not told that a date
    // would include it — a date would change nothing about a non-ionizing study.
    const undated = details
      .getByTestId("radiation-dose-exclusion")
      .filter({ hasText: UNDATED_REGION });
    await expect(undated).toContainText("No ionizing radiation.");
    await expect(undated).not.toContainText("Add a date");

    // Clean up the studies we created.
    for (const marker of [
      BREAKDOWN_REGION,
      EXCLUDED_REGION,
      OLD_REGION,
      UNDATED_REGION,
    ]) {
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

  test("a record where nothing counted still says what it holds (#2970)", async ({
    browser,
  }) => {
    // READ-ONLY, on the records-enrichment fixture's own profile, whose entire imaging
    // record is one knee MRI. That record is the case the card used to delete itself
    // on: no contributing study, so no total, so no card — while the study list went on
    // showing dose chips for any undated X-ray in the same record. Named-not-silent
    // fails hardest exactly where nothing can be attributed, so the card renders and
    // says so.
    const page = await loginAs(browser, {
      username: E2E_LOGIN_RECS_ENRICH,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/results/imaging");

    const card = page.getByTestId("radiation-dose-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("radiation-dose-none")).toContainText(
      "Nothing in your records counts toward a dose."
    );
    // No headline figure, because there is no dose to state.
    await expect(card.getByTestId("radiation-dose-total")).toHaveCount(0);

    const details = card.getByTestId("radiation-dose-breakdown");
    await expect(details.locator("summary")).toContainText(
      "Why nothing counted"
    );
    if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
      await details.locator("summary").click();
    }
    await expect(details).toHaveJSProperty("open", true);
    await expect(
      details.getByTestId("radiation-dose-exclusion").filter({ hasText: "MRI" })
    ).toContainText("No ionizing radiation.");
  });
});
