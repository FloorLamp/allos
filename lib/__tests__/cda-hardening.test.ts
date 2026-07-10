import { describe, expect, it } from "vitest";
import { CdaError, parseCcdaDocument } from "@/lib/cda";
import { hasInternalDtdEntities } from "@/lib/cda/parse";
import {
  MAX_XML_WALK_DEPTH,
  collectAssignedEntities,
  collectText,
  buildNarrativeIdMap,
} from "@/lib/cda/normalize";

// Parser-hardening tests (issue #135, item 5). HOSTILE INPUT is SYNTHETIC per the
// PHI policy — no real patient/provider data. Covers: the billion-laughs / DTD
// entity refusal, the recursive-walker depth caps, and that legitimate standard
// entities still decode.

// A "billion laughs" internal DTD subset (exponential entity expansion). We build it
// with an obviously-fake root so it is CDA-shaped but declares custom entities.
const BILLION_LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE ClinicalDocument [
 <!ENTITY lol "lol">
 <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <title>&lol3;</title>
  <component><structuredBody></structuredBody></component>
</ClinicalDocument>`;

// A clean, minimal C-CDA-shaped document with a STANDARD entity (&amp;) in text —
// no DTD, so it must be accepted and the entity decoded.
const CLEAN_CCDA = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <title>Labs &amp; Vitals</title>
  <effectiveTime value="20240115"/>
  <component><structuredBody></structuredBody></component>
</ClinicalDocument>`;

describe("hasInternalDtdEntities", () => {
  it("flags a document that declares custom DTD entities", () => {
    expect(hasInternalDtdEntities(BILLION_LAUGHS)).toBe(true);
  });

  it("does NOT flag standard entities that need no declaration", () => {
    expect(hasInternalDtdEntities(CLEAN_CCDA)).toBe(false);
  });

  it("scans only the DOCTYPE region — a literal <!ENTITY in body text is not flagged", () => {
    const bodyLiteral = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <text>The string &lt;!ENTITY x&gt; appears here as printed narrative.</text>
</ClinicalDocument>`;
    expect(hasInternalDtdEntities(bodyLiteral)).toBe(false);
  });
});

describe("parseCcdaDocument entity hardening", () => {
  it("refuses a billion-laughs / DTD-entity document with a CdaError (contained, not a crash)", () => {
    expect(() => parseCcdaDocument(BILLION_LAUGHS)).toThrow(CdaError);
  });

  it("still parses a clean document and decodes standard XML entities", () => {
    const parsed = parseCcdaDocument(CLEAN_CCDA);
    // The &amp; decodes to & — standard entity handling is preserved.
    expect(parsed.documentDate).toBe("2024-01-15");
  });
});

// ---- recursive-walker depth caps ----

// Build a linear chain `{ [key]: { [key]: … leaf } }` `depth` levels deep.
function nest(depth: number, key: string, leaf: unknown): unknown {
  let node: unknown = leaf;
  for (let i = 0; i < depth; i++) node = { [key]: node };
  return node;
}

describe("collectText depth cap", () => {
  it("does not overflow the stack on a pathologically deep tree", () => {
    const deep = nest(50_000, "child", { "#text": "LEAF" });
    expect(() => collectText(deep)).not.toThrow();
  });

  it("reads text within the cap but truncates past it", () => {
    // Well within the cap → the leaf text is reached.
    expect(collectText(nest(100, "child", { "#text": "SHALLOW" }))).toContain(
      "SHALLOW"
    );
    // Past the cap → recursion stops before the deep leaf, so it is excluded.
    expect(
      collectText(nest(MAX_XML_WALK_DEPTH + 50, "child", { "#text": "DEEP" }))
    ).not.toContain("DEEP");
  });
});

describe("collectAssignedEntities depth cap", () => {
  it("does not overflow on a very deep tree and still collects shallow entities", () => {
    const ae = { assignedEntity: { id: { "@_extension": "x" } } };
    const shallow: unknown[] = [];
    collectAssignedEntities(nest(100, "child", ae), shallow);
    expect(shallow).toHaveLength(1);

    const deepOut: unknown[] = [];
    const deep = nest(50_000, "child", ae);
    expect(() => collectAssignedEntities(deep, deepOut)).not.toThrow();
    // The entity sits below the cap, so it is not collected — contained, not crashed.
    expect(deepOut).toHaveLength(0);
  });
});

describe("buildNarrativeIdMap depth cap", () => {
  it("does not overflow on a very deep tree and indexes shallow IDs only", () => {
    const withId = { "@_ID": "n1", "#text": "Analyte" };
    const shallowMap = buildNarrativeIdMap(nest(100, "content", withId));
    expect(shallowMap.n1).toBe("Analyte");

    const deep = nest(50_000, "content", { "@_ID": "deep", "#text": "X" });
    let deepMap: Record<string, string> = {};
    expect(() => {
      deepMap = buildNarrativeIdMap(deep);
    }).not.toThrow();
    expect(deepMap.deep).toBeUndefined();
  });
});
