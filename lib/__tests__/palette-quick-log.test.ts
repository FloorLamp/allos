import { describe, it, expect } from "vitest";
import { parseQuickLog } from "@/lib/palette-quick-log";

describe("parseQuickLog", () => {
  it("returns null for non-commands (falls through to search)", () => {
    expect(parseQuickLog("", "kg")).toBeNull();
    expect(parseQuickLog("bench press", "kg")).toBeNull();
    expect(parseQuickLog("running 5k", "kg")).toBeNull();
    // A bare keyword with no value is not a command yet.
    expect(parseQuickLog("weight", "kg")).toBeNull();
    expect(parseQuickLog("w", "kg")).toBeNull();
  });

  it("parses a plain weight in the login's unit", () => {
    const r = parseQuickLog("weight 82.5", "kg");
    expect(r).toMatchObject({
      type: "weight",
      value: 82.5,
      unit: "kg",
      error: null,
    });
    expect(r?.label).toBe("Log weight · 82.5 kg");
  });

  it("uses the login's preferred unit when none is given", () => {
    expect(parseQuickLog("weight 180", "lb")).toMatchObject({
      value: 180,
      unit: "lb",
      error: null,
    });
  });

  it("accepts short aliases and integer values", () => {
    expect(parseQuickLog("wt 90", "kg")).toMatchObject({
      value: 90,
      unit: "kg",
    });
    expect(parseQuickLog("bw 200", "lb")).toMatchObject({
      value: 200,
      unit: "lb",
    });
    expect(parseQuickLog("w 75", "kg")).toMatchObject({
      value: 75,
      unit: "kg",
    });
  });

  it("honors an explicit trailing unit over the preference", () => {
    expect(parseQuickLog("weight 180 lb", "kg")).toMatchObject({
      value: 180,
      unit: "lb",
    });
    expect(parseQuickLog("weight 82kg", "lb")).toMatchObject({
      value: 82,
      unit: "kg",
    });
    expect(parseQuickLog("weight 180lbs", "kg")).toMatchObject({
      value: 180,
      unit: "lb",
    });
  });

  it("is case-insensitive on the keyword and unit", () => {
    expect(parseQuickLog("Weight 82.5", "kg")).toMatchObject({ value: 82.5 });
    expect(parseQuickLog("WEIGHT 82.5 KG", "lb")).toMatchObject({
      value: 82.5,
      unit: "kg",
    });
  });

  it("recognizes the command but flags a non-numeric value", () => {
    const r = parseQuickLog("weight abc", "kg");
    expect(r?.type).toBe("weight");
    expect(r?.error).toBeTruthy();
  });

  it("reuses the body-metric range guard to reject impossible values", () => {
    // 0 and negative are rejected by validateBodyMetricInput.
    expect(parseQuickLog("weight 0", "kg")?.error).toBeTruthy();
  });
});

// One-tap practice logging from the palette (#1633). The set of practices is FINITE and
// server-owned (the profile's practice-scope frequency targets); free text can never
// invent one here.
const PRACTICES = [
  { identity: "sauna", name: "Sauna" },
  { identity: "cold plunge", name: "Cold plunge" },
];

describe("parseQuickLog — practices", () => {
  it("logs a tracked practice behind an explicit verb", () => {
    const r = parseQuickLog("log sauna", "kg", PRACTICES);
    expect(r).toMatchObject({
      type: "practice",
      practice: "Sauna",
      identity: "sauna",
      error: null,
    });
    expect(r?.label).toBe("Log practice · Sauna");
    // The other verbs a person reaches for after the fact.
    expect(parseQuickLog("did sauna", "kg", PRACTICES)).toMatchObject({
      type: "practice",
      practice: "Sauna",
    });
    expect(parseQuickLog("done cold plunge", "kg", PRACTICES)).toMatchObject({
      type: "practice",
      practice: "Cold plunge",
    });
  });

  it("writes the TARGET's spelling, folding case and whitespace like everywhere else", () => {
    // practiceIdentity is the one identity function: case and whitespace variants reach
    // the same practice, and the stored spelling — not what was typed — is written, so a
    // quick log lands in the family the Wellness card counts.
    for (const typed of ["log SAUNA", "log Sauna", "log   sauna  "]) {
      expect(parseQuickLog(typed, "kg", PRACTICES), typed).toMatchObject({
        type: "practice",
        practice: "Sauna",
      });
    }
    expect(parseQuickLog("log  cold   plunge", "kg", PRACTICES)).toMatchObject({
      practice: "Cold plunge",
    });
  });

  it("refuses to invent a practice — an untracked name falls through to search", () => {
    expect(parseQuickLog("log breathwork", "kg", PRACTICES)).toBeNull();
    // Synonyms and modalities are deliberately NOT folded (#1591), here as everywhere.
    expect(parseQuickLog("log infrared sauna", "kg", PRACTICES)).toBeNull();
    // And with nothing tracked at all, the verb is just a word.
    expect(parseQuickLog("log sauna", "kg")).toBeNull();
  });

  it("keeps a bare practice name a SEARCH, not a write", () => {
    // Typing "sauna" is how someone looks the practice up. If that parsed as a command
    // it would sit highlighted at the top of the list and Enter would log a session
    // nobody asked for. The verb is the whole safety margin.
    expect(parseQuickLog("sauna", "kg", PRACTICES)).toBeNull();
    expect(parseQuickLog("cold plunge", "kg", PRACTICES)).toBeNull();
  });

  it("never collides with the weight shorthand, whatever a practice is named", () => {
    const shadowing = [
      { identity: "weight", name: "Weight" },
      { identity: "w", name: "W" },
      { identity: "bw", name: "Bw" },
    ];
    // The weight vocabulary still wins on its own keywords…
    expect(parseQuickLog("weight 82.5", "kg", shadowing)).toMatchObject({
      type: "weight",
      value: 82.5,
    });
    expect(parseQuickLog("w 75", "kg", shadowing)).toMatchObject({
      type: "weight",
      value: 75,
    });
    // …and a practice named "weight" is still reachable, because the practice grammar
    // lives behind a verb none of the weight keywords use.
    expect(parseQuickLog("log weight", "kg", shadowing)).toMatchObject({
      type: "practice",
      practice: "Weight",
    });
  });

  it("leaves the palette's other commands alone", () => {
    // "log workout" is a palette ACTION, not a practice — unless someone tracks a
    // practice by that name, in which case it is theirs to log.
    expect(parseQuickLog("log workout", "kg", PRACTICES)).toBeNull();
    expect(parseQuickLog("log", "kg", PRACTICES)).toBeNull();
    expect(parseQuickLog("logbook entry", "kg", PRACTICES)).toBeNull();
  });
});
