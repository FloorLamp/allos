import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import Database from "better-sqlite3";
import {
  comboboxRows,
  hydratedClick,
  settledClick,
  settledFill,
} from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_NUTRITION,
  E2E_MEMBER_PASSWORD,
  NUTRITION_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Combobox migration (#1176/#1177): the native <datalist> autocompletes are now the
// shared Combobox. This drives the three behaviours the migration adds that the native
// control could not: (1) the ProviderCombobox — fuzzy non-prefix match, an
// individual-vs-organization LEADING icon, and create-on-type that still submits the
// name unchanged; (2) the provider SPECIALTY picker — fuzzy search over the long NUCC
// taxonomy; (3) the item-form SITUATION picker offering the profile's OWN vocabulary
// (the #1177 regression: the datalist offered only the canned suggestions).
//
// Fixture discipline (shared seeded DB): every row this spec plants carries a unique
// marker and a raw-connection cleanup runs before AND after, so it only ever touches
// rows it created and stays idempotent across CI retries. The provider registry is
// GLOBAL, so the created providers are deleted by name here.
const DB_PATH = workerDbPath();

const TOOTH = "96"; // out of the seeded 1–32 range → collision-free
const FINDING = "E2EComboFinding";
const NEW_PROVIDER = "E2E Combobox Clinic";
const SPECIALTY_DOC = "E2E Specialty Doc";
const SUPP = "E2EComboSupp";
// A NAME NO OTHER TEST IN THIS FILE MAY WRITE. The a11y test below asserts that a
// FREE-TEXT row renders, which is true only while the typed name is NOT in the
// profile's supplement vocabulary — and the situation-picker test above SAVES a
// supplement called SUPP. Sharing the name made the a11y test pass alone and fail
// deterministically whenever that sibling ran first on the same worker (each
// Playwright WORKER gets a DB copy, not each test; this file's cleanup is
// beforeAll/afterAll). "No submit — nothing is written" is true of the a11y test
// itself, which is exactly what hid the coupling: the write is the neighbour's.
const A11Y_SUPP = "E2EComboA11ySupp";
const CUSTOM_SITUATION = "E2EMigraine";

function withDb<T>(fn: (db: InstanceType<typeof Database>) => T): T {
  const db = new Database(DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function cleanup() {
  withDb((db) => {
    db.prepare("DELETE FROM dental_procedures WHERE tooth = ?").run(TOOTH);
    db.prepare("DELETE FROM providers WHERE name IN (?, ?)").run(
      NEW_PROVIDER,
      SPECIALTY_DOC
    );
    db.prepare(
      `DELETE FROM intake_item_doses WHERE item_id IN
         (SELECT id FROM intake_items WHERE name = ?)`
    ).run(SUPP);
    db.prepare("DELETE FROM intake_items WHERE name = ?").run(SUPP);
    db.prepare("DELETE FROM situations WHERE name = ?").run(CUSTOM_SITUATION);
  });
}

test.describe("Combobox migration (#1176/#1177)", () => {
  test.beforeAll(() => {
    cleanup();
    // A throwaway individual provider for the specialty test, so we never mutate a
    // seeded provider's specialty.
    withDb((db) => {
      db.prepare(
        "INSERT INTO providers (name, type, dedup_key) VALUES (?, 'individual', ?)"
      ).run(SPECIALTY_DOC, `name:individual:${SPECIALTY_DOC.toLowerCase()}`);
    });
  });
  test.afterAll(cleanup);

  test("provider picker: fuzzy match, type icons, and create-on-type submit", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/records/specialty/dental");
    await hydratedClick(
      page,
      page.getByTestId("add-dental-record-panel-toggle")
    );
    const form = page.getByTestId("dental-procedure-form");
    await expect(form).toBeVisible();
    await form.getByLabel("Procedure / finding").fill(FINDING);
    await form.getByLabel("Tooth").fill(TOOTH);

    const provider = form.getByRole("combobox", { name: "Provider" });

    // (1) Fuzzy, non-prefix: "patel" finds the seeded "Dr. Anita Patel" (an
    // individual), which the person icon marks — rendered LEADING (before the label).
    await provider.fill("patel");
    const listbox = page.getByRole("listbox");
    const indivOption = listbox
      .getByRole("option")
      .filter({ hasText: /Patel/ })
      .first(); // first-ok: transient list this spec just opened by typing "patel"; the first Patel match is the intended row
    await expect(indivOption).toBeVisible();
    const icon = indivOption.getByTestId("provider-icon-individual");
    await expect(icon).toBeVisible();
    // Leading, not trailing: the icon sits to the LEFT of the label text.
    const iconBox = await icon.boundingBox();
    const optionBox = await indivOption.boundingBox();
    expect(iconBox!.x).toBeLessThan(optionBox!.x + optionBox!.width / 2);

    // (2) An organization shows the building icon instead.
    await provider.fill("quest");
    await expect(
      comboboxRows(page)
        .filter({ hasText: /Quest/ })
        .first() // first-ok: transient list opened by typing "quest"; first Quest match is intended
        .getByTestId("provider-icon-organization")
    ).toBeVisible();

    // (3) Create-on-type: a novel name offers a "Use …" row; picking it keeps the
    // typed name, which submits unchanged (write path resolves/creates by name).
    await provider.fill(NEW_PROVIDER);
    await page
      .getByRole("listbox")
      .getByRole("button", { name: new RegExp(`Use .*${NEW_PROVIDER}`) })
      .click();
    await settledClick(
      page,
      form.getByRole("button", { name: "Add", exact: true })
    );
    await expect(page.getByText("Record saved")).toBeVisible();

    // The created provider now exists — reopening the picker offers it (proving the
    // create-on-type name reached the registry).
    await page.reload();
    await hydratedClick(
      page,
      page.getByTestId("add-dental-record-panel-toggle")
    );
    await page
      .getByTestId("dental-procedure-form")
      .getByRole("combobox", { name: "Provider" })
      .fill("Combobox Clinic");
    await expect(
      comboboxRows(page).filter({ hasText: NEW_PROVIDER }).first() // first-ok: transient list opened by typing; first match is the just-created provider
    ).toBeVisible();
  });

  test("specialty picker fuzzy-matches the NUCC taxonomy", async ({ page }) => {
    const id = withDb(
      (db) =>
        (
          db
            .prepare("SELECT id FROM providers WHERE name = ?")
            .get(SPECIALTY_DOC) as { id: number }
        ).id
    );
    await page.goto(`/providers/${id}`);
    await page.getByTestId("provider-edit-button").click();
    const editForm = page.getByTestId("provider-edit-form");
    await expect(editForm).toBeVisible();

    // "cardio" is a non-prefix token; the NUCC taxonomy carries many "Cardio…"
    // labels the native prefix-only datalist would have missed.
    const specialty = editForm.getByRole("combobox", { name: "Specialty" });
    await specialty.fill("cardio");
    const match = comboboxRows(page)
      .filter({ hasText: /cardio/i })
      .first(); // first-ok: transient NUCC list opened by typing "cardio"; first match is the intended pick
    await expect(match).toBeVisible();
    const picked = (await match.textContent())!.trim();
    await match.click();

    await settledClick(page, editForm.getByRole("button", { name: "Save" }));
    await expect(page.getByTestId("provider-specialty")).toContainText(picked);
  });

  test("item-form situation picker offers the profile's own custom situation (#1177)", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/nutrition?tab=supplements");
    // The add-mode intake form lives behind the "Add supplement" modal.
    await hydratedClick(page, page.getByTestId("supplement-add-toggle"));
    let addForm = page.getByRole("dialog", { name: "Add supplement" });
    await expect(addForm).toBeVisible();

    // Create a situational supplement keyed to a brand-NEW situation via create-on-type.
    const nameField = addForm.getByRole("combobox", {
      name: "Name",
      exact: true,
    });
    await settledFill(page, nameField, SUPP);
    // Since #3216 "only take it when X" is a RULE SENTENCE over the same two columns
    // (condition + situation), not a When select plus a Situation combobox.
    const rules = await openFact(page, "rules", addForm);
    await rules.getByTestId("intake-rule-add-only-when").click();
    const situation = rules.getByRole("combobox", {
      name: "Situation",
      exact: true,
    });
    // A RAW fill here is the #2742 swallow: before React owns the input the value is
    // set on the DOM node and reverted at hydration, so the list stays on its
    // empty-query view and the "Use “…”" row — which exists only when the typed value
    // is not already an option — never renders. settledFill waits for the fiber.
    await settledFill(page, situation, CUSTOM_SITUATION);
    // Portaled listbox (#3271) — resolved from the page, not the form.
    await page
      .getByRole("listbox")
      .getByRole("button", { name: new RegExp(`Use .*${CUSTOM_SITUATION}`) })
      .click();
    await closeEditor(page, addForm);
    await settledClick(
      page,
      addForm.getByRole("button", { name: "Add", exact: true })
    );
    // Add closes the modal on success (the reset-on-reopen contract lives in
    // supplement-add-reset.spec.ts).
    await expect(addForm).toHaveCount(0);

    // The custom situation is now part of the profile's vocabulary, so re-opening the
    // picker OFFERS it — the datalist's canned-only option source (the #1177 defect)
    // would never surface it. A fuzzy fragment finds it.
    await hydratedClick(page, page.getByTestId("supplement-add-toggle"));
    addForm = page.getByRole("dialog", { name: "Add supplement" });
    await settledFill(
      page,
      addForm.getByRole("combobox", { name: "Name", exact: true }),
      "another"
    );
    const reopened = await openFact(page, "rules", addForm);
    await reopened.getByTestId("intake-rule-add-only-when").click();
    await settledFill(
      page,
      reopened.getByRole("combobox", { name: "Situation", exact: true }),
      "E2EMig"
    );
    await expect(
      // Portaled listbox (#3271) — resolved from the page, not the form.
      comboboxRows(page).filter({ hasText: CUSTOM_SITUATION }).first() // first-ok: transient list opened by typing; the created situation is the intended option
    ).toBeVisible();
  });

  test("an open suggestion dropdown dismisses so a control below it stays clickable (#1177 regression)", async ({
    page,
  }) => {
    // The dose-amount Combobox's absolutely-positioned dropdown overlays the "Add
    // dose" button beneath it. The native <datalist> popover auto-closed; the
    // replacement must dismiss too (on blur / pointerdown-outside) or its overlay eats
    // the next control's click (the shard-1 `dose-history` interception).
    await page.goto("/nutrition?tab=supplements");
    // The add-mode intake form lives behind the "Add supplement" modal.
    await page.getByTestId("supplement-add-toggle").click();
    const addCard = page.getByRole("dialog", { name: "Add supplement" });
    await expect(addCard).toBeVisible();

    const doseEditor = await openFact(page, "dose", addCard);
    const amount = doseEditor.getByLabel("Amount");
    // getByLabel("Amount") must resolve to exactly the input — the Clear button that
    // appears once the field has a value must NOT also claim the "Amount" label (the
    // shard-2 `medication-prefill` strict-mode double-match).
    await amount.fill("500 mg");
    await expect(amount).toHaveValue("500 mg");
    // Portaled listbox (#3271): open/closed is asked of the page, not the dialog.
    await expect(page.getByRole("listbox")).toBeVisible();

    // Focusing the sibling select dismisses the dropdown (blur-close), so the "Add
    // dose" button beneath it is no longer obscured and the click lands — a second
    // dose row appears.
    await doseEditor.getByLabel("Time of day").selectOption("Morning");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await doseEditor
      .getByRole("button", { name: "Add dose", exact: true })
      .click();
    await expect(doseEditor.getByLabel("Amount")).toHaveCount(2);
    // No submit — nothing is written to the DB.
  });

  // #3316 — the keyboard model was there and worked; it was only UNOBSERVABLE. The
  // listbox held plain buttons, so `role="listbox"` had no `option` children at all
  // and arrowing moved a highlight nothing announced. This drives the wiring an
  // assistive technology actually reads: what the rows ARE, and which one the input
  // says is active.
  test("the listbox exposes options, and the input names the active one (#3316)", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/nutrition?tab=supplements");
    await hydratedClick(page, page.getByTestId("supplement-add-toggle"));
    const addCard = page.getByRole("dialog", { name: "Add supplement" });
    await expect(addCard).toBeVisible();

    const field = addCard.getByLabel("Name");
    await settledFill(page, field, "vitamin");
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();

    // (1) The rows are OPTIONS. Before #3316 this locator found nothing: a listbox
    // with no items, as far as the a11y tree was concerned.
    const options = listbox.getByRole("option");
    expect(await options.count()).toBeGreaterThan(1);

    // (2) The input NAMES the active row, and (3) that row is the selected one.
    const firstId = await options.nth(0).getAttribute("id");
    expect(firstId).toBeTruthy();
    await expect(field).toHaveAttribute("aria-activedescendant", firstId!);
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "false");

    // (4) Arrowing MOVES it — the assertion the old highlight could not support.
    await field.press("ArrowDown");
    const secondId = await options.nth(1).getAttribute("id");
    expect(secondId).not.toBe(firstId);
    await expect(field).toHaveAttribute("aria-activedescendant", secondId!);
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");

    // (5) Enter takes the row aria-activedescendant names — the same row, not the
    // one that merely looks highlighted.
    const secondLabel = (await options.nth(1).innerText()).trim();
    await field.press("Enter");
    await expect(field).toHaveValue(secondLabel);

    // (6) THE FREE-TEXT ROW IS A COMMAND, NOT AN OPTION. "Use '<query>'" acts on what
    // the user typed; it does not name something the picker offers, so exposing it as
    // an `option` would tell a screen-reader user the vocabulary contains their typo.
    // It stays a button — and aria-activedescendant still names it, which announces
    // it as the button it is.
    await settledFill(page, field, A11Y_SUPP);
    const useRow = listbox.getByRole("button", {
      name: new RegExp(`Use .*${A11Y_SUPP}`),
    });
    await expect(useRow).toBeVisible();
    await expect(listbox.getByRole("option")).toHaveCount(0);
    await expect(field).toHaveAttribute(
      "aria-activedescendant",
      (await useRow.getAttribute("id"))!
    );
    // No submit — nothing is written to the DB.
  });

  // A FIELD WITH NOTHING TO SHOW MUST NOT SAY IT IS EXPANDED (#3316/#3100).
  //
  // `aria-expanded` used to track `open` — the field's own idea of whether it has
  // focus — while the <ul> renders only when there is a row to put in it. The two
  // come apart for a free-text picker whose vocabulary is EMPTY and whose value is
  // still blank, and the widget then announced aria-expanded="true" with no listbox
  // in the document and an aria-controls pointing at an id that does not exist.
  //
  // #3100 makes that state ORDINARY: the stack vocabulary is whatever THIS profile
  // has called a stack, so it is empty for every profile that has never named one.
  //
  // WHY A SECOND LOGIN RATHER THAN THE ADMIN SESSION. Profile 1 is not in that
  // state — `scripts/seed.ts` gives its Vitamin D3 and K2 a stack called "D3 + K2",
  // which is also the field's placeholder text and reads like a placeholder in a
  // grep. The Nutrition Trio profile keeps supplements and no stack, so it is the
  // one that renders the empty vocabulary. The emptiness is ASSERTED below rather
  // than assumed: a seed that later names a stack there must fail this loudly
  // instead of quietly testing the populated case.
  test("an empty vocabulary is not announced as an expanded listbox (#3316)", async ({
    browser,
  }) => {
    test.slow();
    const profileId = withDb(
      (db) =>
        (
          db
            .prepare("SELECT id FROM profiles WHERE name = ?")
            .get(NUTRITION_PROFILE) as { id: number }
        ).id
    );
    const stacksNamed = withDb(
      (db) =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM intake_items
                 WHERE profile_id = ? AND stack IS NOT NULL AND TRIM(stack) <> ''`
            )
            .get(profileId) as { n: number }
        ).n
    );
    // The precondition, stated: this profile's stack vocabulary is empty, which is
    // the whole reason the field below has nothing to show.
    expect(stacksNamed).toBe(0);

    const page = await loginAs(browser, {
      username: E2E_LOGIN_NUTRITION,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/nutrition?tab=supplements");
      await hydratedClick(page, page.getByTestId("supplement-add-toggle"));
      const addCard = page.getByRole("dialog", { name: "Add supplement" });
      await expect(addCard).toBeVisible();

      const editor = await openFact(page, "identity", addCard);
      const stack = editor.getByLabel("Stack (optional)");
      await stack.click();

      // THE ABSENCE, and then the PRESENCE that makes the absence mean something. A
      // "no listbox" assertion passes just as well against a field that never woke
      // up, so the same field is made to expand for real a few lines down — same
      // element, same session — before the absence is asserted again.
      await expect(stack).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(stack).not.toHaveAttribute("aria-controls", /.*/);

      await settledFill(page, stack, "E2EComboStack");
      await expect(stack).toHaveAttribute("aria-expanded", "true");
      const listbox = page.getByRole("listbox");
      await expect(listbox).toBeVisible();
      // aria-controls now RESOLVES — the id names the list that is actually there.
      await expect(stack).toHaveAttribute(
        "aria-controls",
        (await listbox.getAttribute("id"))!
      );

      await stack.fill("");
      await expect(stack).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      // No submit — nothing is written to the DB.
    } finally {
      await page.context().close();
    }
  });
});
