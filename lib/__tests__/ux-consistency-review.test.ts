import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";
import {
  CONSISTENCY_REVIEW_DIMENSIONS,
  consistencyAuditSection,
  consistencyReviewEntries,
  consistencyReviewHtml,
} from "../../scripts/ux-consistency-review.mjs";

// #3489 D2+D7 guard. The census is a manual seeing tool, so the dangerous
// regression is a quietly smaller reviewer brief: a mobile/expanded frame mixed
// into the comparison set, a reached desktop route omitted, or one of the named
// dimensions disappearing from the skill while the harness still runs green.

const desktop = (route: string, file: string) => ({
  file,
  name: file.replace(/\.png$/, ""),
  consistency: { kind: "page-default", route, viewport: "desktop" },
});

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

describe("cross-page consistency review", () => {
  it("pins the dimensions the owner named", () => {
    expect(CONSISTENCY_REVIEW_DIMENSIONS.map((d) => d.id)).toEqual([
      "control-grammar",
      "density",
      "inset-stacking",
      "copy-jargon",
      "state-honesty",
    ]);
  });

  it("keeps every default desktop capture and only that comparable state", () => {
    const manifest = [
      desktop("/", "01-page-desktop-home.png"),
      desktop("/trends", "02-page-desktop-trends.png"),
      {
        file: "03-page-mobile-home.png",
        name: "page-mobile-home",
        consistency: {
          kind: "page-default",
          route: "/",
          viewport: "mobile",
        },
      },
      { file: "04-page-desktop-trends-expanded.png", name: "expanded" },
      { file: "05-page-desktop-home-hover.png", name: "hover" },
    ];

    expect(consistencyReviewEntries(manifest)).toEqual([
      { route: "/", file: "01-page-desktop-home.png" },
      { route: "/trends", file: "02-page-desktop-trends.png" },
    ]);
  });

  it("fails instead of quietly presenting two states for one route", () => {
    expect(() =>
      consistencyReviewEntries([
        desktop("/trends", "01-trends.png"),
        desktop("/trends", "02-trends-again.png"),
      ])
    ).toThrow("two default desktop captures for /trends");
  });

  it("fails when a reached desktop route has no marked capture", () => {
    expect(() =>
      consistencyReviewEntries([desktop("/", "01-home.png")], ["/", "/trends"])
    ).toThrow("missing default desktop captures for: /trends");
  });

  it("keeps the executable capture and artifact boundaries wired", () => {
    // This reads the LIVE harness, with comments blanked. It is deliberately in
    // addition to the pure boundary test above: deleting the metadata passed to
    // shot(), or disconnecting the writer, must fail the unit tier even though a
    // synthetic marked manifest could still prove the filter in isolation.
    const walkthrough = stripComments(
      fs.readFileSync(path.join(repo, "scripts", "ux-walkthrough.mjs"), "utf8")
    );
    expect(
      /await shot\(page, `page-\$\{tag\}-\$\{slug\}`, \{\s*consistency: \{\s*kind: "page-default",\s*route,\s*viewport: tag\s*\},\s*\}\);/.test(
        walkthrough
      ),
      "the live default page shot must carry its route and viewport into the consistency manifest"
    ).toBe(true);
    expect(
      /consistencyReviewEntries\(\s*manifest,\s*metricsRows\s*\.filter\(\(row\) => row\.viewport === "desktop"\)\s*\.map\(\(row\) => row\.route\)\s*\)/.test(
        walkthrough
      ),
      "the artifact boundary must require every independently measured desktop route"
    ).toBe(true);
    expect(
      /fs\.writeFileSync\(\s*path\.join\(SHOTS, "consistency\.html"\),\s*consistencyReviewHtml\(consistencyEntries\)\s*\)/.test(
        walkthrough
      ),
      "the artifact writer must render the validated consistency entries"
    ).toBe(true);
    expect(walkthrough).toContain(
      "consistencyAuditSection(consistencyEntries)"
    );
  });

  it("puts the full lane and its dimensions in both generated artifacts", () => {
    const entries = consistencyReviewEntries([
      desktop("/trends", "01-page-desktop-trends.png"),
    ]);
    const html = consistencyReviewHtml(entries);
    const audit = consistencyAuditSection(entries).join("\n");
    expect(html).toContain("/trends");
    expect(audit).toContain("1 reached routes");
    const artifacts = [html, audit];
    for (const artifact of artifacts) {
      expect(artifact).toMatch(/between-page/i);
      for (const dimension of CONSISTENCY_REVIEW_DIMENSIONS)
        expect(artifact).toContain(dimension.label);
    }
  });

  it("keeps the skill's executable brief aligned with the pinned vocabulary", () => {
    const skill = fs.readFileSync(
      path.join(
        here,
        "..",
        "..",
        ".claude",
        "skills",
        "ux-walkthrough",
        "SKILL.md"
      ),
      "utf8"
    );
    expect(skill).toContain("consistency.html");
    expect(skill).toContain("DEFAULT desktop capture per reached route");
    for (const dimension of CONSISTENCY_REVIEW_DIMENSIONS)
      expect(skill.toLowerCase()).toContain(dimension.label.toLowerCase());
  });
});
