import { describe, it, expect } from "vitest";
import canonicalSeed from "@/lib/canonical-biomarkers.json";
import { normalizeCanonicalKey } from "@/lib/canonical-name";

// THE NAMING RULE AS A SCAN (#2335).
//
// The rule is written down beside CANONICAL_ALIASES; this is what stops it regrowing.
// A comment rots; a scan fails the build the moment a new entry re-creates the defect.
//
//   • A bare name is permitted ONLY where a single universal convention fixes its
//     meaning (the serum specimen).
//   • Where two members of one family differ by measure (relative/absolute), specimen
//     (blood/urine), fraction (free/total) or side (left/right), EVERY member states
//     its qualifier — including the one that feels like the default.
//
// WHAT IT LOOKS AT, and why that is the right narrow question. The defect always has
// the same shape: an entry `X` sitting beside an entry `X, <qualifier>`, where nothing
// in `X` says which member of the pair it is. So the scan pairs entries by their
// COMMA-QUALIFIER — not by a general token-subset test, which drowns in coincidences
// ("Insulin" is a sub-name of "Insulin-Like Growth Factor 1", "Iron" of "Total
// Iron-Binding Capacity") and would need exactly the long allowlist that makes a
// half-scan worthless.
//
// Every qualifier that actually sits beside a bare sibling has to be DECLARED below
// with its axis, and the axis decides whether the bare form may exist. So the scan
// fails two ways: on an undeclared qualifier (a new axis nobody thought about) and on
// a declared one whose axis forbids a bare sibling. Both are the same message: say
// what the bare entry measures.
//
// Pure — reads the committed dataset, no DB and no network.

type Axis = {
  // Whether an entry may exist BARE beside a sibling carrying this qualifier.
  bareAllowed: boolean;
  why: string;
  qualifiers: string[];
};

const AXES: Record<string, Axis> = {
  // The specimen axis is the rule's ONE exception, and the reason it is written as an
  // exception rather than an oversight: an unqualified analyte means the SERUM one to
  // every clinician and every lab, so `Albumin` beside `Albumin, Urine` carries no
  // ambiguity. This is why #2335 deliberately did NOT "consistency-fix" these four.
  specimen: {
    bareAllowed: true,
    why: "bare means serum — a universal lab convention",
    qualifiers: ["Urine", "RBC"],
  },
  // A CONTEXT the draw was taken in, not a different measure of it. The bare entry is
  // the reading whose context the document never stated, which is a real and distinct
  // thing — #2337 made exactly that argument when it took the fasting bands OFF the
  // unqualified `Glucose` rather than re-banding it.
  context: {
    bareAllowed: true,
    why: "the bare entry is the reading whose context is unstated (#2337)",
    // "Morning" joined the axis in #2526's audit of the same shape: the time of a
    // diurnal draw is a context the report either states or does not, exactly as
    // fasting is, and the bare `Cortisol` is the draw whose timing it never printed.
    qualifiers: ["Fasting", "Gestational Screen (50 g)", "Morning"],
  },
  // A derived RATIO of the bare analyte to something else is its own quantity, not a
  // second way of measuring the bare one — the same standing `Cholesterol/HDL Ratio`
  // has beside `HDL Cholesterol`. Percent-free PSA does not make `PSA` ambiguous: an
  // unqualified PSA is the total, in ng/mL.
  ratio: {
    bareAllowed: true,
    why: "a ratio is its own quantity, not a measure of the bare one",
    qualifiers: ["Free %"],
  },
  // The three axes that FORBID a bare sibling. Nothing outside the name says which
  // member a bare form is, which is the defect #2335 fixed: the CBC differential held
  // both conventions at once (bare "Neutrophils" was the %, bare "Monocytes" the
  // count), and the two eye analytes sat beside per-eye siblings saying nothing.
  measure: {
    bareAllowed: false,
    why: "relative and absolute are different quantities of the same cell",
    qualifiers: ["Relative", "Absolute"],
  },
  fraction: {
    bareAllowed: false,
    why: "free and total are different assays",
    qualifiers: ["Free", "Total", "Indirect"],
  },
  side: {
    bareAllowed: false,
    why: "a reading of one side is not a reading of the subject",
    // The audiogram thresholds carry their frequency in the same qualifier
    // ("Right Ear 4 kHz"), and no bare "Hearing Threshold" entry exists, so only the
    // eye spellings are reachable here.
    qualifiers: ["Left Eye", "Right Eye", "Unspecified Eye"],
  },
};

const AXIS_OF_QUALIFIER = new Map<string, string>(
  Object.entries(AXES).flatMap(([axis, a]) =>
    a.qualifiers.map((q) => [q.toLowerCase(), axis] as [string, string])
  )
);

interface Pair {
  bare: string;
  qualifier: string;
  qualified: string;
}

