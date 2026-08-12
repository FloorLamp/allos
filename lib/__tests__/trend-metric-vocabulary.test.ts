import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TREND_METRIC_SLUGS } from "@/lib/trend-metrics";
import { trendsSectionHref } from "@/lib/trends-sections";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

describe("trend metric vocabulary (#2483)", () => {
  it("names the broad presentation registry independently of body_metrics", () => {
    expect(TREND_METRIC_SLUGS).toEqual(
      expect.arrayContaining(["mood", "steps", "spo2", "weight"])
    );

    const source = fs.readFileSync(
      path.join(repo, "lib/trend-metrics.ts"),
      "utf8"
    );
    for (const retired of [
      "BODY_METRIC_SLUGS",
      "BodyMetricSlug",
      "BODY_METRIC_META",
      "BodyMetricMeta",
    ]) {
      expect(source, retired).not.toContain(retired);
    }
    expect(fs.existsSync(path.join(repo, "lib/trends-body-metrics.ts"))).toBe(
      false
    );
  });

  it("keeps the Overview body census anchor stable", () => {
    expect(trendsSectionHref("body")).toBe("/trends#body");
  });

  it("keeps current documentation free of retired Body-tab navigation", () => {
    const retiredNavigation = /Trends\s*(?:→|->)\s*Body|Body[- ]tab/i;

    for (const file of markdownFiles(path.join(repo, "docs"))) {
      expect(
        fs.readFileSync(file, "utf8"),
        `${path.relative(repo, file)} still describes the retired Body tab`
      ).not.toMatch(retiredNavigation);
    }
  });
});
