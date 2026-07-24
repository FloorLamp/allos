import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";

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
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

const TOOTH = "96"; // out of the seeded 1–32 range → collision-free
const FINDING = "E2EComboFinding";
const NEW_PROVIDER = "E2E Combobox Clinic";
const SPECIALTY_DOC = "E2E Specialty Doc";
const SUPP = "E2EComboSupp";
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
      .getByRole("button")
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
      page
        .getByRole("listbox")
        .getByRole("button")
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
    await page
      .getByTestId("dental-procedure-form")
      .getByRole("combobox", { name: "Provider" })
      .fill("Combobox Clinic");
    await expect(
      page
        .getByRole("listbox")
        .getByRole("button")
        .filter({ hasText: NEW_PROVIDER })
        .first() // first-ok: transient list opened by typing; first match is the just-created provider
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
    const match = page
      .getByRole("listbox")
      .getByRole("button")
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
    const addCard = page.getByTestId("add-supplement-card");
    await expect(addCard).toBeVisible();

    // Create a situational supplement keyed to a brand-NEW situation via create-on-type.
    const nameField = addCard.getByRole("combobox", {
      name: "Name",
      exact: true,
    });
    await nameField.fill(SUPP);
    await addCard.getByLabel("When").selectOption("situational");
    const situation = addCard.getByRole("combobox", { name: "Situation" });
    await situation.fill(CUSTOM_SITUATION);
    await addCard
      .getByRole("listbox")
      .getByRole("button", { name: new RegExp(`Use .*${CUSTOM_SITUATION}`) })
      .click();
    await settledClick(
      page,
      addCard.getByRole("button", { name: "Add", exact: true })
    );
    // Add resets the form's Name field on success.
    await expect(nameField).toHaveValue("");

    // The custom situation is now part of the profile's vocabulary, so re-opening the
    // picker OFFERS it — the datalist's canned-only option source (the #1177 defect)
    // would never surface it. A fuzzy fragment finds it.
    await nameField.fill("another");
    await addCard.getByLabel("When").selectOption("situational");
    await addCard.getByRole("combobox", { name: "Situation" }).fill("E2EMig");
    await expect(
      addCard
        .getByRole("listbox")
        .getByRole("button")
        .filter({ hasText: CUSTOM_SITUATION })
        .first() // first-ok: transient list opened by typing; the created situation is the intended option
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
    const addCard = page.getByTestId("add-supplement-card");
    await expect(addCard).toBeVisible();

    const amount = addCard.getByLabel("Amount");
    // getByLabel("Amount") must resolve to exactly the input — the Clear button that
    // appears once the field has a value must NOT also claim the "Amount" label (the
    // shard-2 `medication-prefill` strict-mode double-match).
    await amount.fill("500 mg");
    await expect(amount).toHaveValue("500 mg");
    await expect(addCard.getByRole("listbox")).toBeVisible();

    // Focusing the sibling select dismisses the dropdown (blur-close), so the "Add
    // dose" button beneath it is no longer obscured and the click lands — a second
    // dose row appears.
    await addCard.getByLabel("Time of day").selectOption("Morning");
    await expect(addCard.getByRole("listbox")).toHaveCount(0);
    await addCard
      .getByRole("button", { name: "Add dose", exact: true })
      .click();
    await expect(addCard.getByLabel("Amount")).toHaveCount(2);
    // No submit — nothing is written to the DB.
  });
});
