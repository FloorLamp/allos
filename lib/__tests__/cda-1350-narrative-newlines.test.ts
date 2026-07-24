import { describe, it, expect } from "vitest";
import { parser, collectBlockNarrative } from "@/lib/cda/normalize";

// #1350: CDA narrative is STRUCTURED (<paragraph>/<br/>/<list><item>/<table><tr>),
// but the old note-body path flattened all of it with a single space, so a
// multi-paragraph Progress Note arrived at NotesText as a run-on blob. The block
// collector emits a newline at each block-level boundary and collapses only
// intra-line whitespace, so the structure survives to NotesText's pre-wrap render.
//
// Parse a <text> narrative fragment the way parseCcdaDocument does — including its
// <br/>→"\n" preprocess — then read the parsed narrative node.
function narrative(xml: string): unknown {
  return (parser.parse(xml.replace(/<br\s*\/?>/gi, "\n")) as { text: unknown })
    .text;
}

describe("CDA narrative block collection (#1350)", () => {
  it("emits a blank line between paragraphs", () => {
    const node = narrative(
      `<text><paragraph>First paragraph.</paragraph><paragraph>Second paragraph.</paragraph></text>`
    );
    expect(collectBlockNarrative(node)).toBe(
      "First paragraph.\n\nSecond paragraph."
    );
  });

  it("puts one list item per line", () => {
    const node = narrative(
      `<text><list><item>Rest and fluids</item><item>Recheck in 2 weeks</item></list></text>`
    );
    expect(collectBlockNarrative(node)).toBe(
      "Rest and fluids\nRecheck in 2 weeks"
    );
  });

  it("puts one table row per line, cells space-joined", () => {
    const node = narrative(
      `<text><table><tbody><tr><td>BP</td><td>120/80</td></tr><tr><td>HR</td><td>72</td></tr></tbody></table></text>`
    );
    expect(collectBlockNarrative(node)).toBe("BP 120/80\nHR 72");
  });

  it("keeps <br/> line breaks inside a block", () => {
    const node = narrative(
      `<text><paragraph>Line one<br/>Line two</paragraph></text>`
    );
    expect(collectBlockNarrative(node)).toBe("Line one\nLine two");
  });

  it("collapses intra-line whitespace but preserves block newlines", () => {
    const node = narrative(
      `<text><paragraph>Assessment:   stable    patient.</paragraph><list><item>Continue   meds</item></list></text>`
    );
    expect(collectBlockNarrative(node)).toBe(
      "Assessment: stable patient.\n\nContinue meds"
    );
  });

  it("renders a multi-paragraph note with heading + list as structure, not a blob", () => {
    const node = narrative(
      `<text>` +
        `<paragraph>Chief complaint: cough for 5 days.</paragraph>` +
        `<paragraph>Assessment: acute sinusitis.</paragraph>` +
        `<list><item>Amoxicillin 500mg TID</item><item>Return if fever</item></list>` +
        `</text>`
    );
    const out = collectBlockNarrative(node);
    expect(out).toBe(
      [
        "Chief complaint: cough for 5 days.",
        "",
        "Assessment: acute sinusitis.",
        "",
        "Amoxicillin 500mg TID",
        "Return if fever",
      ].join("\n")
    );
    // The whole point: it is NOT a single flattened line.
    expect(out.split("\n").length).toBeGreaterThan(3);
  });

  it("returns empty for an absent narrative", () => {
    expect(collectBlockNarrative(undefined)).toBe("");
    expect(collectBlockNarrative(null)).toBe("");
  });
});
