import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_RECS_ENRICH,
  E2E_MEMBER_PASSWORD,
  RECS_ENRICH_ALLERGY_MED,
  RECS_ENRICH_PGX_MED,
  RECS_ENRICH_PROCEDURE,
} from "./fixture-logins";

// Records-surface enrichment sweep (#1354 bidirectional safety cross-links + #1355
// encounter link lines). Drives the dedicated RECS_ENRICH fixture (a Penicillin allergy
// + active Amoxicillin, a CYP2C19 poor-metabolizer variant + active Clopidogrel, and a
// procedure linked to an encounter) — its OWN login/profile, so nothing here exact-count-
// asserts a shared-seed row. Read-only; safe under --repeat-each.
test.describe("records enrichment sweep (#1354/#1355)", () => {
  test("#1354: an allergy row shows the contraindicated active med, deep-linking to it", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_RECS_ENRICH,
      password: E2E_MEMBER_PASSWORD,
    });

    // Allergies live on the Problems pane of /records.
    await page.goto("/records/problems/allergies");

    const contra = page.getByTestId("allergy-contraindications");
    await expect(contra).toBeVisible();
    await expect(contra).toContainText("Contraindicated with your active meds");

    // The med name is a real deep-link into the medications surface.
    const medLink = contra.getByRole("link", {
      name: RECS_ENRICH_ALLERGY_MED,
    });
    await expect(medLink).toBeVisible();
    await expect(medLink).toHaveAttribute("href", /\/medications\/\d+/);
  });

  test("#1354: a PGx variant row shows the active med it affects", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_RECS_ENRICH,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/results/genomics");

    const affects = page.getByTestId("pgx-affected-meds");
    await expect(affects).toBeVisible();
    await expect(affects).toContainText("Affects");
    await expect(affects).toContainText("CYP2C19");
    await expect(
      affects.getByRole("link", { name: RECS_ENRICH_PGX_MED })
    ).toBeVisible();
  });

  test("#1355: a procedure row shows the visit it was performed at", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_RECS_ENRICH,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/records/history/procedures");

    const row = page
      .getByRole("row")
      .filter({ hasText: RECS_ENRICH_PROCEDURE });
    const performedAt = row.getByText("Performed at:");
    await expect(performedAt).toBeVisible();
    await expect(performedAt).toContainText("Dr. Reyes (e2e)");
    await expect(
      performedAt.getByRole("link").filter({ hasText: "Orthopedic Surgery" })
    ).toBeVisible();
  });

  test("#1355: the remaining record surfaces reflect their existing links and context", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_RECS_ENRICH,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/records/problems/conditions");
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: "Meniscus tear (e2e)" })
        .getByText("Diagnosed at:")
    ).toBeVisible();

    await page.goto("/records/care/overview#family-history");
    await expect(
      page.getByText(/Tightens your breast screening cadence/)
    ).toBeVisible();
    await page.goto("/records/care/overview#care-plan");
    await expect(
      page.getByText("Colonoscopy screening (e2e)").locator("..")
    ).toContainText("Scheduled: Colonoscopy screening");
    await page.goto("/records/care/overview#health-goals");
    const openGoal = page
      .getByRole("row")
      .filter({ hasText: "Preventive target (e2e)" });
    await expect(openGoal).toContainText("Scheduled: Colonoscopy screening");
    const achievedGoal = page
      .getByRole("row")
      .filter({ hasText: "Colonoscopy completed goal (e2e)" });
    await expect(achievedGoal).not.toContainText("Scheduled:");

    await page.goto("/records/history/visits");
    const visit = page
      .getByRole("row")
      .filter({ hasText: "Orthopedic Surgery" });
    await expect(visit).toContainText("4 linked records");
    await expect(
      visit.getByRole("link", { name: "Knee recovery (e2e)" })
    ).toBeVisible();

    await page.goto("/results/imaging");
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: "Knee (e2e)" })
        .getByText("Performed at:")
    ).toBeVisible();

    await page.goto("/immunizations/influenza");
    await expect(page.getByText("Administered at:")).toBeVisible();
  });
});
