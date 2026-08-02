import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import { openCombobox, settledClick, settledFill } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_BIOMARKER_PICKER,
  E2E_MEMBER_PASSWORD,
  BIOMARKER_PICKER_OVERDUE,
  BIOMARKER_PICKER_FLAGGED,
  BIOMARKER_PICKER_MEASURED,
} from "./fixture-logins";

// Relevance-ranked biomarker pickers (#1675). ~200 canonical analytes used to render
// alphabetically on every picker, so the handful that matter right now were buried.
// Three of the census surfaces are driven here — the ★ picker on Trends Overview, the
// Compare A/B pickers, and the record form's canonical-name field on Results — because
// the claim of the issue is that they all read ONE ranking, so proving it on a single
// surface would prove nothing about the others.
//
// The fixture profile (e2e/seed/trends.ts, seedBiomarkerPickerRank) owns exactly three
// analytes, deliberately in ANTI-alphabetical relevance order:
//   Hemoglobin A1c  — drawn ~400 days ago on a 90-day cadence → retest DUE
//   LDL Cholesterol — drawn 10 days ago, well over the band   → FLAGGED
//   Albumin         — drawn 10 days ago, in range             → merely measured, and
//                     alphabetically FIRST, which is what an A–Z picker led with.

const RELEVANT_GROUP = "Due or flagged";
const YOUR_GROUP = "Your markers";

function groups(listbox: Locator): Locator {
  return listbox.getByTestId("combobox-group");
}

function options(listbox: Locator): Locator {
  return listbox.getByTestId("combobox-option");
}

test.describe("relevance-ranked biomarker pickers (#1675)", () => {
  test("the ★ picker opens on the markers that matter, fuzzy-searches, and still stars through the same action", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_BIOMARKER_PICKER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/trends");
      const picker = page.getByTestId("save-trend-picker");
      await expect(picker).toBeVisible();

      // The `<select>` is the pre-hydration / no-JS rendering; the mounted client swaps
      // in the shared Combobox, which is what carries the ranked, group-headed list.
      // Addressed as an input on purpose: that is what waits out the swap.
      const field = picker.locator('input[role="combobox"]');
      await expect(field).toHaveAttribute("aria-label", "Add to your overview");
      const listbox = await openCombobox(page, field);

      // The relevance view, whole: the overdue draw leads, the flagged one follows,
      // and the alphabetically-first analyte — what the old A–Z picker led with — is
      // demoted behind both, under a header that says why.
      await expect(options(listbox)).toHaveText([
        BIOMARKER_PICKER_OVERDUE,
        BIOMARKER_PICKER_FLAGGED,
        BIOMARKER_PICKER_MEASURED,
      ]);
      await expect(groups(listbox)).toHaveText([RELEVANT_GROUP, YOUR_GROUP]);

      // Typing is the app-wide fuzzy search, flat: a header over one match is noise.
      await settledFill(page, field, "ldl");
      await expect(options(listbox)).toHaveText([BIOMARKER_PICKER_FLAGGED]);
      await expect(groups(listbox)).toHaveCount(0);

      // Picking + Star writes through the SAME toggleSavedItem the ★ uses anywhere
      // else: the proof is the tile, not a toast.
      await options(listbox)
        .getByRole("button", { name: BIOMARKER_PICKER_FLAGGED, exact: true })
        .click();
      await expect(field).toHaveValue(BIOMARKER_PICKER_FLAGGED);
      await settledClick(page, picker.getByRole("button", { name: "Star" }));
      const tile = page
        .getByTestId("trend-mini-card")
        .filter({ hasText: BIOMARKER_PICKER_FLAGGED });
      await expect(tile).toHaveCount(1);

      // Restore the fixture so --repeat-each stays clean: a saved analyte is withdrawn
      // from the picker's options, so leaving it starred would break the next run.
      await tile.getByTestId("overflow-menu-trigger").click();
      const menu = page.getByTestId("trend-tile-menu");
      await expect(menu).toBeVisible();
      await settledClick(page, menu.getByTestId("star-toggle"));
      // The unstar revalidates the whole hub (head plus the streamed censuses) before
      // the tile can leave the grid, so this settles later than the default allows on a
      // loaded machine. A named ceiling, not a sleep.
      await expect(
        page
          .getByTestId("trend-mini-card")
          .filter({ hasText: BIOMARKER_PICKER_FLAGGED })
      ).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await page.context().close();
    }
  });

  test("the Compare A/B picker reads the same rank and round-trips through the URL", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_BIOMARKER_PICKER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/trends?tab=insights");
      const field = page.locator("#cmp-a");
      const listbox = await openCombobox(page, field);

      // "— none —" is a real choice, so it heads the list ungrouped; the ranked
      // biomarker groups start immediately after it, ahead of the standard metrics.
      await expect(options(listbox).first()).toHaveText("— none —"); // first-ok: the clear row is pinned to the top by construction
      await expect(groups(listbox).first()).toHaveText(RELEVANT_GROUP); // first-ok: the LEADING header is the assertion
      await expect(options(listbox).nth(1)).toHaveText(
        BIOMARKER_PICKER_OVERDUE
      );

      // A pick writes the series key into cmpA — the param the overlay reads, which
      // #1675 did not touch.
      await options(listbox)
        .getByRole("button", { name: BIOMARKER_PICKER_OVERDUE, exact: true })
        .click();
      await expect(page).toHaveURL(/cmpA=bio%3AHemoglobin\+A1c/);
      await expect(field).toHaveValue(BIOMARKER_PICKER_OVERDUE);
    } finally {
      await page.context().close();
    }
  });

  test("the record form's canonical-name field opens on the same groups over the whole vocabulary", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_BIOMARKER_PICKER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // ?new=1 opens the add-result panel directly (the Biomarkers-page add slot).
      await page.goto("/results/biomarkers?new=1");
      const panel = page.getByTestId("add-result-panel");
      await expect(panel).toBeVisible();

      const field = panel.getByRole("combobox", { name: "Canonical name" });
      const listbox = await openCombobox(page, field);

      // Same rank, same headers — and this field offers the WHOLE canonical
      // vocabulary, which is where being buried hurt most.
      const leadOption = options(listbox).first(); // first-ok: the LEADING option is the assertion
      const leadGroup = groups(listbox).first(); // first-ok: the LEADING header is the assertion
      await expect(leadGroup).toHaveText(RELEVANT_GROUP);
      await expect(leadOption).toHaveText(BIOMARKER_PICKER_OVERDUE);
      await expect(groups(listbox).nth(1)).toHaveText(YOUR_GROUP);
      await expect(groups(listbox).nth(2)).toHaveText("All biomarkers");

      // Typing still reaches an analyte this profile has never measured — a picker
      // RANKS, it does not filter.
      await settledFill(page, field, "tsh");
      await expect(
        options(listbox).getByRole("button", { name: "TSH", exact: true })
      ).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});
