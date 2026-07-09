import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { readZip } from "../lib/zip";

// Full-account export (issue #18): clicking "Export all my data" on the Data →
// Manage & Export surface downloads ONE non-empty zip that contains the manifest,
// the FHIR passport, and the per-dataset JSON/CSV files. The companion "Clinical
// passport (FHIR)" link downloads a parseable FHIR Bundle. Both routes are session-
// gated and scoped to the active (seeded) profile.
// Open the Data page's "Manage & Export" tab. The tab content is only mounted when
// active (keepMounted:false), so click the tab rather than relying on the initial
// ?section= paint to have hydrated.
async function openManageTab(page: import("@playwright/test").Page) {
  await page.goto("/data?section=manage");
  await page.getByRole("button", { name: "Manage & Export" }).click();
}

test.describe("Full-account export", () => {
  test("downloads a non-empty zip with manifest, FHIR passport, and datasets", async ({
    page,
  }) => {
    await openManageTab(page);

    const exportLink = page.getByTestId("export-all-link");
    await expect(exportLink).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      exportLink.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^allos-export-.*\.zip$/);

    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    const buf = fs.readFileSync(filePath!);
    // Non-empty and a real ZIP (PK signature).
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");

    const entries = readZip(buf);
    const names = entries.map((e) => e.name);
    expect(names).toContain("manifest.json");
    expect(names).toContain("passport.fhir.json");
    // At least the always-present datasets ship as JSON + CSV.
    expect(names).toContain("datasets/body_metrics.json");
    expect(names).toContain("datasets/body_metrics.csv");

    // The manifest is valid JSON naming this app + a profile.
    const manifest = JSON.parse(
      entries.find((e) => e.name === "manifest.json")!.data.toString("utf8")
    );
    expect(manifest.app).toBe("allos");
    expect(manifest.profile.name).toBeTruthy();
    expect(Array.isArray(manifest.contents.datasets)).toBe(true);

    // The bundled FHIR passport parses as a FHIR Bundle.
    const bundle = JSON.parse(
      entries
        .find((e) => e.name === "passport.fhir.json")!
        .data.toString("utf8")
    );
    expect(bundle.resourceType).toBe("Bundle");
  });

  test("downloads a standalone FHIR passport bundle", async ({ page }) => {
    await openManageTab(page);

    const fhirLink = page.getByTestId("export-fhir-link");
    await expect(fhirLink).toBeVisible();

    // Fetch through the page's session rather than driving a second download, so we
    // can assert the JSON body directly.
    const res = await page.request.get("/api/export/fhir");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("fhir+json");
    const bundle = await res.json();
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("collection");
    expect(Array.isArray(bundle.entry)).toBe(true);
  });
});
