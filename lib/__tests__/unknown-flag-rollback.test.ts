import { describe, expect, it } from "vitest";
import {
  flagLabel,
  flagTone,
  isKnownFlag,
  isNormalFlag,
  isNotableFlag,
  reconciledFlag,
  KNOWN_FLAGS,
  NEUTRAL_FLAGS,
  NOTABLE_FLAGS,
  unknownFlagSql,
} from "../reference-range";
import type { CanonicalResultDefinition, MedicalFlag } from "../types";

// THE ROLLBACK CONTRACT FOR FLAG TOKENS (issue #2937), pure half.
//
// `FLAG_LOGIC_VERSION` makes a new flag token retirable forward. Nothing made it
// retirable backward: boot a database upgraded past the build that introduced a token,
// then roll that build back, and the older build reads the value as "Normal"
// everywhere while a `flag NOT IN ('normal','immune')` denylist still counts it as
// flagged — a permanent card reading "Flagged normal — 44", filterable by neither
// state, on a row no reconcile ever selects.
//
// The rule this pins is token-agnostic, which is the point: it keys on "this build
// does not recognise the value", never on a list of the values some past build didn't.
// `immune` (#544, introduced at v5) had exactly this shape under a v4 build, and every
// future flag value has it under every build that predates it.
//
// The tokens below stand in for "written by a build from the future". Nothing in the
// app can produce them: the AI extractor and the CDA ingest are both held to
// MEDICAL_FLAGS (normal/high/low/abnormal), and the reconcile writes only what it can
// restate — so an unrecognised value on a row is always a future build's claim.
const FUTURE_TOKENS = ["reported-critical", "borderline-high", "watch"];

// A band-less catalog entry — nothing of OURS judges a value against it — with no
// printed range on the row either, so `reconciledFlag` reaches its final decision.
const BANDLESS: Partial<CanonicalResultDefinition> = {
  name: "Microalbumin/Creatinine Ratio, Urine",
  unit: "mg/g",
  direction: "in_range",
};

// A banded entry, so the same call can be shown re-deriving rather than only clearing.
const BANDED: Partial<CanonicalResultDefinition> = {
  name: "Alkaline Phosphatase",
  unit: "U/L",
  direction: "in_range",
  ref_low: 40,
  ref_high: 129,
};

describe("which tokens this build recognises", () => {
  it("classifies every known token as notable or neutral, and nothing else", () => {
    expect([...KNOWN_FLAGS].sort()).toEqual(
      [...NOTABLE_FLAGS, ...NEUTRAL_FLAGS].sort()
    );
    for (const f of KNOWN_FLAGS) {
      expect(isKnownFlag(f)).toBe(true);
      expect(isNotableFlag(f)).toBe(
        (NOTABLE_FLAGS as readonly string[]).includes(f)
      );
    }
  });

  it("treats an absent flag as recognised and a future token as not", () => {
    expect(isKnownFlag(null)).toBe(true);
    expect(isKnownFlag(undefined)).toBe(true);
    for (const t of FUTURE_TOKENS) expect(isKnownFlag(t)).toBe(false);
  });

  it("covers the MedicalFlag union at runtime, not only in the type", () => {
    // The compile-time half lives in lib/reference-range/flags.ts. This is the same
    // claim from the other side: every token the union can hold is listed.
    const union: MedicalFlag[] = [
      "normal",
      "high",
      "low",
      "abnormal",
      "immune",
      "non-optimal",
      "non-optimal-high",
      "non-optimal-low",
      "reported-high",
      "reported-low",
    ];
    for (const f of union) expect(isKnownFlag(f)).toBe(true);
    expect([...KNOWN_FLAGS].sort()).toEqual(union.sort());
  });
});

describe("display and query agree about an unrecognised token", () => {
  // The incoherent card was not caused by the unknown token; it was caused by the
  // display tier calling it normal while the query tier called it flagged. Both
  // answers are defensible on their own — only their disagreement is not.
  it("reads as Normal on every display tier", () => {
    for (const t of FUTURE_TOKENS) {
      expect(flagLabel(t)).toBe("Normal");
      expect(isNormalFlag(t)).toBe(true);
      expect(flagTone(t)).toBe("default");
    }
  });

  it("is not notable, so no flagged read may claim it", () => {
    for (const t of FUTURE_TOKENS) expect(isNotableFlag(t)).toBe(false);
  });

  it("spells the unknown-token SQL from the same list the predicates read", () => {
    const clause = unknownFlagSql();
    const listed = new Set(
      [...clause.matchAll(/'([^']+)'/g)].map((m) => m[1])
    );
    expect([...listed].sort()).toEqual([...KNOWN_FLAGS].sort());
    expect(clause.startsWith("flag NOT IN (")).toBe(true);
  });
});

describe("a reconcile re-decides a flag it does not recognise", () => {
  it("retires an unrecognised token when nothing of ours judges the value", () => {
    // The row a rollback strands: a band-less analyte, so no reference or optimal band
    // reaches a verdict, and no printed range to fall back on. Before #2937 this
    // returned `undefined` (leave it), which is what made the value permanent.
    for (const t of FUTURE_TOKENS) {
      expect(reconciledFlag(t, 44, "mg/g", BANDLESS)).toBeNull();
    }
  });

  it("re-derives it against a band when there is one", () => {
    expect(reconciledFlag(FUTURE_TOKENS[0], 300, "U/L", BANDED)).toBe("high");
    expect(reconciledFlag(FUTURE_TOKENS[0], 80, "U/L", BANDED)).toBeNull();
  });

  it("leaves the recognised verdicts exactly as they were", () => {
    // The forward path is unchanged: `abnormal` is not the numeric pass's word,
    // an in-band value still clears, and a band-less row keeps a lab's own high/low.
    expect(reconciledFlag("abnormal", 44, "mg/g", BANDLESS)).toBeUndefined();
    expect(reconciledFlag("high", 44, "mg/g", BANDLESS)).toBeUndefined();
    expect(reconciledFlag("low", 44, "mg/g", BANDLESS)).toBeUndefined();
    expect(reconciledFlag(null, 44, "mg/g", BANDLESS)).toBeUndefined();
    expect(reconciledFlag("normal", 44, "mg/g", BANDLESS)).toBeUndefined();
    expect(reconciledFlag("high", 300, "U/L", BANDED)).toBeUndefined();
  });

  it("declines to touch a row it could not have written the flag on", () => {
    // Above the two decline gates the flag is not ours to retire, unrecognised or
    // not: an unconvertible unit means this build could never have derived a flag
    // there. Those rows are covered by the display/query agreement above instead.
    expect(reconciledFlag(FUTURE_TOKENS[0], 44, "torr", BANDED)).toBeUndefined();
    expect(reconciledFlag(FUTURE_TOKENS[0], 44, "mg/g", null)).toBeUndefined();
  });
});
