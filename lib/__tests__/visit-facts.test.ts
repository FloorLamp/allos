import { describe, it, expect } from "vitest";
import {
  appointmentKindLabel,
  moreFactsLabel,
  specialtyToAppointmentKind,
  visitFactSummary,
  visitWhenLabel,
  type VisitFactInput,
  type VisitFactKey,
} from "@/lib/visit-facts";

// The visit pair's fact row (#3223), the pure half. What a test asserts here is which
// facts the row STATES and which it prompts for — never the wording, which is copy.

const TODAY = "2026-08-20";

function input(over: Partial<VisitFactInput> = {}): VisitFactInput {
  return {
    tense: "upcoming",
    date: "2026-09-03",
    time: "",
    reason: "",
    kind: "",
    provider: "",
    location: "",
    notes: "",
    today: TODAY,
    ...over,
  };
}

const keys = (s: { chips: { key: VisitFactKey }[] }) =>
  s.chips.map((c) => c.key);

describe("the when-chip keeps the day-vs-datetime honesty (#2234)", () => {
  it("states a bare day when there is no time", () => {
    // THE CONTRACT. A visit stores its day and its optional wall-clock time in two
    // columns; a day with no appointment time is a DAY. "Sep 3 · 00:00" would state a
    // midnight nobody entered, so the absence has to read as absence.
    expect(visitWhenLabel("2026-09-03", "", undefined, { today: TODAY })).toBe(
      "Sep 3"
    );
    expect(
      visitWhenLabel("2026-09-03", null, undefined, { today: TODAY })
    ).toBe("Sep 3");
  });

  it("states the day and the clock together when there is a time", () => {
    expect(
      visitWhenLabel("2026-09-03", "14:30", undefined, { today: TODAY })
    ).toBe("Sep 3 · 14:30");
  });

  it("renders the clock in the profile's own time format", () => {
    // A chip is a sentence the person reads, so it obeys the same display prefs as
    // every other rendered time rather than hardcoding the module default.
    expect(
      visitWhenLabel(
        "2026-09-03",
        "14:30",
        { dateFormat: "mdy", timeFormat: "12h" },
        { today: TODAY }
      )
    ).toBe("Sep 3 · 2:30 PM");
  });

  it("carries the year when the visit is not in the reference year", () => {
    expect(visitWhenLabel("2027-01-04", "", undefined, { today: TODAY })).toBe(
      "Jan 4, 2027"
    );
  });
});

describe("which facts the row states (#3223)", () => {
  it("states only the facts with a value, and sends the empty optionals behind the affordance", () => {
    const s = visitFactSummary(input({ provider: "Dr. Ruiz", reason: "Knee" }));
    // Reading order: the seeding pick first, then the rest.
    expect(keys(s)).toEqual(["provider", "when", "reason"]);
    expect(s.absent).toEqual(["kind", "location", "notes"]);
  });

  it("makes the date the one MISSING essential, on the row rather than behind the affordance", () => {
    // Both actions reject a visit with no date, so hiding that behind "more" would let
    // someone reach Save with a form that must fail. Every other fact is genuinely
    // optional in the store.
    const s = visitFactSummary(input({ date: "" }));
    const when = s.chips.find((c) => c.key === "when");
    expect(when?.state).toBe("missing");
    expect(s.absent).not.toContain("when");
  });

  it("states the notes MARKER rather than the notes", () => {
    // A chip states a fact; pasting a paragraph of clinical notes into a chip row would
    // state it at the row's expense.
    const s = visitFactSummary(input({ notes: "Bring the referral letter" }));
    const notes = s.chips.find((c) => c.key === "notes");
    expect(notes?.label).toBe("Notes added");
  });

  it("reads a closed-vocabulary kind back in its human label, and free text as typed", () => {
    // The appointment branch posts a `kind` from a fixed list; the encounter branch
    // posts a free-text `type`. One chip, both dialects.
    expect(
      visitFactSummary(input({ kind: "mental_health" })).chips.find(
        (c) => c.key === "kind"
      )?.label
    ).toBe("Mental health");
    expect(
      visitFactSummary(input({ kind: "Office Visit" })).chips.find(
        (c) => c.key === "kind"
      )?.label
    ).toBe("Office Visit");
  });

  it("offers diagnoses only when the caller has such a column", () => {
    // An appointment has no diagnoses column at all, so the fact must not appear even as
    // an absent one — a trailing affordance offering to add diagnoses to a booking would
    // open an editor over nothing.
    const appointment = visitFactSummary(input());
    expect(appointment.absent).not.toContain("diagnoses");
    const encounter = visitFactSummary(input({ tense: "past", diagnoses: "" }));
    expect(encounter.absent).toContain("diagnoses");
  });
});

describe("the suggestion marking distinguishes proposing from asserting (#846)", () => {
  it("marks a seeded fact, and marks an unseeded stated fact as tracked-and-false", () => {
    const s = visitFactSummary(
      input({
        provider: "Dr. Ruiz",
        location: "4 Bay St",
        seeded: { location: true },
      })
    );
    expect(s.chips.find((c) => c.key === "location")?.suggested).toBe(true);
    // Tracked and FALSE, not absent: this surface seeds, so "the person stated it" is a
    // claim it can make. `undefined` would mean "not tracked at all".
    expect(s.chips.find((c) => c.key === "provider")?.suggested).toBe(false);
  });

  it("leaves a MISSING chip unmarked", () => {
    // A chip with no value cannot have borrowed one, so `data-suggested` would be a
    // claim about a value that does not exist (FactChipRow's rule).
    const s = visitFactSummary(input({ date: "", seeded: { when: true } }));
    expect(s.chips.find((c) => c.key === "when")?.suggested).toBeUndefined();
  });
});

describe("the trailing affordance names what it holds", () => {
  it("renders nothing when every fact is stated", () => {
    expect(moreFactsLabel([])).toBeNull();
  });

  it("names one fact, and lists several", () => {
    expect(moreFactsLabel(["notes"])).toBe("Add notes");
    expect(moreFactsLabel(["kind", "location", "notes"])).toBe(
      "Add kind, location or notes"
    );
  });
});

describe("the provider pick seeds a kind (#3223)", () => {
  it("maps a specialty onto the appointment vocabulary", () => {
    expect(specialtyToAppointmentKind("Dermatology")).toBeNull();
    expect(specialtyToAppointmentKind("Pediatrics")).toBe("well_child");
    expect(specialtyToAppointmentKind("Clinical Psychology")).toBe(
      "mental_health"
    );
    expect(specialtyToAppointmentKind("Optometry")).toBe("vision");
    expect(specialtyToAppointmentKind("Family Medicine")).toBe("physical");
  });

  it("proposes NOTHING for a specialty it does not recognise, never 'other'", () => {
    // "other" is a kind the person might genuinely mean, so inventing it would put a
    // fact on the row they never chose — and a chip marked "from this provider" that
    // says "Other" is worse than no chip at all.
    expect(specialtyToAppointmentKind("Interventional Radiology")).toBeNull();
    expect(specialtyToAppointmentKind("")).toBeNull();
    expect(specialtyToAppointmentKind(null)).toBeNull();
  });

  it("states nothing for a kind value outside the vocabulary", () => {
    expect(appointmentKindLabel("")).toBeNull();
    expect(appointmentKindLabel(null)).toBeNull();
    expect(appointmentKindLabel("dental")).toBe("Dental");
  });
});
