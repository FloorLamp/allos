import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// Provider merge picker + confirm disambiguation (issue #532). seed-events plants
// two organizations that share the name "E2E Duplicate Lab" (distinct identifiers +
// addresses). The admin merge picker option and the irreversible confirm must name
// them by the differing field, not the byte-identical name. We open the picker and
// the confirm and CANCEL — the two labs are unlinked, and we never confirm, so the
// shared fixture is untouched.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

// Both providers named "E2E Duplicate Lab", ordered by id (a → b).
function dupLabIds(): { a: number; b: number } {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT id FROM providers WHERE name = 'E2E Duplicate Lab' ORDER BY id"
      )
      .all() as { id: number }[];
    if (rows.length < 2) throw new Error("same-named provider fixture missing");
    return { a: rows[0].id, b: rows[1].id };
  } finally {
    db.close();
  }
}

test.describe("Provider merge disambiguation (#532)", () => {
  test("picker + confirm label same-named providers by the differing field", async ({
    page,
  }) => {
    const { a, b } = dupLabIds();

    // Land on lab A's detail; the merge panel lists every OTHER provider, so B
    // appears as a candidate.
    await page.goto(`/providers/${a}`);
    const merge = page.getByTestId("provider-merge");
    await expect(merge).toBeVisible();

    // B's option is disambiguated — it is NOT the bare "E2E Duplicate Lab" that
    // its twin would also render.
    const select = page.getByTestId("provider-merge-select");
    const optionB = select.locator(`option[value="${b}"]`);
    const optionBText = (await optionB.textContent())?.trim() ?? "";
    expect(optionBText).toContain("E2E Duplicate Lab ·");
    expect(optionBText).toContain("e2e-dup-lab-b");

    // Pick B and open the destructive confirm.
    await select.selectOption(String(b));
    await page.getByTestId("provider-merge-button").click();

    // The confirm names BOTH sides by the composite label, so "deletes X, keeps Y"
    // is verifiable even though X and Y share a name.
    const dialog = page.getByLabel(/^Merge into /);
    await expect(dialog).toBeVisible();
    // Survivor (A) title carries A's distinguisher; deletee (B) carries B's.
    await expect(dialog).toContainText("Merge into E2E Duplicate Lab ·");
    await expect(dialog).toContainText("e2e-dup-lab-a");
    await expect(dialog).toContainText("e2e-dup-lab-b");

    // Cancel — never perform the irreversible merge in a spec.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });
});
