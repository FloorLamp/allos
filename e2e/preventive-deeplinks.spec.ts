import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { followLink } from "./helpers";
import { E2E_LOGIN_PREVENTIVE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Preventive rows deep-link the CONCRETE next action, per class (issue #1083). Each
// due screening's row carries a named CTA that opens the exact form to record/
// administer what satisfies it — a prefilled biomarker add form (lab), the vitals
// quick-add (vital), the instrument page preselected via ?screen= (instrument), or
// the prefilled procedures add form (procedure). This proves, end-to-end, that the
// row's CTA lands on the right surface AND that the receiving form honors the deep
// link's params (the NEW wiring the pure tests can't see).
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_PREVENTIVE in its OWN
// cookie context on a dedicated older-adult (sex=female, ~60yo) profile with NO
// satisfying records, so every screening class stays due deterministically. The
// spec is READ-ONLY (follows links, never writes), so --repeat-each stays clean
// without reseeding, and it never counts a shared-seed row. Navigation settles via
// followLink (the blessed interaction helper).

test.describe.configure({ mode: "serial" });

test.describe("preventive deep-links per class (#1083)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_PREVENTIVE,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  // Follow a due screening row's CTA button to its per-class deep link. Scoped to
  // <main> so it never matches the app-shell copy of the list (the #206 precedent).
  async function followCta(rule: string, destination: RegExp): Promise<void> {
    await page.goto("/upcoming");
    const main = page.getByRole("main");
    const row = main.getByTestId(`upcoming-item-screening:${rule}`);
    await expect(row).toBeVisible();
    await followLink(
      page,
      main.getByTestId(`upcoming-cta-screening:${rule}`),
      destination
    );
    await expect(page).toHaveURL(destination);
  }

  test("instrument total-only → substance-use section with DAST-10 preselected (Enter your score)", async () => {
    test.slow();
    // The CTA names the total-only verb (can't be administered in-app).
    const cta = page
      .getByRole("main")
      .getByTestId("upcoming-cta-screening:drug_use_screening");
    await page.goto("/upcoming");
    await expect(cta).toHaveText(/Enter your DAST-10 score/);

    // #1175: substance-use is now the Records › Specialty section (an adult-gated
    // route), so the preventive deep link lands on /records/specialty/substance-use.
    await followCta(
      "drug_use_screening",
      /\/records\/specialty\/substance-use\?screen=DAST-10/
    );
    // DAST-10 preselected ⇒ the total-only note (its item text isn't shipped) shows.
    await expect(
      page.getByRole("main").getByTestId("substance-total-only-note")
    ).toBeVisible();
  });

  test("instrument in-app → mental-health page with PHQ-9 preselected (Complete)", async () => {
    test.slow();
    const cta = page
      .getByRole("main")
      .getByTestId("upcoming-cta-screening:depression_screening");
    await page.goto("/upcoming");
    await expect(cta).toHaveText(/Complete the PHQ-9/);

    await followCta(
      "depression_screening",
      /\/records\/specialty\/mental-health\?screen=PHQ-9/
    );
    // Only PHQ-9 has a 9th item (index 8); GAD-7 has 7 — proves the preselect.
    await expect(
      page.getByRole("main").getByTestId("instrument-item-8")
    ).toBeVisible();
  });

  test("lab → biomarker add form prefilled with the canonical (Record)", async () => {
    test.slow();
    const cta = page
      .getByRole("main")
      .getByTestId("upcoming-cta-screening:lipid_screening");
    await page.goto("/upcoming");
    await expect(cta).toHaveText(/Record your LDL Cholesterol result/);

    await followCta("lipid_screening", /\/results\/biomarkers\?new=1&name=LDL/);
    // The add form's name field arrives prefilled to the canonical (#662).
    await expect(page.locator("#rec-new-name")).toHaveValue("LDL Cholesterol");
  });

  test("vital → vitals quick-add with the blood-pressure field focused (Record a reading)", async () => {
    test.slow();
    const cta = page
      .getByRole("main")
      .getByTestId("upcoming-cta-screening:blood_pressure");
    await page.goto("/upcoming");
    await expect(cta).toHaveText(/Record a blood pressure reading/);

    await followCta(
      "blood_pressure",
      /\/trends\?tab=vitals&focus=blood-pressure/
    );
    // Landed on the vitals ENTRY surface (NOT the biomarkers form, #1076), systolic
    // focused so a BP reading is one keystroke away.
    await expect(page.getByTestId("vitals-quick-add")).toBeVisible();
    await expect(page.locator("#v-systolic")).toBeFocused();
  });

  test("procedure → procedures add form prefilled with the procedure noun (Log or schedule)", async () => {
    test.slow();
    const cta = page
      .getByRole("main")
      .getByTestId("upcoming-cta-screening:colorectal_cancer");
    await page.goto("/upcoming");
    await expect(cta).toHaveText(/Log or schedule a Colonoscopy/);

    await followCta(
      "colorectal_cancer",
      /\/records\/history\/procedures\?new=1&name=Colonoscopy/
    );
    await expect(page.locator("#proc-name-new")).toHaveValue("Colonoscopy");
  });
});