// Every (bare entry, qualifier) pair in a vocabulary: an entry whose comma-prefix is
// ITSELF an entry. Split at every comma, because a qualified name can carry more than
// one ("Casts, Hyaline, Urine"), and compare through normalizeCanonicalKey so
// punctuation and word order can't hide a pair.
function bareQualifiedPairs(names: readonly string[]): Pair[] {
  const byKey = new Map<string, string>();
  for (const n of names) {
    const k = normalizeCanonicalKey(n);
    if (k && !byKey.has(k)) byKey.set(k, n);
  }
  const pairs: Pair[] = [];
  for (const name of names) {
    const parts = name.split(", ");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(", ");
      const qualifier = parts.slice(i).join(", ");
      const bare = byKey.get(normalizeCanonicalKey(prefix));
      if (!bare) continue;
      if (normalizeCanonicalKey(bare) === normalizeCanonicalKey(name)) continue;
      pairs.push({ bare, qualifier, qualified: name });
    }
  }
  return pairs;
}

const NAMES = (
  canonicalSeed as { biomarkers: { name: string }[] }
).biomarkers.map((b) => b.name);

describe("canonical naming rule — a name states what it measures (#2335)", () => {
  it("declares an axis for every qualifier that sits beside a bare sibling", () => {
    const undeclared = bareQualifiedPairs(NAMES)
      .filter((p) => !AXIS_OF_QUALIFIER.has(p.qualifier.toLowerCase()))
      .map((p) => `${p.qualified} (qualifier "${p.qualifier}")`);
    expect(
      [...new Set(undeclared)],
      "a canonical entry sits beside a bare sibling under a qualifier no axis in " +
        "this file declares. Add it to AXES with the axis it belongs to — and if " +
        "that axis forbids a bare sibling, qualify the bare entry instead."
    ).toEqual([]);
  });

  it("leaves no bare name whose qualified sibling differs by measure, fraction or side", () => {
    const offenders = bareQualifiedPairs(NAMES)
      .filter((p) => {
        const axis = AXIS_OF_QUALIFIER.get(p.qualifier.toLowerCase());
        return axis !== undefined && !AXES[axis].bareAllowed;
      })
      .map((p) => `${p.bare} (beside ${p.qualified})`);
    expect(
      [...new Set(offenders)],
      "a bare canonical name has a qualified sibling on an axis where the bare " +
        "form's meaning is not fixed by any convention. State the qualifier on " +
        "BOTH members — including the one that feels like the default."
    ).toEqual([]);
  });

  it("still permits the bare-means-serum entries (the rule's one exception)", () => {
    const bares = new Set(
      bareQualifiedPairs(NAMES)
        .filter(
          (p) => AXIS_OF_QUALIFIER.get(p.qualifier.toLowerCase()) === "specimen"
        )
        .map((p) => p.bare)
    );
    // Exactly the entries #2335 was asked NOT to touch (Glucose reaches this list
    // through "Glucose, Urine"; its fasting/gestational siblings are the context axis).
    expect([...bares].sort()).toEqual([
      "Albumin",
      "Creatinine",
      "Folate",
      "Glucose",
      "Magnesium",
    ]);
  });

  it("catches the defect it was written for (the scan is live, not vacuous)", () => {
    // The pre-#2335 differential, in miniature: a bare name meaning the percentage
    // beside a ", Absolute" sibling, and a bare name meaning the count beside a
    // ", Relative" one. Both must be reported.
    const before = [
      "Neutrophils",
      "Neutrophils, Absolute",
      "Monocytes",
      "Monocytes, Relative",
      "Intraocular Pressure",
      "Intraocular Pressure, Right Eye",
      "Albumin",
      "Albumin, Urine",
    ];
    const flagged = bareQualifiedPairs(before)
      .filter((p) => {
        const axis = AXIS_OF_QUALIFIER.get(p.qualifier.toLowerCase());
        return axis !== undefined && !AXES[axis].bareAllowed;
      })
      .map((p) => p.bare);
    expect([...new Set(flagged)].sort()).toEqual([
      "Intraocular Pressure",
      "Monocytes",
      "Neutrophils",
    ]);
    // …and the serum exception is NOT swept up with them.
    expect(flagged).not.toContain("Albumin");
  });

  it("keeps every declared qualifier reachable (no dead axis entries)", () => {
    // A qualifier declared here but present on NO canonical entry is either a typo or
    // a leftover — either way the axis it claims to cover isn't covered.
    const seen = new Set(
      NAMES.flatMap((n) =>
        n
          .split(", ")
          .slice(1)
          .map((_, i, arr) => arr.slice(i).join(", ").toLowerCase())
      )
    );
    const dead = [...AXIS_OF_QUALIFIER.keys()].filter((q) => !seen.has(q));
    expect(dead).toEqual([]);
  });
});
