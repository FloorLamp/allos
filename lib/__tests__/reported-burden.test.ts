import { describe, it, expect } from "vitest";
import {
  computeReportedBurden,
  reportedBurdenTiltCopy,
} from "../reported-burden";

// Today's reported burden (#1300): the burden threshold matrix + basis-aware tilt copy.

describe("computeReportedBurden — threshold matrix", () => {
  it("a single SEVERE symptom tilts (basis symptom, names the worst)", () => {
    const b = computeReportedBurden({
      symptoms: [{ symptom: "cramps", severity: 3 }],
      energy: null,
    });
    expect(b.tilts).toBe(true);
    expect(b.basis).toBe("symptom");
    expect(b.leadSymptom).toEqual({ symptom: "cramps", severity: 3 });
  });

  it("a single MILD symptom does not tilt", () => {
    const b = computeReportedBurden({
      symptoms: [{ symptom: "headache", severity: 1 }],
      energy: null,
    });
    expect(b.tilts).toBe(false);
    expect(b.basis).toBeNull();
    expect(b.leadSymptom).toBeNull();
  });

  it("a single MODERATE symptom alone does not tilt", () => {
    const b = computeReportedBurden({
      symptoms: [{ symptom: "headache", severity: 2 }],
      energy: null,
    });
    expect(b.tilts).toBe(false);
  });

  it("moderate burden across several (>=2 at level>=2) tilts", () => {
    const b = computeReportedBurden({
      symptoms: [
        { symptom: "headache", severity: 2 },
        { symptom: "nausea", severity: 2 },
      ],
      energy: null,
    });
    expect(b.tilts).toBe(true);
    expect(b.basis).toBe("symptom");
    // Ties resolve to the first-encountered worst (both level 2 here) — a symptom is named.
    expect(b.leadSymptom?.severity).toBe(2);
  });

  it("low energy alone (<=2 of 5) tilts on the energy basis", () => {
    const b = computeReportedBurden({ symptoms: [], energy: 2 });
    expect(b.tilts).toBe(true);
    expect(b.basis).toBe("energy");
    expect(b.leadSymptom).toBeNull();
    expect(b.lowEnergy).toBe(true);
  });

  it("mid/high energy alone does not tilt", () => {
    expect(computeReportedBurden({ symptoms: [], energy: 3 }).tilts).toBe(
      false
    );
    expect(computeReportedBurden({ symptoms: [], energy: 5 }).tilts).toBe(
      false
    );
    expect(computeReportedBurden({ symptoms: [], energy: null }).tilts).toBe(
      false
    );
  });

  it("severe symptom AND low energy => basis both", () => {
    const b = computeReportedBurden({
      symptoms: [{ symptom: "cramps", severity: 4 }],
      energy: 1,
    });
    expect(b.basis).toBe("both");
    expect(b.lowEnergy).toBe(true);
    expect(b.leadSymptom?.severity).toBe(4);
  });

  it("Period never drives the tilt on its own; it only frames a symptom tilt", () => {
    // Period context on, but nothing reported → no tilt (calendar never advises).
    expect(
      computeReportedBurden({ symptoms: [], energy: null, periodContext: true })
        .tilts
    ).toBe(false);
    // Period on + a severe symptom → tilts, and the copy may frame with it.
    const framed = computeReportedBurden({
      symptoms: [{ symptom: "cramps", severity: 3 }],
      energy: null,
      periodContext: true,
    });
    expect(framed.tilts).toBe(true);
    expect(framed.periodFramed).toBe(true);
  });

  it("Period context with only low energy does NOT frame (needs a symptom)", () => {
    const b = computeReportedBurden({
      symptoms: [],
      energy: 1,
      periodContext: true,
    });
    expect(b.basis).toBe("energy");
    expect(b.periodFramed).toBe(false);
  });
});

describe("reportedBurdenTiltCopy — basis-aware, names the report", () => {
  it("symptom basis names the severity + symptom", () => {
    const copy = reportedBurdenTiltCopy(
      computeReportedBurden({
        symptoms: [{ symptom: "cramps", severity: 3 }],
        energy: null,
      })
    );
    expect(copy?.reasonCore).toBe("You logged severe cramps today");
    expect(copy?.todayTail).toContain("easier session");
    expect(copy?.also).toBe("logged severe cramps");
  });

  it("energy basis names low energy, invents no numbers", () => {
    const copy = reportedBurdenTiltCopy(
      computeReportedBurden({ symptoms: [], energy: 1 })
    );
    expect(copy?.reasonCore).toBe("Energy's low today");
    expect(copy?.also).toBe("low energy today");
    expect(copy?.reasonCore).not.toMatch(/\d/);
  });

  it("both basis leads with the symptom and mentions energy", () => {
    const copy = reportedBurdenTiltCopy(
      computeReportedBurden({
        symptoms: [{ symptom: "cramps", severity: 4 }],
        energy: 1,
      })
    );
    expect(copy?.reasonCore).toContain("very severe cramps");
    expect(copy?.reasonCore).toContain("energy's low");
    expect(copy?.also).toContain("low energy");
  });

  it("Period framing appears only when on + a symptom fired", () => {
    const copy = reportedBurdenTiltCopy(
      computeReportedBurden({
        symptoms: [{ symptom: "cramps", severity: 3 }],
        energy: null,
        periodContext: true,
      })
    );
    expect(copy?.reasonCore).toBe(
      "You logged severe cramps today (during your period)"
    );
  });

  it("returns null when the day does not tilt", () => {
    expect(
      reportedBurdenTiltCopy(computeReportedBurden({ symptoms: [], energy: 4 }))
    ).toBeNull();
  });
});
