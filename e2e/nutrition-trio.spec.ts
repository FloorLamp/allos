import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_NUTRITION,
  E2E_MEMBER_PASSWORD,
  NUTRITION_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The nutrition trio (#974 protein gauge / #975 dietary preferences / #976 fiber
// adequacy), driven end-to-end against the dedicated NUTRITION_PROFILE (seed-events):
// a weigh-in, this-week food servings, a confirmed capsule fiber supplement, sex = male,
// and a flagged low omega-3. Fixture discipline (#868): the profile is spec-owned; the
// preferences test MUTATES the excluded set and resets it in afterEach so it's repeat-safe.
const DB_PATH = workerDbPath();
const WAIT = 15_000;

function clearPreferences() {
  const handle = new Database(DB_PATH);
  try {
    const pid = (
      handle
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(NUTRITION_PROFILE) as { id: number }
    ).id;
    handle
      .prepare(
        "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'dietary_excluded_groups'"
      )
      .run(pid);
  } finally {
    handle.close();
  }
}

test.describe("Nutrition trio", () => {
  // #974 — the protein band gauge.
  test("protein gauge renders today, weekly, and goal; a quick-add moves the today bar", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_NUTRITION,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/nutrition?tab=food");

      // The gauge shows all three values (today bar + weekly marker + goal band).
      const gauge = page.getByTestId("protein-gauge");
      await expect(gauge).toBeVisible({ timeout: WAIT });
      const todayBar = page.getByTestId("protein-gauge-today");
      await expect(todayBar).toBeVisible();
      await expect(page.getByTestId("protein-gauge-weekly")).toBeVisible();
      await expect(page.getByTestId("protein-gauge-band")).toBeVisible();

      // Today is IN PROGRESS — the compact label still marks the value as a floor.
      await expect(gauge).toContainText(/Today\s*≥\s*\d+g/i);

      const before = Number(await todayBar.getAttribute("data-grams"));
      expect(before).toBeGreaterThan(0);

      // A quick-add tap moves the today figure (on the action's revalidate) without a
      // manual reload — the quick-add card total and the gauge read the same source.
      const input = page.getByTestId("protein-quickadd-input");
      await input.fill("20");
      await settledClick(page, page.getByTestId("protein-quickadd-add"));
      await expect(page.getByTestId("protein-quickadd-total")).toContainText(
        /g today/,
        { timeout: WAIT }
      );
      // The gauge's today bar reflects the added grams after the revalidate. toPass
      // (last resort): the value we depend on is a data-attribute NUMBER that must
      // INCREASE, which a single toHaveAttribute can't express — settledClick already
      // guaranteed the action committed; this only re-reads the re-rendered attribute.
      await expect(async () => {
        const after = Number(
          await page
            .getByTestId("protein-gauge-today")
            .getAttribute("data-grams")
        );
        expect(after).toBeGreaterThan(before);
      }).toPass({ timeout: WAIT }); // topass-ok: re-read the gauge's data-grams NUMBER until it exceeds the baseline — 'increased' can't be one toHaveAttribute; settledClick already committed the write
    } finally {
      await page.close();
    }
  });

  // #976 — the fiber adequacy card + the honest unknown-grams note.
  test("fiber card renders basis-honest copy and the grams-unknown supplement note", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_NUTRITION,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/nutrition?tab=food");
      const fiber = page.getByTestId("fiber-adequacy");
      await expect(fiber).toBeVisible({ timeout: WAIT });
      // A non-tracked basis is a floor; the target names the DRI adequate intake.
      const fiberDetails = page.getByTestId("fiber-estimate-details");
      await expect(fiberDetails.getByTestId("fiber-intake")).toContainText(
        /floor/i
      );
      await expect(fiberDetails.getByTestId("fiber-target")).toContainText(
        /adequate intake/i
      );
      // The capsule fiber supplement contributes 0 g and is noted honestly.
      await expect(fiberDetails).toContainText(/grams unknown/i);
    } finally {
      await page.close();
    }
  });

  // #975 — dietary preferences: substitution + still-loggable + preset diverges to custom.
  test.describe("dietary preferences", () => {
    test.afterEach(clearPreferences);

    test("vegetarian preset substitutes plant omega-3, keeps fish loggable, and diverges to custom", async ({
      browser,
    }) => {
      const page = await loginAs(browser, {
        username: E2E_LOGIN_NUTRITION,
        password: E2E_MEMBER_PASSWORD,
      });
      try {
        // Pick the Vegetarian preset on Settings → Profile (autosaves on change).
        // AUTOSAVE DISCIPLINE for this whole block: every mutation is gated on the
        // card's "Saved" indicator BEFORE the next step, and a reload separates
        // consecutive mutations. Two rapid saves are concurrent Server-Action POSTs
        // and last-write-wins by ARRIVAL (CI caught the uncheck's write clobbering
        // the re-selected preset), while a reload with a save still in flight ABORTS
        // that save (a local run caught the set coming back empty). Gate, then
        // reload — the same pattern the format-prefs spec documents; the reload
        // also clears the indicator's linger so each gate refers to its own save.
        await page.goto("/settings/nutrition");
        const presetSelect = page.getByTestId("dietary-preset");
        await expect(presetSelect).toBeVisible({ timeout: WAIT });
        await presetSelect.selectOption("vegetarian");
        // The animal groups are now checked.
        await expect(
          page.getByTestId("dietary-exclude-fatty_fish")
        ).toBeChecked({ timeout: WAIT });
        await expect(page.getByLabel("Saved")).toBeVisible({ timeout: WAIT });
        await page.reload();
        await expect(presetSelect).toHaveValue("vegetarian", { timeout: WAIT });

        // Editing one group diverges the preset to "custom".
        await page.getByTestId("dietary-exclude-fatty_fish").uncheck();
        await expect(presetSelect).toHaveValue("custom", { timeout: WAIT });
        await expect(page.getByLabel("Saved")).toBeVisible({ timeout: WAIT });
        await page.reload();
        await expect(presetSelect).toHaveValue("custom", { timeout: WAIT });

        // Back to the clean vegetarian set for the substitution + loggability checks;
        // gate on the committed save before navigating away.
        await presetSelect.selectOption("vegetarian");
        await expect(presetSelect).toHaveValue("vegetarian", { timeout: WAIT });
        await expect(page.getByLabel("Saved")).toBeVisible({ timeout: WAIT });

        // The anchored sidebar row opens a modal with the muted preference note
        // (#980 item 4) — the demote/substitute is explicable without reflowing the
        // nutrition layout.
        await page.goto("/nutrition?tab=food");
        await page.getByTestId("nutrition-suggestions-summary").click();
        const prefNote = page.getByTestId("suggestions-preference-note");
        await expect(prefNote).toBeVisible({ timeout: WAIT });
        await expect(prefNote).toContainText(/vegetarian-friendly/i);
        await expect(prefNote).toHaveCSS("font-style", "normal");

        // The flagged low-omega-3 suggestion now leads with a plant source (nuts/seeds),
        // not fish — substitution, never blocked. Opening the modal is a pure
        // client toggle — no Server Action.
        const suggestions = page.getByTestId("nutrition-suggestions-panel");
        await expect(suggestions).toContainText(/walnut|flax|chia|algae/i, {
          timeout: WAIT,
        });
        await page
          .getByRole("dialog", { name: "Lab suggestions" })
          .getByRole("button", { name: "Close" })
          .click();

        // An excluded group (fatty fish) is still reachable in the log bar — demoted,
        // never removed. Its row + log control are present and clickable.
        const fishRow = page.getByTestId("food-group-fatty_fish");
        if (!(await fishRow.isVisible())) {
          await page.getByTestId("food-more-groups-summary").click();
        }
        await expect(page.getByTestId("food-group-fatty_fish")).toBeVisible({
          timeout: WAIT,
        });
        await expect(page.getByTestId("log-fatty_fish")).toBeEnabled();
      } finally {
        await page.close();
      }
    });
  });
});
