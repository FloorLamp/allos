import { describe, it, expect } from "vitest";
import {
  cadenceFactLabel,
  moreProtocolFactsLabel,
  practiceFactLabel,
  protocolFactSummary,
  windowFactLabel,
  type ProtocolFactInput,
  type ProtocolFactKey,
} from "../protocol-facts";

// #3219: what the protocol form's chip row states. The chip KEYS and their states are
// the contract; the wording is not (see the module header).

const BLANK: ProtocolFactInput = {
  practice: null,
  perWeek: null,
  perWeekMax: null,
  startDate: "",
  endDate: "",
  intakeItemName: null,
  equipmentName: null,
  situation: "",
  notes: "",
};

function keys(input: Partial<ProtocolFactInput>): ProtocolFactKey[] {
  return protocolFactSummary({ ...BLANK, ...input }).chips.map((c) => c.key);
}

function stateOf(
  input: Partial<ProtocolFactInput>,
  key: ProtocolFactKey
): string | undefined {
  return protocolFactSummary({ ...BLANK, ...input }).chips.find(
    (c) => c.key === key
  )?.state;
}

function labelOf(
  input: Partial<ProtocolFactInput>,
  key: ProtocolFactKey
): string | undefined {
  return protocolFactSummary({ ...BLANK, ...input }).chips.find(
    (c) => c.key === key
  )?.label;
}

describe("the protocol chip row states the sentence it will write (#3219)", () => {
  it("an empty form states only the window, as a missing essential, and holds the rest back", () => {
    const summary = protocolFactSummary(BLANK);
    expect(summary.chips.map((c) => c.key)).toEqual(["window"]);
    expect(summary.chips[0].state).toBe("missing");
    // The practice is neither stated nor missing: it is a "+ practice" PROMPT, which
    // the row draws from this flag. A protocol that tracks no weekly practice is
    // complete, so the row must not accuse it of a gap.
    expect(summary.practiceAbsent).toBe(true);
    expect(summary.more).toEqual(["link", "situation", "notes"]);
  });

  it("a practice pick brings the cadence question with it, and nothing else does", () => {
    // THE CADENCE CHIP IS AN ESSENTIAL OF THE PRACTICE, not of the protocol. Without a
    // practice there is nothing to count, so a dashed "add a cadence" would be
    // demanding an answer to a question nobody asked.
    expect(keys({})).not.toContain("cadence");
    expect(
      keys({ practice: { scopeKind: "practice", value: "Sauna" } })
    ).toEqual(["practice", "cadence", "window"]);
    expect(
      stateOf(
        { practice: { scopeKind: "practice", value: "Sauna" } },
        "cadence"
      )
    ).toBe("missing");
  });

  it("states a cadence once it has one, and its range when the practice carries one", () => {
    const withPractice = {
      practice: { scopeKind: "practice", value: "Sauna" } as const,
    };
    expect(labelOf({ ...withPractice, perWeek: 3 }, "cadence")).toBe("3×/week");
    expect(
      labelOf({ ...withPractice, perWeek: 3, perWeekMax: 5 }, "cadence")
    ).toBe("3–5×/week");
    expect(stateOf({ ...withPractice, perWeek: 3 }, "cadence")).toBe("stated");
  });

  it("holds every absent optional behind the trailing affordance, and states it once present", () => {
    // An ABSENT OPTIONAL renders nothing at all — that is the primitive's contract,
    // and the difference between it and a missing essential is the whole reason the
    // row is readable at three facts instead of nine.
    const stated = protocolFactSummary({
      ...BLANK,
      intakeItemName: "Omega-3",
      situation: "Creatine loading",
      notes: "5 g with breakfast",
    });
    expect(stated.more).toEqual([]);
    expect(stated.chips.map((c) => c.key)).toEqual([
      "window",
      "link",
      "situation",
      "notes",
    ]);
    // Whitespace is not a fact.
    expect(
      protocolFactSummary({ ...BLANK, situation: "   ", notes: "\n" }).more
    ).toEqual(["link", "situation", "notes"]);
  });

  it("states the link once, whichever of its two fields answered it", () => {
    // ONE QUESTION — "what is this protocol about" — answered in either vocabulary.
    // Two chips would state one fact twice and leave one permanently absent.
    expect(labelOf({ intakeItemName: "Omega-3" }, "link")).toBe("With Omega-3");
    expect(labelOf({ equipmentName: "Sauna cabin" }, "link")).toBe(
      "Using Sauna cabin"
    );
    expect(
      labelOf(
        { intakeItemName: "Omega-3", equipmentName: "Sauna cabin" },
        "link"
      )
    ).toBe("With Omega-3 · Sauna cabin");
  });

  it("names the practice by its own noun, never by the counting phrase", () => {
    // `protocolPracticeLabel` appends "sessions"/"servings", which reads correctly
    // beside a count ("3 of 4 Sauna sessions") and wrongly as the subject of a
    // sentence whose NEXT chip is the count.
    expect(practiceFactLabel("practice", "Sauna")).toBe("Sauna");
    expect(practiceFactLabel("type", "strength")).toBe("Strength");
    expect(practiceFactLabel("food_group", "fatty_fish")).toBe("Fatty fish");
  });
});

describe("the window chip states a length, not two dates (#3219)", () => {
  it("states whole weeks when the span divides into them", () => {
    expect(windowFactLabel("2026-01-01", "2026-03-26")).toBe("12 weeks");
    expect(windowFactLabel("2026-01-01", "2026-01-08")).toBe("1 week");
  });

  it("states days below a week, and the endpoint when it is neither", () => {
    expect(windowFactLabel("2026-01-01", "2026-01-02")).toBe("1 day");
    expect(windowFactLabel("2026-01-01", "2026-01-04")).toBe("3 days");
    // 11 weeks 3 days is arithmetic nobody asked for, so it states the endpoint.
    expect(windowFactLabel("2026-01-01", "2026-03-20")).toContain("Until ");
  });

  it("states the endpoint it has when the window is open at one end", () => {
    expect(windowFactLabel("2026-01-01", "")).toContain("From ");
    expect(windowFactLabel("", "2026-03-26")).toContain("Until ");
    expect(windowFactLabel("", "")).toBeNull();
  });

  it("does not claim a length for a window that ends before it starts", () => {
    // A negative span is a typo in progress, not a fact. It states the end date
    // rather than "-42 days", which would read as a number the form intends to write.
    expect(windowFactLabel("2026-03-26", "2026-01-01")).toContain("Until ");
  });
});

describe("supporting labels", () => {
  it("names the facts the trailing affordance holds, and says nothing when it holds none", () => {
    expect(moreProtocolFactsLabel(["situation", "notes"])).toBe(
      "situation, notes…"
    );
    expect(moreProtocolFactsLabel([])).toBe("");
  });

  it("drops a ceiling that is not above the floor", () => {
    // `parseScopedPractice` discards a max ≤ the min, so a chip claiming "3–3×/week"
    // or "3–2×/week" would be stating a range the write does not keep.
    expect(cadenceFactLabel(3, 3)).toBe("3×/week");
    expect(cadenceFactLabel(3, 2)).toBe("3×/week");
    expect(cadenceFactLabel(3, null)).toBe("3×/week");
  });
});
