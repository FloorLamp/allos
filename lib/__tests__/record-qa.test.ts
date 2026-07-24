// PURE TIER (npm test) — the grounded record Q&A assembly (issue #878, Phase 2).
//
// Pins the grounding contract: the prompt and the offline answer render ONLY the
// retrieved citations, so a record the retrieval didn't surface cannot appear in the
// output (the Phase-2 twin of Phase 1's "payload-absent field can't appear"). Also the
// deterministic term extractor (question → salient search terms), the numbered citation
// assembly, and the empty-retrieval refusal ("nothing found," never a speculation).

import { describe, it, expect } from "vitest";
import {
  extractQueryTerms,
  buildRetrievalSet,
  buildAskPrompt,
  composeOfflineAnswer,
  MAX_CITATIONS,
  type RecordCitation,
} from "@/lib/record-qa";
import type { SearchHit } from "@/lib/search-rank";
import type { AppRoute } from "@/lib/hrefs";

const HIT = (over: Partial<SearchHit>): SearchHit => ({
  domain: "supplement",
  key: "supplement:1",
  title: "Amoxicillin",
  subtitle: "Active",
  href: "/medications" as AppRoute,
  date: null,
  ...over,
});

describe("extractQueryTerms — the deterministic retrieval seam", () => {
  it("keeps salient terms and drops question scaffolding + verbs", () => {
    // "when did I last take antibiotics?" retrieves on the record noun alone.
    expect(extractQueryTerms("when did I last take antibiotics?")).toEqual([
      "antibiotics",
    ]);
  });

  it("dedupes, lowercases, and drops 1-2 char fragments", () => {
    expect(extractQueryTerms("Ibuprofen ibuprofen mg for a headache")).toEqual([
      "ibuprofen",
      "headache",
    ]);
  });

  it("returns no terms for a question with only stopwords", () => {
    expect(extractQueryTerms("when did I last take it?")).toEqual([]);
  });
});

describe("buildRetrievalSet — numbered, capped citations", () => {
  it("numbers the hits 1..n and carries only their own fields", () => {
    const set = buildRetrievalSet([
      HIT({ key: "supplement:1", title: "Amoxicillin", date: "2026-03-04" }),
      HIT({ key: "encounter:2", domain: "encounter", title: "Sick visit" }),
    ]);
    expect(set.map((c) => c.index)).toEqual([1, 2]);
    expect(set[0]).toMatchObject({
      title: "Amoxicillin",
      date: "2026-03-04",
      href: "/medications",
    });
  });

  it("caps at MAX_CITATIONS", () => {
    const many = Array.from({ length: MAX_CITATIONS + 5 }, (_, i) =>
      HIT({ key: `supplement:${i}`, title: `Item ${i}` })
    );
    expect(buildRetrievalSet(many)).toHaveLength(MAX_CITATIONS);
  });
});

const CITATIONS: RecordCitation[] = [
  {
    index: 1,
    domain: "supplement",
    title: "Amoxicillin",
    subtitle: "Active",
    date: "2026-03-04",
    href: "/medications" as AppRoute,
  },
];

describe("buildAskPrompt — grounded in the citations ONLY", () => {
  it("lists every citation by number and asks for cited answers", () => {
    const p = buildAskPrompt("when did I last take antibiotics?", CITATIONS);
    expect(p).toContain("Amoxicillin");
    expect(p).toContain("[1]");
    expect(p).toContain("Nothing found in your records");
  });

  it("cannot contain a record the retrieval did not surface", () => {
    const p = buildAskPrompt("when did I last take antibiotics?", CITATIONS);
    // A med the profile takes but that wasn't retrieved has no path into the prompt —
    // the model can only cite what it's handed.
    expect(p).not.toContain("Lisinopril");
    expect(p).not.toContain("Metformin");
  });
});

describe("composeOfflineAnswer — the offline floor + the refusal", () => {
  it("refuses with 'nothing found' when retrieval is empty (never speculates)", () => {
    expect(composeOfflineAnswer("anything?", [])).toBe(
      "Nothing found in your records."
    );
  });

  it("gives an honest offline intro when there are grounded rows", () => {
    const text = composeOfflineAnswer("antibiotics?", CITATIONS);
    expect(text).toContain("1 matching record");
    // The offline path never fabricates an answer beyond the count — the rows are
    // linked separately by the surface.
    expect(text).not.toContain("Amoxicillin");
  });
});
