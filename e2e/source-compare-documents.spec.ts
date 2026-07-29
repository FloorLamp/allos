import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { settledCheck, settledSelect } from "./helpers";
import { E2E_LOGIN_COMPARE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Per-document source comparison identity (issue #533). seed-events plants two DEXA
// documents on a DEDICATED member profile plus a body-fat reading sourced from each
// (and one manual reading), so its Body fat detail page's "Compare sources"
// section carries two DISTINCT document series. They used to both collapse to one
// "Document" label and one teal color; now each shows its filename and its own
// de-collided color, and the primary-source picker's two document options are
// distinguishable. The fixture lives on its own profile because making profile 1's
// body_fat multi-source changed shared surfaces other specs assert (kids-growth's
// "Body fat" heading count, review-inbox's re-extract cost copy). Read-only spec —
// an isolated member session, nothing mutated.
test.describe("Source comparison — per-document identity (#533)", () => {
  test("old sources stay out of the default range but return distinctly in All time", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_COMPARE,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/trends/metric/body-fat");
      // All three readings are from 2022, so the default 90D view has nothing
      // useful to compare and must not list those historical sources.
      await expect(page.getByTestId("source-comparison")).toHaveCount(0);

      await page.goto("/trends/metric/body-fat?range=all");
      const comparison = page.getByTestId("source-comparison");
      await expect(comparison).toBeVisible();
      await expect(page.getByTestId("source-compare-body_fat")).toBeVisible();

      // Legend names each document by its filename — never a collapsed "Document".
      const legend = comparison.getByTestId("source-legend-body_fat");
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
      const picker = comparison.getByTestId("primary-source-body_fat");
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

// The documents source CLASS (#1640) and strict "only this source" mode (#1642),
// on the SAME two-document fixture — that pairing is the motivating scenario:
// periodic DEXA reports against a denser everyday source. The class makes "my
// scans" one selectable series across reports; strict turns the pick from a
// preference into an exclusion, so the profile's manual day stops answering.
//
// This spec MUTATES the fixture profile's primary-source setting and restores it
// to Automatic at the end, so the read-only sibling test above (and --repeat-each)
// always start from the same state. Nothing else on this dedicated profile reads
// that setting.
test.describe("Source class + strict mode (#1640/#1642)", () => {
  test("Documents aggregates the reports, and strict drops every other source", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_COMPARE,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/trends/metric/body-fat?range=all");
      const comparison = page.getByTestId("source-comparison");
      await expect(comparison).toBeVisible();

      // The aggregate JOINS its members — it never replaces them (#533 intact).
      const legend = comparison.getByTestId("source-legend-body_fat");
      await expect(legend).toContainText("Documents");
      await expect(legend).toContainText("e2e-dexa-a.pdf");
      await expect(legend).toContainText("e2e-dexa-b.pdf");

      const picker = comparison.getByTestId("primary-source-body_fat");
      await expect(
        picker.locator("option", { hasText: /^Documents$/ })
      ).toHaveCount(1);

      // The manual 2022-11-05 reading is the newest of any source, so it is the
      // latest value while nothing is elected.
      await expect(page.getByTestId("metric-latest-value")).toHaveText("20.6%");

      // Elect the class. In PREFERENCE mode the scan days become the scans', but
      // the manual day still falls back — the chart never goes blank.
      await settledSelect(page, picker, "documents");
      await expect(
        page.getByTestId("primary-source-saved-body_fat")
      ).toBeVisible();
      await page.reload();
      await expect(page.getByTestId("primary-source-body_fat")).toHaveValue(
        "documents"
      );
      await expect(page.getByTestId("metric-latest-value")).toHaveText("20.6%");

      // Strict: only the scans answer. The manual day is an honest gap, so the
      // latest value becomes the newest SCAN — across BOTH documents (19.8 is
      // e2e-dexa-b's reading, a different document from the first scan).
      const strict = page.getByTestId("primary-source-strict-body_fat");
      await settledCheck(page, strict, true);
      await expect(
        page.getByTestId("primary-source-saved-body_fat")
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByTestId("primary-source-strict-body_fat")
      ).toBeChecked();
      await expect(page.getByTestId("metric-latest-value")).toHaveText("19.8%");
    } finally {
      // Restore Automatic — selecting it clears the strict mode with the source.
      await settledSelect(
        page,
        page.getByTestId("primary-source-body_fat"),
        ""
      );
      await expect(
        page.getByTestId("primary-source-saved-body_fat")
      ).toBeVisible();
      await page.reload();
      await expect(page.getByTestId("primary-source-body_fat")).toHaveValue("");
      await expect(page.getByTestId("metric-latest-value")).toHaveText("20.6%");
      await page.context().close();
    }
  });
});
