import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick, followLink } from "./helpers";
import {
  expectDesktopOrdinarySubmit,
  expectPhoneOrdinarySubmit,
} from "./ordinary-submit-actions";
import { workerDbPath } from "./worker-env";

// The provider-domain closeout sweep (#1055/#1056/#1057/#1058/#1088), driven as the
// seeded admin against the dedicated "(e2e)" provider fixtures planted by
// e2e/seed-events.ts (Dr. Cora Bell ↔ Bell Cardiology affiliation with a Cardiology
// specialty; a co-occurring Dr. Sam Ng / Ng Family Practice pair with no edge → a
// suggestion; a seeded-archived Retired Clinic). Covers: the grouped directory
// (org card + nested individual + specialty chip), the detail "Practices at" tie-in,
// declining a suggestion, the archive round-trip, and #1088 (a vision form sets a
// provider that then appears in that provider's directory activity).
const DB_PATH = workerDbPath();

function providerId(name: string): number {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT id FROM providers WHERE name = ? ORDER BY id LIMIT 1")
      .get(name) as { id: number } | undefined;
    if (!row) throw new Error(`no seeded provider "${name}"`);
    return row.id;
  } finally {
    db.close();
  }
}

function removeAffiliation(individualName: string, organizationName: string) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(
      `DELETE FROM provider_affiliations
        WHERE individual_id = (SELECT id FROM providers WHERE name = ?)
          AND organization_id = (SELECT id FROM providers WHERE name = ?)`
    ).run(individualName, organizationName);
  } finally {
    db.close();
  }
}

