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
import { parseTab } from "../trends-tabs";

const view = (name: string, params = {}): TrendView => ({ name, params });

describe("normalizeViewParams", () => {
  it("keeps recognized params, trims strings, coerces cmpn, drops unknown keys", () => {
    expect(
      normalizeViewParams({
        from: " 2026-01-01 ",
        to: "2026-02-01",
        tab: "compare",
        cmpA: "metric:weight",
        cmpB: "bio:LDL",
        cmpn: "1",
        bogus: "x",
      })
    ).toEqual({
      from: "2026-01-01",
      to: "2026-02-01",
      tab: "compare",
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
    const list = [view("Cut", { tab: "body" })];
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
  // #1485 G: a view with no bounds is an ALL-TIME view — that is what "no
  // from/to" meant when it was captured — and a paramless /trends URL now
  // resolves to the 90D default. So applying one emits the explicit sentinel;
  // without it, every all-time saved view would silently become a 90D view.
  it("emits the explicit all-time sentinel for a view with no window", () => {
    expect(viewToQuery({ tab: "compare" })).toBe("tab=compare&range=all");
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
      tab: "body",
      pins: ["metric:weight"],
    });
    expect(params).toEqual({ tab: "body" });
    // (`range=all` rides along because this view names no window — see above.)
    expect(viewToQuery(params)).toBe("tab=body&range=all");
  });
});

// ── #1493 C: saved-view COMPLETENESS ────────────────────────────────────────
//
// "Save current" that drops part of the current state is a bug by its own name.
// Two things were missing from the captured bag, and one that only LOOKED missing:
//
//   • the Body tab's tiles/all layout (#1067 Phase 2) — genuinely absent, now `view`;
//   • the "1D" selection (#1466) — NOT a missing field: 1D is a from/to window
//     (from = to = the chosen day), so it already round-trips through the bounds;
//   • and every PRE-#1486/#1489 stored view has to keep resolving through the tab
//     aliases (vitals → body, compare → insights), which is lib/trends-tabs' job —
//     pinned end-to-end here because the two halves only meet at the URL.
describe("saved-view state completeness (#1493 C)", () => {
  it("captures the Body layout and re-emits it", () => {
    const params = normalizeViewParams({ tab: "body", view: "tiles" });
    expect(params).toEqual({ tab: "body", view: "tiles" });
    expect(viewToQuery(params)).toBe("tab=body&range=all&view=tiles");
    expect(viewToQuery({ tab: "body", view: "all" })).toBe(
      "tab=body&range=all&view=all"
    );
  });

  it("round-trips a Body / tiles / 1D view through storage unchanged", () => {
    // The 1D pill is a one-day window, so this is the WHOLE of that state.
    const saved = view("Yesterday's vitals", {
      tab: "body",
      view: "tiles",
      from: "2026-01-14",
      to: "2026-01-14",
    });
    const reopened = parseViews(serializeViews([saved]))[0];
    expect(reopened).toEqual(saved);
    expect(viewToQuery(reopened.params)).toBe(
      "tab=body&from=2026-01-14&to=2026-01-14&view=tiles"
    );
  });

  it("drops an unrecognized or malformed layout value rather than emitting it", () => {
    expect(normalizeViewParams({ tab: "body", view: "grid" })).toEqual({
      tab: "body",
    });
    expect(normalizeViewParams({ tab: "body", view: 7 })).toEqual({
      tab: "body",
    });
    expect(normalizeViewParams({ tab: "body", view: "" })).toEqual({
      tab: "body",
    });
  });

  // Defensive parse, the whole point: a view stored before `view` existed has no
  // such field and must resolve EXACTLY as it did.
  it("leaves a pre-#1493 stored view untouched", () => {
    const legacy =
      '[{"name":"Lipids","params":{"tab":"insights","cmpn":true}}]';
    const parsed = parseViews(legacy);
    expect(parsed).toEqual([
      { name: "Lipids", params: { tab: "insights", cmpn: true } },
    ]);
    expect(viewToQuery(parsed[0].params)).toBe("tab=insights&range=all&cmpn=1");
  });
});

describe("old-vocabulary saved views resolve through the tab aliases (#1493 C)", () => {
  // A view stored before #1486/#1489 names a tab that no longer exists. It is a
  // VOCABULARY mapping, not a redirect layer: the view emits the name it stored and
  // the hub's parser lands it on the tab that absorbed it, compare params and all.
  it("maps a stored vitals view onto Body and a compare view onto Insights", () => {
    const vitals = normalizeViewParams({ tab: "vitals", from: "2026-01-01" });
    expect(viewToQuery(vitals)).toBe("tab=vitals&from=2026-01-01");
    expect(parseTab("vitals")).toBe("body");

    const compare = normalizeViewParams({
      tab: "compare",
      cmpA: "metric:weight",
      cmpB: "bio:LDL Cholesterol",
      cmpn: true,
    });
    expect(viewToQuery(compare)).toBe(
      "tab=compare&range=all&cmpA=metric%3Aweight&cmpB=bio%3ALDL+Cholesterol&cmpn=1"
    );
    expect(parseTab("compare")).toBe("insights");
  });
});
