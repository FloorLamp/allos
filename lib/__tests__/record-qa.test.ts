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
  singularizeTerm,
  buildRetrievalSet,
  buildAskPrompt,
  citationLabel,
  composeOfflineAnswer,
  DOMAIN_LABEL,
  MAX_CITATIONS,
  type RecordCitation,
} from "@/lib/record-qa";
import {
  SEARCH_LOGGED_KINDS,
  type SearchHit,
  type SearchLoggedKind,
} from "@/lib/search-rank";
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
    // "when did I last take antibiotics?" retrieves on the record noun alone —
    // now with its singular fold alongside it (#1597).
    expect(extractQueryTerms("when did I last take antibiotics?")).toEqual([
      "antibiotics",
      "antibiotic",
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

describe("plural folding (issue #1597)", () => {
  it("folds the plural shapes a question actually uses", () => {
    // LIKE '%term%' bridges singular→plural on its own; these are the missing
    // direction — a plural ask against a singular-named row.
    expect(singularizeTerm("colds")).toBe("cold");
    expect(singularizeTerm("vaccines")).toBe("vaccine");
    expect(singularizeTerm("allergies")).toBe("allergy");
    expect(singularizeTerm("rashes")).toBe("rash");
    expect(singularizeTerm("glasses")).toBe("glass");
  });

  it("leaves words whose trailing s is part of the word alone", () => {
    for (const word of [
      "stress",
      "illness",
      "virus",
      "sinus",
      "tinnitus",
      "psoriasis",
      "diagnosis",
      "abs",
      "cold",
    ]) {
      expect(singularizeTerm(word)).toBeNull();
    }
  });

  it("emits the singular AFTER the asked-for terms, deduped", () => {
    // Both forms run, the asked-for term first (so the term cap can never be
    // spent on a fold), and a question already carrying both doesn't duplicate.
    expect(extractQueryTerms("any allergies to nuts?")).toEqual([
      "allergies",
      "nuts",
      "allergy",
      "nut",
    ]);
    expect(extractQueryTerms("vaccines and vaccine")).toEqual([
      "vaccines",
      "vaccine",
    ]);
  });

  it("keeps a purely singular question unchanged", () => {
    expect(extractQueryTerms("how did the cold go?")).toEqual(["cold"]);
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

// THE CITATION BADGE NAMES THE KIND (#5096). One `logged` domain carries seven kinds,
// and the badge read the DOMAIN, so a dose, a session and a night all printed the one
// word "Logged entry" — a total lookup giving a coarse answer, never a broken one. The
// kind is a field on the hit now; the badge resolves from it, so the answer gets finer.
// The seven words a reader sees, WRITTEN OUT rather than read back off the table
// under test — a control that re-reads the implementation cannot see a label change.
// `Record<SearchLoggedKind, …>` keeps it total: an eighth kind is a type error here.
const KIND_BADGE: Record<SearchLoggedKind, string> = {
  dose: "Dose",
  food: "Serving",
  practice: "Practice",
  symptom: "Symptom",
  mood: "Check-in",
  body: "Reading",
  sleep: "Sleep",
};

describe("citationLabel — the badge a logged row shows", () => {
  it.each(SEARCH_LOGGED_KINDS)("names the %s kind, not the domain", (kind) => {
    const label = citationLabel({ domain: "logged", loggedKind: kind });
    expect(label).toBe(KIND_BADGE[kind]);
    expect(label).not.toBe(DOMAIN_LABEL.logged);
  });

  it("gives the seven kinds seven different words", () => {
    // What this converges is a whole family reading as one word. Seven labels that are
    // not seven distinct words would be the same flattening under another spelling.
    expect(new Set(Object.values(KIND_BADGE)).size).toBe(
      SEARCH_LOGGED_KINDS.length
    );
  });

  it("leaves every other domain on its own DOMAIN_LABEL", () => {
    expect(citationLabel({ domain: "supplement" })).toBe(
      DOMAIN_LABEL.supplement
    );
    expect(citationLabel({ domain: "encounter" })).toBe("Visit");
    // `loggedKind` is optional, so a logged row that states no kind answers with the
    // domain's own word — the same total map, not a fallback against a blank render.
    expect(citationLabel({ domain: "logged" })).toBe("Logged entry");
  });

  it("carries the hit's kind into the citation and onto the prompt line", () => {
    // The citation's fields are the HIT's own — `buildRetrievalSet` copies the kind
    // rather than parsing it back out of the rendered subtitle.
    const [cite] = buildRetrievalSet([
      HIT({
        domain: "logged",
        loggedKind: "practice",
        key: "logged:practice:7",
        title: "Sauna",
        subtitle: "Practice · Aug 31",
        href: "/history?kind=practice&day=2026-08-31" as AppRoute,
        date: "2026-08-31",
      }),
    ]);
    expect(cite.loggedKind).toBe("practice");
    // The subtitle's leading noun and the badge are one value, not two that agree.
    expect(cite.subtitle?.split(" · ")[0]).toBe(citationLabel(cite));
    expect(buildAskPrompt("sauna?", [cite])).toContain("(Practice)");
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