test.describe("Provider registry closeout", () => {
  test.describe.configure({ mode: "serial" });

  test("grouped directory nests an affiliated individual with a specialty chip (#1055/#1056)", async ({
    page,
  }) => {
    await page.goto("/records/care/providers");
    // The org card for the affiliated practice, with its nested clinician.
    const orgCard = page
      .getByTestId("provider-org-card")
      .filter({ hasText: "Bell Cardiology (e2e)" });
    await expect(orgCard).toBeVisible();
    await expect(orgCard.getByText("Dr. Cora Bell (e2e)")).toBeVisible();
    // The nested individual carries the #1056 specialty chip.
    await expect(
      orgCard
        .getByTestId("provider-specialty-chip")
        .filter({ hasText: "Cardiology" })
    ).toBeVisible();

    // Archived providers sit behind the disclosure, not the main directory.
    const disclosure = page.getByTestId("provider-archived-disclosure");
    await expect(disclosure).toContainText("Archived");
    await expect(disclosure).toContainText("Retired Clinic (e2e)");
  });

  test("individual detail shows Practices at → the affiliated org (#1055)", async ({
    page,
  }) => {
    await page.goto(`/providers/${providerId("Dr. Cora Bell (e2e)")}`);
    const detail = page.getByTestId("provider-detail");
    const margins = await detail.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const parentRect = element.parentElement!.getBoundingClientRect();
      return {
        left: rect.left - parentRect.left,
        right: parentRect.right - rect.right,
      };
    });
    expect(Math.abs(margins.left - margins.right)).toBeLessThan(2);
    await expect(page.getByTestId("provider-identity")).toHaveClass(/\bcard\b/);
    await expect(detail.locator(".card .card")).toHaveCount(0);
    await expect(page.getByTestId("provider-identity-details")).toHaveCSS(
      "flex-direction",
      "column"
    );
    const affiliations = page.getByTestId("provider-affiliations");
    await expect(affiliations).toContainText("Practices at");
    await expect(
      affiliations.getByRole("link", { name: /Bell Cardiology \(e2e\)/ })
    ).toBeVisible();
    const addAffiliation = affiliations.getByTestId("affiliation-add-toggle");
    await expect(addAffiliation).toHaveClass(/\bbtn\b/);
    await addAffiliation.click();
    await expect(
      page.getByRole("dialog", { name: "Link affiliation" })
    ).toBeVisible();
    await page
      .getByRole("dialog", { name: "Link affiliation" })
      .getByRole("button", { name: "Close" })
      .click();
  });

  test("the manual affiliation primary links and unlinks at phone size", async ({
    page,
  }) => {
    const individual = "Dr. Cora Bell (e2e)";
    const organization = "Ng Family Practice (e2e)";
    removeAffiliation(individual, organization);
    try {
      await page.goto(`/providers/${providerId(individual)}`);
      const affiliations = page.getByTestId("provider-affiliations");
      await affiliations.getByTestId("affiliation-add-toggle").click();
      const dialog = page.getByRole("dialog", { name: "Link affiliation" });
      const form = dialog.getByTestId("affiliation-add-form");
      const field = dialog.getByLabel("Affiliated with");
      await field.fill(organization);
      await page.keyboard.press("Escape");
      const submit = form.getByRole("button", { name: "Link", exact: true });
      await expectDesktopOrdinarySubmit({
        form,
        owner: form,
        submit,
        adjacent: field,
        name: "provider affiliation Link",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expectPhoneOrdinarySubmit({
        form,
        owner: form,
        submit,
        adjacent: field,
        name: "provider affiliation Link",
      });
      await settledClick(page, submit);

      const linked = affiliations
        .getByTestId("affiliation-list")
        .getByRole("listitem")
        .filter({ hasText: organization });
      await expect(linked).toBeVisible();
      await settledClick(
        page,
        linked.getByRole("button", {
          name: `Remove affiliation with ${organization}`,
        })
      );
      await expect(linked).toHaveCount(0);
    } finally {
      removeAffiliation(individual, organization);
    }
  });

  test("the affiliation picker answers for itself; Escape asks, Close does not (#3371, #3420)", async ({
    page,
  }) => {
    // THE ENTRY A `name=` GREP MISSES, driven. This dialog's <form> carries
    // `name="name"` and looks tracked — but that name lands on ProviderCombobox's
    // `type="hidden"` input, which the #1878 registry excludes outright, while the
    // VISIBLE field carries none. So the discard guard was silently absent and a
    // dismissal threw the pick away with nothing asking.
    await page.goto(`/providers/${providerId("Dr. Cora Bell (e2e)")}`);
    const affiliations = page.getByTestId("provider-affiliations");
    await affiliations.getByTestId("affiliation-add-toggle").click();
    const dialog = page.getByRole("dialog", { name: "Link affiliation" });
    const form = dialog.getByTestId("affiliation-add-form");

    // THE FORM'S OWN ANSWER FIRST, so a broken marker cannot red as a dismissal bug.
    await expect(
      form,
      "an untouched picker has nothing to lose and must say so"
    ).toHaveAttribute("data-unsaved", "false");
    await dialog.getByLabel("Affiliated with").fill("Ng Family Practice");
    await expect(
      form,
      "the picker must publish its own unsaved state — its only name= lands on a hidden input the registry excludes"
    ).toHaveAttribute("data-unsaved", "true");

    // The combobox list is open on top of the dialog and owns the first Escape
    // (`useFocusTrap` yields to `[data-escape-layer="true"]`, #3409). Close it
    // deliberately, so the assertion below is unambiguously about the NEXT press.
    const picker = page.locator('[data-escape-layer="true"]');
    await expect(picker).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);

    await page.keyboard.press("Escape");
    const confirm = page.getByTestId("confirm-dialog");
    await expect(
      confirm,
      "Escape over a dialog holding an unsaved pick must route through the discard confirm (#3420)"
    ).toBeVisible();
    await confirm.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog).toBeVisible();
    await expect(confirm).toHaveCount(0);

    // AND THE HALF THE RULING LEFT ALONE. The Close button is a named control the
    // person aimed at, so it still closes outright — no confirm — on the very same
    // dirty form that just refused Escape. If this ever starts prompting, #3420's
    // stated scope has been widened by accident.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  });

  test("provider activity links to clinical destinations, not source documents", async ({
    page,
  }) => {
    const id = providerId("Dr. Cora Bell (e2e)");
    const handle = new Database(DB_PATH);
    const visitId = Number(
      handle
        .prepare(
          `INSERT INTO encounters
             (profile_id, date, type, provider_id, source)
           VALUES (1, '2026-04-01', 'Provider href visit (e2e)', ?, 'document:908')`
        )
        .run(id).lastInsertRowid
    );
    const labId = Number(
      handle
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, canonical_name, value, provider_id, source)
           VALUES
             (1, '2026-04-02', 'lab', 'GLUCOSE', 'Glucose', '90', ?, 'document:908')`
        )
        .run(id).lastInsertRowid
    );
    const medicationId = Number(
      handle
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, kind, active, obligation, provider_id, source)
           VALUES
             (1, 'Provider href medication (e2e)', 'medication', 1, 'must', ?, 'document:908')`
        )
        .run(id).lastInsertRowid
    );
    handle.close();

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/providers/${id}`);
      const detail = page.getByTestId("provider-detail");
      const tablist = detail.getByRole("tablist");
      await expect(tablist).toHaveCSS("overflow-x", "auto");
      await expect(
        detail.getByRole("tab", { name: /^Visits/ })
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        detail.getByTestId("provider-activity-panel-visits")
      ).toBeVisible();

      await expect(
        detail.getByRole("link", { name: /Provider href visit \(e2e\)/ })
      ).toHaveAttribute("href", `/encounters/${visitId}`);

      await followLink(
        page,
        detail.getByRole("tab", { name: /^Labs/ }),
        /[?&]activity=labs/
      );
      await expect(
        detail.getByRole("link", { name: /Glucose/ })
      ).toHaveAttribute("href", "/results/clinical-results/view?name=Glucose");

      await followLink(
        page,
        detail.getByRole("tab", { name: /^Medications/ }),
        /[?&]activity=medications/
      );
      await expect(
        detail.getByRole("link", {
          name: /Provider href medication \(e2e\)/,
        })
      ).toHaveAttribute("href", `/medications/${medicationId}`);

      await expect(detail.locator('a[href^="/import/"]')).toHaveCount(0);
    } finally {
      const cleanup = new Database(DB_PATH);
      cleanup
        .prepare("DELETE FROM encounters WHERE id = ? AND profile_id = 1")
        .run(visitId);
      cleanup
        .prepare("DELETE FROM medical_records WHERE id = ? AND profile_id = 1")
        .run(labId);
      cleanup
        .prepare("DELETE FROM intake_items WHERE id = ? AND profile_id = 1")
        .run(medicationId);
      cleanup.close();
    }
  });

  test("a declined affiliation suggestion stays gone (#1055)", async ({
    page,
  }) => {
    await page.goto(`/providers/${providerId("Dr. Sam Ng (e2e)")}`);
    const suggestions = page.getByTestId("affiliation-suggestions");
    // Repeatable across --repeat-each: on the first run the co-occurrence surfaces a
    // suggestion; decline it. On a later run it is already declined (gone). Either
    // way, the end state asserted is the same: no Ng Family Practice suggestion.
    if (await suggestions.count()) {
      await expect(suggestions.getByTestId("affiliation-accept")).toHaveClass(
        /\bbtn\b/
      );
      const decline = suggestions.getByTestId("affiliation-decline");
      if (await decline.count()) await settledClick(page, decline.first()); // eslint-disable-line no-restricted-properties -- first-ok: spec-owned Sam Ng fixture, sole suggestion
    }
    await expect(
      page
        .getByTestId("affiliation-suggestions")
        .getByText("Ng Family Practice (e2e)")
    ).toHaveCount(0);
  });

  test("archive → disclosure → unarchive round-trip (#1057)", async ({
    page,
  }) => {
    const id = providerId("Retired Clinic (e2e)");
    await page.goto(`/providers/${id}`);
    // Seeded archived: the badge + Unarchive control are present.
    await expect(page.getByTestId("provider-archived-badge")).toBeVisible();
    await settledClick(page, page.getByTestId("provider-archive-button"));
    await expect(page.getByTestId("provider-archived-badge")).toHaveCount(0);

    // Now it appears in the default directory (search reaches the flat list).
    await page.goto("/records/care/providers");
    await page.getByTestId("provider-search").fill("Retired Clinic (e2e)");
    await expect(
      page.getByTestId("provider-list").getByText("Retired Clinic (e2e)")
    ).toBeVisible();

    // Restore the seeded state: re-archive so the fixture is idempotent on retry.
    await page.goto(`/providers/${id}`);
    await settledClick(page, page.getByTestId("provider-archive-button"));
    await expect(page.getByTestId("provider-archived-badge")).toBeVisible();
  });

  test("a vision Rx can set a provider that then shows in its directory activity (#1088)", async ({
    page,
  }) => {
    await page.goto("/records/specialty/vision");
    await page.getByTestId("add-prescription-panel-toggle").click();
    const form = page.getByTestId("optical-prescription-form");
    await form.getByLabel("Prescriber").fill("Dr. Vision E2E");
    await settledClick(page, form.getByRole("button", { name: "Add" }));

    // The saved Rx renders the provider as a link into the registry.
    const link = page.getByRole("link", { name: /Dr\. Vision E2E/ }).first(); // eslint-disable-line no-restricted-properties -- first-ok: spec-owned provider just created, any matching row proves the link
    await followLink(page, link, /\/providers\/\d+$/);

    // On the provider's detail, the Rx surfaces under the Vision activity section.
    const detail = page.getByTestId("provider-detail");
    await expect(detail).toContainText("Dr. Vision E2E");
    await expect(detail.getByRole("tab", { name: /^Vision/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    const rxEntry = detail.getByText(/Glasses|Contact lenses/).first(); // eslint-disable-line no-restricted-properties -- first-ok: spec-owned provider's own Rx list
    await expect(rxEntry).toBeVisible();
  });
});
