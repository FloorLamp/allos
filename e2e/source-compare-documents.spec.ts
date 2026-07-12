import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_COMPARE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Per-document source comparison identity (issue #533). seed-events plants two DEXA
// documents on a DEDICATED member profile plus a body-fat reading sourced from each
// (and one manual reading), so its Trends → Body "Compare sources" body_fat card
// carries two DISTINCT document series. They used to both collapse to one
// "Document" label and one teal color; now each shows its filename and its own
// de-collided color, and the primary-source picker's two document options are
// distinguishable. The fixture lives on its own profile because making profile 1's
// body_fat multi-source changed shared surfaces other specs assert (kids-growth's
// "Body fat" heading count, review-inbox's re-extract cost copy). Read-only spec —
// an isolated member session, nothing mutated.
test.describe("Source comparison — per-document identity (#533)", () => {
  test("two documents get distinct labels and colors, not one 'Document'", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_COMPARE,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/trends?tab=body");
      const card = page.getByTestId("source-compare-body_fat");
      await expect(card).toBeVisible();

      // Legend names each document by its filename — never a collapsed "Document".
      const legend = card.getByTestId("source-legend-body_fat");
      await expect(legend).toContainText("e2e-dexa-a.pdf");
      await expect(legend).toContainText("e2e-dexa-b.pdf");

      // Every legend color dot is distinct — the two documents no longer share
      // the one fallback teal.
      const dots = legend.locator("span[style]");
      const count = await dots.count();
      expect(count).toBeGreaterThanOrEqual(3); // manual + 2 documents
      const colors = await dots.evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).style.backgroundColor)
      );
      expect(new Set(colors).size).toBe(colors.length);

      // The primary-source picker offers both documents as distinct options.
      const picker = card.getByTestId("primary-source-body_fat");
      await expect(
        picker.locator("option", { hasText: "e2e-dexa-a.pdf" })
      ).toHaveCount(1);
      await expect(
        picker.locator("option", { hasText: "e2e-dexa-b.pdf" })
      ).toHaveCount(1);
    } finally {
      await page.context().close();
    }
  });
});
