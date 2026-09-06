import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  hydratedClick,
  openCombobox,
  settledClick,
  settledFill,
} from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_BIOMARKER_PICKER,
  E2E_MEMBER_PASSWORD,
  BIOMARKER_PICKER_OVERDUE,
} from "./fixture-logins";

// Relevance-ranked biomarker pickers (#1675). ~200 canonical analytes used to render
// alphabetically on every picker, so the handful that matter right now were buried.
// The two biomarker surfaces are driven here — Compare A/B and the record form's
// canonical-name field on Results. Trends' retired cross-domain ★ picker is now the
// Body census's metric-only final cell (#3387); its first case below preserves the
// shared picker mechanics (ranked empty view, fuzzy search, same save action) without
// pretending a clinical-result save produces a Body tile.
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
  test("the Body census picker is ranked, fuzzy-searches, and stars through the same action", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_BIOMARKER_PICKER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/trends?view=tiles");
      const grid = page.getByTestId("body-metric-tiles");
      const slot = grid.getByTestId("save-trend-picker-slot");
      await hydratedClick(page, slot.getByTestId("save-trend-picker-toggle"));
      const picker = slot.getByTestId("save-trend-picker");
      await expect(picker).toBeVisible();

      // The `<select>` is the pre-hydration / no-JS rendering; the mounted client swaps
      // in the shared Combobox, which is what carries the ranked, group-headed list.
      // Addressed as an input on purpose: that is what waits out the swap.
      const field = picker.locator('input[role="combobox"]');
      await expect(field).toHaveAttribute("aria-label", "Pin metric");
      const listbox = await openCombobox(page, field);

      // The empty view follows the census rank rather than alphabetizing the
      // registry, and includes non-legacy metrics such as Steps.
      await expect(groups(listbox)).toHaveText(["Metrics"]);
      await expect(
        options(listbox).filter({ hasText: "Daily Steps" })
      ).toHaveCount(1);

      // Typing is the app-wide fuzzy search, FLAT — a header over one match is noise
      // — and the best match leads. That is the assertion, not the exact result set:
      // what else a short query matches is a property of the VOCABULARY, not of this
      // picker, and pinning the array over a shared seed is the #2353 shape. Since
      // #2382 an analyte's curated alias spellings are search keys of their own, so
      // "Glycated Hemoglobin" also carries the subsequence l…d…l and trails far
      // behind at 2.81 to LDL Cholesterol's 11.85.
      await settledFill(page, field, "steps");
      const stepsLead = options(listbox).first(); // eslint-disable-line no-restricted-properties -- first-ok: the LEADING fuzzy match is the assertion
      await expect(stepsLead).toHaveText("Daily Steps");
      await expect(groups(listbox)).toHaveCount(0);

      // Picking + Star writes through the SAME toggleSavedItem the ★ uses anywhere
      // else: the proof is the tile, not a toast.
      // The option row IS the button, so it is addressed on the listbox, not inside
      // an option. `exact` makes a duplicate label fail loudly (#531).
      await listbox
        .getByRole("option", { name: "Daily Steps", exact: true })
        .click();
      await expect(field).toHaveValue("Daily Steps");
      await settledClick(page, picker.getByRole("button", { name: "Star" }));
      const tile = page.getByTestId("body-tile-steps");
      await expect(tile).toHaveCount(1);

      // Restore the fixture so --repeat-each stays clean: a saved analyte is withdrawn
      // from the picker's options, so leaving it starred would break the next run.
      await hydratedClick(page, tile.getByTestId("overflow-menu-trigger"));
      const menu = page.getByTestId("trend-tile-menu");
      await expect(menu).toBeVisible();
      await settledClick(page, menu.getByTestId("star-toggle"));
      // The unstar revalidates the whole hub (head plus the streamed censuses) before
      // the tile can leave the grid, so this settles later than the default allows on a
      // loaded machine. A named ceiling, not a sleep.
      await expect(
        page.locator(
          '[data-testid="pinned-census-tile"][data-tile-key="metric:steps"]'
        )
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
      await expect(options(listbox).first()).toHaveText("— none —"); // eslint-disable-line no-restricted-properties -- first-ok: the clear row is pinned to the top by construction
      await expect(groups(listbox).first()).toHaveText(RELEVANT_GROUP); // eslint-disable-line no-restricted-properties -- first-ok: the LEADING header is the assertion
      await expect(options(listbox).nth(1)).toHaveText(
        BIOMARKER_PICKER_OVERDUE
      );

      // EVERY BUCKET IS REPRESENTED BEFORE TYPING (#3410), and the list is still
      // eight rows at most. This is the widest grouped picker that ships — the
      // ungrouped clear row plus three headers — so it is where the invariant is
      // cheapest to watch. It is NOT a discriminating regression test: no shipped
      // picker today has enough rows ahead of its last bucket to lose one, which is
      // exactly why #3410 was latent and was found by BUILDING a new picker (#3220)
      // rather than by reading the component. The exhaustive rule — two ranked
      // vocabularies concatenated, and what happens when there are more groups than
      // rows — is pinned in lib/__tests__/relevance-view.test.ts.
      await expect(groups(listbox)).toHaveText([
        RELEVANT_GROUP,
        "Metrics",
        YOUR_GROUP,
      ]);
      expect(await options(listbox).count()).toBeLessThanOrEqual(8);

      // A pick writes the series key into cmpA — the param the overlay reads, which
      // #1675 did not touch.
      await listbox
        .getByRole("option", { name: BIOMARKER_PICKER_OVERDUE, exact: true })
        .click();
      await expect(page).toHaveURL(/cmpA=result%3AHemoglobin\+A1c/);
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
      // ?new=1 opens the Clinical results add panel directly.
      // Its modal is portalled, so the form is addressed through the dialog rather
      // than through the panel's own container.
      await page.goto("/results/clinical-results?new=1");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      const field = dialog.getByRole("combobox", { name: "Canonical name" });
      const listbox = await openCombobox(page, field);

      // Same rank, same headers — and this field offers the WHOLE canonical
      // vocabulary, which is where being buried hurt most.
      const leadOption = options(listbox).first(); // eslint-disable-line no-restricted-properties -- first-ok: the LEADING option is the assertion
      const leadGroup = groups(listbox).first(); // eslint-disable-line no-restricted-properties -- first-ok: the LEADING header is the assertion
      await expect(leadGroup).toHaveText(RELEVANT_GROUP);
      await expect(leadOption).toHaveText(BIOMARKER_PICKER_OVERDUE);
      await expect(groups(listbox).nth(1)).toHaveText(YOUR_GROUP);
      await expect(groups(listbox).nth(2)).toHaveText("All biomarkers");

      // Typing still reaches an analyte this profile has never measured — a picker
      // RANKS, it does not filter — and reaches it by the app's fuzzy, non-prefix
      // match, which is what a `<select>` could never offer.
      await settledFill(page, field, "tsh");
      await expect(
        listbox.getByRole("option", {
          name: "Thyroid-Stimulating Hormone (TSH)",
          exact: true,
        })
      ).toBeVisible();

      // …and it reaches an analyte by its own ABBREVIATION (#2382). The matcher is a
      // greedy leftmost subsequence walk that never backtracks, so `psa` was consumed
      // scattered inside "Prostate-Specific" and the literal "(PSA)" at the end was
      // never reached: the entry appeared at NO position. The abbreviation is a search
      // key of its own now, so it leads.
      //
      // Deliberately not an exact-array pin (#2353): what else `psa` matches is a
      // property of the dataset, not of this picker. The lead row is the claim.
      await settledFill(page, field, "psa");
      await expect(leadOption).toHaveText("Prostate-Specific Antigen (PSA)");
    } finally {
      await page.context().close();
    }
  });
});
