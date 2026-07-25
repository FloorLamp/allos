import { describe, expect, it } from "vitest";
import { cardCellAttrs, cardMetaEntries } from "@/lib/card-row";

// The pure half of the responsive-table contract (issue #1426): which cells claim a
// card slot, and which attributes earn a place on a card's compact meta line. The
// fixtures below are the #531–#534 discipline — label by what DIFFERS — expressed
// at cell granularity.

describe("cardCellAttrs", () => {
  it("a cell with no slot claims nothing (desktop-only detail)", () => {
    expect(cardCellAttrs({})).toEqual({});
    expect(cardCellAttrs({ empty: true })).toEqual({});
  });

  it("carries the slot through for a populated cell", () => {
    expect(cardCellAttrs({ slot: "title" })).toEqual({ "data-card": "title" });
    expect(cardCellAttrs({ slot: "meta" })).toEqual({ "data-card": "meta" });
  });

  it("drops an empty meta or value cell so a card never shows a bare placeholder", () => {
    expect(cardCellAttrs({ slot: "meta", empty: true })).toEqual({});
    expect(cardCellAttrs({ slot: "value", empty: true })).toEqual({});
  });

  it("keeps structural slots even when the caller calls them empty", () => {
    // A group-continuation row's blank name cell still anchors the card's layout,
    // and an actions/edit-form cell is never dropped on emptiness.
    expect(cardCellAttrs({ slot: "title", empty: true })).toEqual({
      "data-card": "title",
    });
    expect(cardCellAttrs({ slot: "actions", empty: true })).toEqual({
      "data-card": "actions",
    });
    expect(cardCellAttrs({ slot: "full", empty: true })).toEqual({
      "data-card": "full",
    });
  });
});

describe("cardMetaEntries", () => {
  it("keeps informative attributes in column order, with their labels", () => {
    expect(
      cardMetaEntries(["Volume", "Sets", "Top set"], ["4,200 kg", "5", "80 kg"])
    ).toEqual([
      { index: 0, label: "Volume", value: "4,200 kg" },
      { index: 1, label: "Sets", value: "5" },
      { index: 2, label: "Top set", value: "80 kg" },
    ]);
  });

  it("drops placeholder and blank cells — a dash distinguishes nothing", () => {
    expect(
      cardMetaEntries(
        ["Panel", "Reference", "Notes", "Category"],
        ["—", "  ", null, "Metabolic"]
      )
    ).toEqual([{ index: 3, label: "Category", value: "Metabolic" }]);
    // Every dash shape the tables use to hold a column grid open.
    expect(cardMetaEntries(["A", "B", "C"], ["-", "–", "--"])).toEqual([]);
  });

  it("drops an attribute that merely repeats the card title", () => {
    // The title already says it, so as a meta attribute it adds no distinction —
    // compared trimmed and case-insensitively.
    expect(
      cardMetaEntries(["Session", "Duration"], [" 12 Mar 2026 ", "48 min"], {
        title: "12 mar 2026",
      })
    ).toEqual([{ index: 1, label: "Duration", value: "48 min" }]);
  });

  it("drops a later duplicate value but keeps the first label", () => {
    // Two columns agreeing is one fact, not two: the headline value (index 0) is
    // said once, and the column echoing it falls away.
    expect(
      cardMetaEntries(["Best set", "Top set", "Sets"], ["80 kg", "80 kg", "5"])
    ).toEqual([
      { index: 0, label: "Best set", value: "80 kg" },
      { index: 2, label: "Sets", value: "5" },
    ]);
  });

  it("keeps two attributes that share a label but differ in value", () => {
    // Labels may repeat across a dynamic column set; only the VALUE decides
    // survival, and the index keeps them addressable apart (#534's id fallback).
    expect(cardMetaEntries(["Pace", "Pace"], ["5:02 /km", "4:48 /km"])).toEqual(
      [
        { index: 0, label: "Pace", value: "5:02 /km" },
        { index: 1, label: "Pace", value: "4:48 /km" },
      ]
    );
  });

  it("ignores values with no matching label", () => {
    expect(cardMetaEntries(["Only"], ["a", "b", "c"])).toEqual([
      { index: 0, label: "Only", value: "a" },
    ]);
  });

  it("an all-placeholder row yields an empty meta line, not a line of dashes", () => {
    expect(cardMetaEntries(["Panel", "Notes"], ["—", "—"])).toEqual([]);
  });
});
