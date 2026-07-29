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
  it("keeps recognized params, trims strings, coerces cmpn, drops unknown keys", () => {
    expect(
      normalizeViewParams({
        from: " 2026-01-01 ",
        to: "2026-02-01",
        cmpA: "metric:weight",
        cmpB: "bio:LDL",
        cmpn: "1",
        bogus: "x",
      })
    ).toEqual({
      from: "2026-01-01",
      to: "2026-02-01",
      cmpA: "metric:weight",
      cmpB: "bio:LDL",
      cmpn: true,
    });
  });

  it("drops empty/blank values", () => {
    expect(normalizeViewParams({ from: "  ", cmpn: false })).toEqual({});
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
      view("cut", { view: "tiles" }), // dup of "Cut"
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
    const out = addView([view("A")], view("B", { view: "tiles" }));
    expect(out.map((v) => v.name)).toEqual(["A", "B"]);
  });

  it("overwrites a same-name view in place (case-insensitive)", () => {
    const out = addView(
      [view("Cut", { tab: "overview" }), view("Lipids")],
      view("cut", { view: "tiles" })
    );
    // Overwrite replaces the entry in place, adopting the new spelling + params.
    expect(out.map((v) => v.name)).toEqual(["cut", "Lipids"]);
    expect(out[0]).toEqual({ name: "cut", params: { view: "tiles" } });
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
    const list = [view("Cut", { view: "tiles" })];
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
  it("builds the hub's query string", () => {
    expect(
      viewToQuery({
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
  // #1485 G: a view with no bounds is an ALL-TIME view — that is what "no
  // from/to" meant when it was captured — and a paramless /trends URL now
  // resolves to the 90D default. So applying one emits the explicit sentinel;
  // without it, every all-time saved view would silently become a 90D view.
  it("emits the explicit all-time sentinel for a view with no window", () => {
    expect(viewToQuery({ cmpn: true })).toBe("range=all&cmpn=1");
    expect(viewToQuery({})).toBe("range=all");
  });

  it("omits the sentinel whenever the view names any window", () => {
    expect(viewToQuery({ from: "2026-01-01" })).toBe("from=2026-01-01");
    expect(viewToQuery({ to: "2026-02-01" })).toBe("to=2026-02-01");
    expect(viewToQuery({ from: "2026-01-01", to: "2026-02-01" })).toBe(
      "from=2026-01-01&to=2026-02-01"
    );
  });
  // #1456: a view no longer carries a pin snapshot at all (those keys are SAVES
  // now — membership that also drives the Results status card and the passport
  // summary, so a view apply must never rewrite them). A legacy stored view's
  // `pins` field is dropped by normalizeViewParams and can't reach the URL.
  it("drops a legacy pins field instead of restoring or emitting it", () => {
    const params = normalizeViewParams({
      view: "tiles",
      pins: ["metric:weight"],
    });
    expect(params).toEqual({ view: "tiles" });
    // (`range=all` rides along because this view names no window — see above.)
    expect(viewToQuery(params)).toBe("range=all&view=tiles");
  });

  // #1644: the tab strip merged into one scrollable page, so a stored `tab` names
  // nothing. It is dropped at parse time (like #1456's `pins`) and never emitted —
  // #1635's no-shim policy applied to the stored blob, not just to links. Applying a
  // legacy view still restores the window and the comparison, onto the page that now
  // holds every former tab.
  it("drops a legacy tab name instead of restoring or emitting it (#1644)", () => {
    const params = normalizeViewParams({
      tab: "compare",
      cmpA: "metric:weight",
      cmpB: "bio:LDL Cholesterol",
      cmpn: true,
    });
    expect(params).toEqual({
      cmpA: "metric:weight",
      cmpB: "bio:LDL Cholesterol",
      cmpn: true,
    });
    const qs = viewToQuery(params);
    expect(qs).not.toContain("tab=");
    expect(qs).toBe(
      "range=all&cmpA=metric%3Aweight&cmpB=bio%3ALDL+Cholesterol&cmpn=1"
    );
  });

  it("drops every retired tab vocabulary the same way (#1486/#1489/#1644)", () => {
    for (const tab of ["overview", "body", "vitals", "compare", "biomarkers"]) {
      expect(normalizeViewParams({ tab, from: "2026-01-01" })).toEqual({
        from: "2026-01-01",
      });
      expect(viewToQuery(normalizeViewParams({ tab }))).toBe("range=all");
    }
  });
});

// ── #1493 C: saved-view COMPLETENESS ────────────────────────────────────────
//
// "Save current" that drops part of the current state is a bug by its own name.
// Two things were missing from the captured bag, and one that only LOOKED missing:
//
//   • the Body census's tiles/all layout (#1067 Phase 2) — genuinely absent, now `view`;
//   • the "1D" selection (#1466) — NOT a missing field: 1D is a from/to window
//     (from = to = the chosen day), so it already round-trips through the bounds;
//   • and the captured TAB, which #1644 retired outright — see the viewToQuery specs
//     above for how a legacy stored tab name is dropped.
describe("saved-view state completeness (#1493 C)", () => {
  it("captures the Body layout and re-emits it", () => {
    const params = normalizeViewParams({ view: "tiles" });
    expect(params).toEqual({ view: "tiles" });
    expect(viewToQuery(params)).toBe("range=all&view=tiles");
    expect(viewToQuery({ view: "all" })).toBe("range=all&view=all");
  });

  it("round-trips a Body / tiles / 1D view through storage unchanged", () => {
    // The 1D pill is a one-day window, so this is the WHOLE of that state.
    const saved = view("Yesterday's vitals", {
      view: "tiles",
      from: "2026-01-14",
      to: "2026-01-14",
    });
    const reopened = parseViews(serializeViews([saved]))[0];
    expect(reopened).toEqual(saved);
    expect(viewToQuery(reopened.params)).toBe(
      "from=2026-01-14&to=2026-01-14&view=tiles"
    );
  });

  it("drops an unrecognized or malformed layout value rather than emitting it", () => {
    expect(normalizeViewParams({ from: "2026-01-01", view: "grid" })).toEqual({
      from: "2026-01-01",
    });
    expect(normalizeViewParams({ from: "2026-01-01", view: 7 })).toEqual({
      from: "2026-01-01",
    });
    expect(normalizeViewParams({ from: "2026-01-01", view: "" })).toEqual({
      from: "2026-01-01",
    });
  });

  // Defensive parse, the whole point: a view stored before `view` existed has no
  // such field and must resolve EXACTLY as it did.
  it("leaves a pre-#1493 stored view resolving on its surviving fields", () => {
    const legacy =
      '[{"name":"Lipids","params":{"tab":"insights","cmpn":true}}]';
    const parsed = parseViews(legacy);
    // The retired tab name is dropped at parse time (#1644); everything the view
    // still names survives.
    expect(parsed).toEqual([{ name: "Lipids", params: { cmpn: true } }]);
    expect(viewToQuery(parsed[0].params)).toBe("range=all&cmpn=1");
  });
});
