import { describe, it, expect } from "vitest";
import {
  classifyEpisodeMed,
  episodeMedChecklist,
  type EpisodeMedInput,
  type EpisodeRange,
} from "@/lib/episode-med-reconcile";

// Pure episode-end medication reconciliation (issue #880). Pins the association +
// default-check classification the checklist keys on: OTC/PRN created DURING the illness
// arrives pre-checked; an Rx course or a created-before med is LISTED unchecked; a med
// unrelated to the window is not listed at all. Suggest-only (#560) is the whole point —
// nothing is ever pre-checked that the app couldn't safely retire on resolution.

const RANGE: EpisodeRange = { start: "2026-03-10", endInclusive: "2026-03-17" };

function med(over: Partial<EpisodeMedInput>): EpisodeMedInput {
  return {
    itemId: 1,
    name: "Ibuprofen",
    asNeeded: true,
    rx: false,
    hasOpenCourse: true,
    createdOn: "2026-03-12",
    administrationDates: ["2026-03-12", "2026-03-14"],
    ...over,
  };
}

describe("classifyEpisodeMed", () => {
  it("OTC PRN created DURING the episode → associated + default-checked (the 2am ibuprofen)", () => {
    const s = classifyEpisodeMed(med({}), RANGE);
    expect(s).not.toBeNull();
    expect(s!.klass).toBe("otc-prn");
    expect(s!.defaultChecked).toBe(true);
  });

  it("OTC PRN created BEFORE but used during → listed UNCHECKED (a standing med)", () => {
    const s = classifyEpisodeMed(
      med({ createdOn: "2026-01-01", administrationDates: ["2026-03-12"] }),
      RANGE
    );
    expect(s).not.toBeNull();
    expect(s!.klass).toBe("otc-prn");
    expect(s!.defaultChecked).toBe(false);
  });

  it("Rx created during → LISTED but never default-checked ('course finished?')", () => {
    const s = classifyEpisodeMed(
      med({ name: "Amoxicillin", rx: true, asNeeded: false }),
      RANGE
    );
    expect(s).not.toBeNull();
    expect(s!.klass).toBe("course");
    expect(s!.defaultChecked).toBe(false);
  });

  it("Rx PRN created during → still 'course', never default-checked", () => {
    const s = classifyEpisodeMed(
      med({ name: "Rx PRN", rx: true, asNeeded: true }),
      RANGE
    );
    expect(s!.klass).toBe("course");
    expect(s!.defaultChecked).toBe(false);
  });

  it("a med with no in-range creation and no in-range PRN use is NOT associated", () => {
    const s = classifyEpisodeMed(
      med({
        createdOn: "2026-01-01",
        administrationDates: ["2026-01-05", "2026-02-01"],
      }),
      RANGE
    );
    expect(s).toBeNull();
  });

  it("PRN with ANY administration outside the range is not PRN-associated", () => {
    // Created before + a dose before the episode + a dose during → not created-during and
    // not all-inside, so not associated via either path.
    const s = classifyEpisodeMed(
      med({
        createdOn: "2026-01-01",
        administrationDates: ["2026-03-05", "2026-03-12"],
      }),
      RANGE
    );
    expect(s).toBeNull();
  });

  it("a med with no open course is never a candidate", () => {
    expect(classifyEpisodeMed(med({ hasOpenCourse: false }), RANGE)).toBeNull();
  });

  it("a null start floors the lower bound (an open-since-before-log episode)", () => {
    const s = classifyEpisodeMed(med({ createdOn: "2020-01-01" }), {
      start: null,
      endInclusive: "2026-03-17",
    });
    expect(s).not.toBeNull();
    expect(s!.defaultChecked).toBe(true);
  });

  it("a non-PRN OTC med created during is a 'course', not pre-checked", () => {
    const s = classifyEpisodeMed(med({ asNeeded: false, rx: false }), RANGE);
    expect(s!.klass).toBe("course");
    expect(s!.defaultChecked).toBe(false);
  });
});

describe("episodeMedChecklist", () => {
  it("lists only associated meds, default-checked first then name-sorted", () => {
    const list = episodeMedChecklist(
      [
        med({ itemId: 1, name: "Ibuprofen" }), // OTC PRN created during → checked
        med({
          itemId: 2,
          name: "Amoxicillin",
          rx: true,
          asNeeded: false,
        }), // Rx course → unchecked
        med({
          itemId: 3,
          name: "Zzz Vitamin",
          createdOn: "2020-01-01",
          administrationDates: ["2019-01-01"],
        }), // not associated → dropped
      ],
      RANGE
    );
    expect(list.map((s) => s.itemId)).toEqual([1, 2]);
    expect(list[0].defaultChecked).toBe(true);
    expect(list[1].defaultChecked).toBe(false);
  });
});
