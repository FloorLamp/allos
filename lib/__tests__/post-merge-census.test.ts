import { describe, expect, it } from "vitest";
import {
  parseNameStatus,
  planPostMergeCensus,
} from "../../scripts/orchestration/post-merge-census.mjs";

const routes = [
  "/",
  "/medical/cycles",
  "/nutrition",
  "/settings",
  "/settings/display",
  "/trends",
  "/trends/metric/[kind]",
];

const changed = (file: string, status = "M") => ({
  status,
  paths: [file],
});

describe("post-merge census route planning", () => {
  it("maps app territories to truthful top-level route prefixes", () => {
    const plan = planPostMergeCensus(
      [
        changed("app/(app)/trends/TrendChart.tsx"),
        changed("app/(app)/medical/cycles/page.tsx"),
        changed("app/(app)/trends/page.tsx"),
      ],
      routes
    );
    expect(plan).toMatchObject({
      mode: "scoped",
      routes: ["/medical", "/trends"],
    });
  });

  it("falls back to every route when any shared component changes", () => {
    const plan = planPostMergeCensus(
      [changed("app/(app)/trends/page.tsx"), changed("components/Card.tsx")],
      routes
    );
    expect(plan).toEqual({
      mode: "full",
      routes,
      reasons: ["shared components changed"],
      mappedFiles: 2,
    });
  });

  it.each([
    "app/globals.css",
    "app/layout.tsx",
    "app/(app)/layout.tsx",
    "app/(app)/actions.ts",
    "app/(app)/page.tsx",
  ])("treats shared shell path %s as a full census", (file) => {
    expect(planPostMergeCensus([changed(file)], routes).mode).toBe("full");
  });

  it("fails when a changed app territory has no live census route", () => {
    expect(() =>
      planPostMergeCensus([changed("app/(app)/removed/Widget.tsx")], routes)
    ).toThrow("maps to no current census route");
  });

  it.each([
    "app/offline/page.tsx",
    "app/(marketing)/about/page.tsx",
    "app/(app)/(nested)/page.tsx",
  ])("fails loudly on unknown app shape %s", (file) => {
    expect(() => planPostMergeCensus([changed(file)], routes)).toThrow(
      "unknown app"
    );
  });

  it("fails loudly on deleted and renamed routes", () => {
    expect(() =>
      planPostMergeCensus([changed("app/(app)/trends/page.tsx", "D")], routes)
    ).toThrow("route deletion");
    expect(() =>
      planPostMergeCensus(
        [
          {
            status: "R100",
            paths: ["app/(app)/trends/page.tsx", "app/(app)/insights/page.tsx"],
          },
        ],
        routes
      )
    ).toThrow("route rename");
  });

  it("refuses empty and non-visual diffs instead of printing a no-op", () => {
    expect(() => planPostMergeCensus([], routes)).toThrow("no changed files");
    expect(() => planPostMergeCensus([changed("lib/date.ts")], routes)).toThrow(
      "no changed file maps"
    );
    expect(() =>
      planPostMergeCensus([changed("components/Card.tsx")], [])
    ).toThrow("empty route set");
  });
});

describe("post-merge census git records", () => {
  it("parses ordinary and rename records without losing either path", () => {
    expect(
      parseNameStatus(
        "M\0app/(app)/trends/page.tsx\0R091\0app/(app)/old/page.tsx\0app/(app)/new/page.tsx\0"
      )
    ).toEqual([
      { status: "M", paths: ["app/(app)/trends/page.tsx"] },
      {
        status: "R091",
        paths: ["app/(app)/old/page.tsx", "app/(app)/new/page.tsx"],
      },
    ]);
  });

  it("rejects malformed and unknown records", () => {
    expect(() => parseNameStatus("R100\0only-one-path\0")).toThrow(
      "incomplete git"
    );
    expect(() => parseNameStatus("Q\0mystery\0")).toThrow(
      "unknown git change status"
    );
  });
});
