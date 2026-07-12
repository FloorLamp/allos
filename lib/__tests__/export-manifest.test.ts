import { describe, expect, it } from "vitest";
import { buildExportManifest } from "@/lib/export-manifest";

describe("buildExportManifest", () => {
  const base = {
    appVersion: "0.1.0",
    exportedAt: "2026-07-09T12:00:00.000Z",
    profile: { id: 3, name: "Me" },
    datasetCounts: { activities: 12, body_metrics: 5, allergies: 0 },
    fileCount: 2,
    fhirResourceCount: 7,
  };

  it("lists every dataset with its json/csv paths and count", () => {
    const m = buildExportManifest(base);
    expect(m.app).toBe("allos");
    expect(m.appVersion).toBe("0.1.0");
    expect(m.exportedAt).toBe("2026-07-09T12:00:00.000Z");
    expect(m.profile).toEqual({ id: 3, name: "Me" });
    expect(m.contents.datasets).toEqual([
      {
        key: "activities",
        count: 12,
        json: "datasets/activities.json",
        csv: "datasets/activities.csv",
      },
      {
        key: "body_metrics",
        count: 5,
        json: "datasets/body_metrics.json",
        csv: "datasets/body_metrics.csv",
      },
      {
        key: "allergies",
        count: 0,
        json: "datasets/allergies.json",
        csv: "datasets/allergies.csv",
      },
    ]);
  });

  it("totals rows across datasets and echoes file/fhir counts", () => {
    const m = buildExportManifest(base);
    expect(m.totals).toEqual({ datasets: 3, rows: 17, files: 2 });
    expect(m.contents.medicalFiles).toEqual({
      directory: "medical-files/",
      count: 2,
    });
    expect(m.contents.fhir).toEqual({
      file: "passport.fhir.json",
      resourceCount: 7,
    });
    expect(m.contents.manifest).toBe("manifest.json");
  });

  it("preserves the dataset order it is given", () => {
    const m = buildExportManifest({
      ...base,
      datasetCounts: { zeta: 1, alpha: 2 },
    });
    expect(m.contents.datasets.map((d) => d.key)).toEqual(["zeta", "alpha"]);
  });

  it("omits missing-file + profile-photo keys when there are none (#466)", () => {
    const m = buildExportManifest(base);
    expect(m.contents.medicalFiles).not.toHaveProperty("missing");
    expect(m.contents).not.toHaveProperty("profilePhoto");
  });

  it("surfaces skipped-on-disk files and the bundled profile photo (#466)", () => {
    const m = buildExportManifest({
      ...base,
      missingFiles: ["medical-files/9-gone.pdf"],
      profilePhoto: "profile-photo.jpg",
    });
    expect(m.contents.medicalFiles.missing).toEqual([
      "medical-files/9-gone.pdf",
    ]);
    expect(m.contents.profilePhoto).toBe("profile-photo.jpg");
  });
});
