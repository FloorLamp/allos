import { describe, expect, it } from "vitest";
import {
  seriesPickerOptions,
  SERIES_PICKER_GROUP_ORDER,
  SERIES_PICKER_METRICS_GROUP,
} from "@/lib/series-picker-options";
import { BIOMARKER_GROUP_LABELS } from "@/lib/biomarker-rank";

describe("series picker options (#1675)", () => {
  it("leads with due/flagged analytes, then metrics, then your markers, then the A–Z body", () => {
    const rows = seriesPickerOptions([
      { key: "metric:weight", label: "Weight", kind: "metric" },
      {
        key: "bio:Albumin",
        label: "Albumin",
        kind: "biomarker",
        group: "all-biomarkers",
      },
      {
        key: "bio:Ferritin",
        label: "Ferritin",
        kind: "biomarker",
        group: "your-markers",
      },
      {
        key: "bio:Hemoglobin A1c",
        label: "Hemoglobin A1c",
        kind: "biomarker",
        group: "due-relevant",
      },
    ]);

    expect(rows.map((r) => r.key)).toEqual([
      "bio:Hemoglobin A1c",
      "metric:weight",
      "bio:Ferritin",
      "bio:Albumin",
    ]);
    expect(rows.map((r) => r.group)).toEqual(SERIES_PICKER_GROUP_ORDER);
  });

  it("preserves the ranked order the query layer computed within a group", () => {
    const rows = seriesPickerOptions([
      {
        key: "bio:Zzz",
        label: "Zzz",
        kind: "biomarker",
        group: "your-markers",
      },
      {
        key: "bio:Aaa",
        label: "Aaa",
        kind: "biomarker",
        group: "your-markers",
      },
    ]);
    // NOT re-alphabetized: the rank already decided, and re-sorting here would be a
    // second, silently disagreeing ordering.
    expect(rows.map((r) => r.key)).toEqual(["bio:Zzz", "bio:Aaa"]);
  });

  it("treats an untagged biomarker as the A–Z body and a metric as Metrics", () => {
    const rows = seriesPickerOptions([
      { key: "bio:Albumin", label: "Albumin", kind: "biomarker" },
      { key: "metric:sleep", label: "Sleep", kind: "metric" },
    ]);
    expect(rows.map((r) => r.group)).toEqual([
      SERIES_PICKER_METRICS_GROUP,
      BIOMARKER_GROUP_LABELS["all-biomarkers"],
    ]);
  });

  it("disambiguates two rows that would otherwise read identically (#531)", () => {
    const rows = seriesPickerOptions([
      { key: "metric:weight", label: "Weight", kind: "metric" },
      { key: "bio:Weight", label: "Weight", kind: "biomarker" },
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      "Weight (metric)",
      "Weight (biomarker)",
    ]);
    // Every label is unique, which is what makes label-keyed picking safe.
    expect(new Set(rows.map((r) => r.label)).size).toBe(rows.length);
  });

  it("falls back to the key when even the kind does not distinguish two rows", () => {
    const rows = seriesPickerOptions([
      { key: "bio:Iron", label: "Iron", kind: "biomarker" },
      { key: "bio:Iron, Total", label: "Iron", kind: "biomarker" },
    ]);
    expect(new Set(rows.map((r) => r.label)).size).toBe(2);
    expect(rows.map((r) => r.label)).toEqual([
      "Iron (biomarker)",
      "Iron (bio:Iron, Total)",
    ]);
  });

  it("returns nothing for no rows", () => {
    expect(seriesPickerOptions([])).toEqual([]);
  });
});
