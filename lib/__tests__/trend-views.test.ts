import { describe, it, expect } from "vitest";
import {
  normalizeViewParams,
  normalizeView,
  normalizeViews,
  addView,
  deleteView,
  renameView,
  findView,
  parseViews,
  serializeViews,
  viewToQuery,
  MAX_VIEWS,
  type TrendView,
} from "../trend-views";

const view = (name: string, params = {}): TrendView => ({ name, params });

describe("normalizeViewParams", () => {
  it("keeps recognized params, trims strings, coerces cmpn, normalizes pins", () => {
    expect(
      normalizeViewParams({
        from: " 2026-01-01 ",
        to: "2026-02-01",
        tab: "compare",
        cmpA: "metric:weight",
        cmpB: "bio:LDL",
        cmpn: "1",
        pins: ["metric:weight", "metric:weight", " bio:LDL "],
        bogus: "x",
      })
    ).toEqual({
      from: "2026-01-01",
      to: "2026-02-01",
      tab: "compare",
      cmpA: "metric:weight",
      cmpB: "bio:LDL",
      cmpn: true,
      pins: ["metric:weight", "bio:LDL"],
    });
  });

  it("drops empty/blank values and an empty pin list", () => {
    expect(normalizeViewParams({ from: "  ", pins: [], cmpn: false })).toEqual(
      {}
    );
    expect(normalizeViewParams(null)).toEqual({});
    expect(normalizeViewParams("nope")).toEqual({});
  });
});

describe("normalizeView", () => {
  it("requires a non-empty name and caps its length", () => {
    expect(normalizeView({ name: "  ", params: {} })).toBeNull();
    expect(normalizeView({ name: 123 })).toBeNull();
    expect(normalizeView(null)).toBeNull();
    const long = normalizeView({ name: "x".repeat(200) });
    expect(long?.name.length).toBe(60);
  });
});

describe("normalizeViews", () => {
  it("drops invalid entries, de-dupes by name (case-insensitive, first wins), caps count", () => {
    const list = [
      view("Cut"),
      { name: "" }, // invalid
      view("cut", { tab: "body" }), // dup of "Cut"
      view("Lipids"),
    ];
    const out = normalizeViews(list);
    expect(out.map((v) => v.name)).toEqual(["Cut", "Lipids"]);
    // first "Cut" wins → its (empty) params kept
    expect(out[0].params).toEqual({});
  });

  it("caps at MAX_VIEWS", () => {
    const many = Array.from({ length: MAX_VIEWS + 5 }, (_, i) => view(`v${i}`));
    expect(normalizeViews(many)).toHaveLength(MAX_VIEWS);
  });

  it("returns [] for a non-array", () => {
    expect(normalizeViews("nope")).toEqual([]);
    expect(normalizeViews(null)).toEqual([]);
  });
});

describe("addView", () => {
  it("appends a new view", () => {
    const out = addView([view("A")], view("B", { tab: "body" }));
    expect(out.map((v) => v.name)).toEqual(["A", "B"]);
  });

  it("overwrites a same-name view in place (case-insensitive)", () => {
    const out = addView(
      [view("Cut", { tab: "overview" }), view("Lipids")],
      view("cut", { tab: "body" })
    );
    // Overwrite replaces the entry in place, adopting the new spelling + params.
    expect(out.map((v) => v.name)).toEqual(["cut", "Lipids"]);
    expect(out[0]).toEqual({ name: "cut", params: { tab: "body" } });
  });

  it("drops the OLDEST when appending overflows the cap", () => {
    const full = Array.from({ length: MAX_VIEWS }, (_, i) => view(`v${i}`));
    const out = addView(full, view("newest"));
    expect(out).toHaveLength(MAX_VIEWS);
    expect(out[out.length - 1].name).toBe("newest");
    expect(out.find((v) => v.name === "v0")).toBeUndefined();
  });

  it("ignores an invalid view", () => {
    expect(
      addView([view("A")], { name: "  " } as TrendView).map((v) => v.name)
    ).toEqual(["A"]);
  });
});

describe("deleteView", () => {
  it("removes by name (case-insensitive) and leaves the rest", () => {
    const out = deleteView([view("Cut"), view("Lipids")], "CUT");
    expect(out.map((v) => v.name)).toEqual(["Lipids"]);
  });
  it("is a no-op for an unknown name", () => {
    expect(deleteView([view("Cut")], "nope").map((v) => v.name)).toEqual([
      "Cut",
    ]);
  });
});

describe("renameView", () => {
  it("renames a matching view, preserving position", () => {
    const out = renameView([view("A"), view("B")], "a", "Alpha");
    expect(out.map((v) => v.name)).toEqual(["Alpha", "B"]);
  });
  it("de-dupes when the new name collides", () => {
    const out = renameView([view("A"), view("B")], "B", "A");
    expect(out.map((v) => v.name)).toEqual(["A"]);
  });
  it("is a no-op for a blank new name or unknown old name", () => {
    expect(renameView([view("A")], "A", "  ").map((v) => v.name)).toEqual([
      "A",
    ]);
    expect(renameView([view("A")], "Z", "New").map((v) => v.name)).toEqual([
      "A",
    ]);
  });
});

describe("findView", () => {
  it("finds case-insensitively or returns null", () => {
    const list = [view("Cut"), view("Lipids")];
    expect(findView(list, "cut")?.name).toBe("Cut");
    expect(findView(list, "missing")).toBeNull();
  });
});

describe("parseViews / serializeViews", () => {
  it("round-trips a normalized list", () => {
    const list = [view("Cut", { tab: "body", pins: ["metric:weight"] })];
    expect(parseViews(serializeViews(list))).toEqual(list);
  });
  it("returns [] for null/empty/garbage", () => {
    expect(parseViews(null)).toEqual([]);
    expect(parseViews("")).toEqual([]);
    expect(parseViews("not json")).toEqual([]);
    expect(parseViews("{}")).toEqual([]);
  });
});

describe("viewToQuery", () => {
  it("builds the hub's query string, dropping the default overview tab", () => {
    expect(
      viewToQuery({
        tab: "overview",
        from: "2026-01-01",
        to: "2026-02-01",
        cmpA: "metric:weight",
        cmpB: "bio:LDL",
        cmpn: true,
      })
    ).toBe(
      "from=2026-01-01&to=2026-02-01&cmpA=metric%3Aweight&cmpB=bio%3ALDL&cmpn=1"
    );
  });
  it("keeps a non-default tab and omits unset params", () => {
    expect(viewToQuery({ tab: "compare" })).toBe("tab=compare");
    expect(viewToQuery({})).toBe("");
  });
  it("does not emit pins in the URL (restored separately)", () => {
    expect(viewToQuery({ pins: ["metric:weight"] })).toBe("");
  });
});
