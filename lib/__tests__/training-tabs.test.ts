import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRAINING_TAB,
  TRAINING_TABS,
  parseTrainingTab,
  trainingTabStrip,
} from "@/lib/training-tabs";

// #1496 part B: /training reads ?tab= and builds ONLY the active section (#105, the
// Trends pattern). The tab NAMES are the app's deep-link vocabulary — every existing
// link (?tab=log from the timeline/integrations, ?tab=analyze from the plateau
// finding, ?tab=goals from the dashboard widget, ?tab=fitness from longevity,
// ?tab=routines from onboarding) must keep resolving to itself.

describe("parseTrainingTab", () => {
  it("resolves every live tab to itself", () => {
    for (const tab of TRAINING_TABS) expect(parseTrainingTab(tab)).toBe(tab);
  });

  it("keeps the deep-linked tab names the app already ships", () => {
    expect(parseTrainingTab("log")).toBe("log");
    expect(parseTrainingTab("overview")).toBe("overview");
    expect(parseTrainingTab("analyze")).toBe("analyze");
    expect(parseTrainingTab("fitness")).toBe("fitness");
    expect(parseTrainingTab("routines")).toBe("routines");
    expect(parseTrainingTab("goals")).toBe("goals");
  });

  it("falls back to Log for an unknown, empty, or missing value", () => {
    expect(DEFAULT_TRAINING_TAB).toBe("log");
    expect(parseTrainingTab(undefined)).toBe("log");
    expect(parseTrainingTab("")).toBe("log");
    expect(parseTrainingTab("   ")).toBe("log");
    expect(parseTrainingTab("strength")).toBe("log");
  });

  it("trims and takes the FIRST value of a repeated param", () => {
    expect(parseTrainingTab(" overview ")).toBe("overview");
    expect(parseTrainingTab(["goals", "log"])).toBe("goals");
  });
});

describe("trainingTabStrip", () => {
  it("lists every tab once, in display order, with labels", () => {
    const strip = trainingTabStrip();
    expect(strip.map((t) => t.id)).toEqual([...TRAINING_TABS]);
    expect(strip.map((t) => t.label)).toEqual([
      "Log",
      "Overview",
      "Analyze",
      "Fitness check",
      "Routines",
      "Goals",
    ]);
  });

  it("leads with the default tab (Log is the Journal)", () => {
    expect(trainingTabStrip()[0]?.id).toBe(DEFAULT_TRAINING_TAB);
  });
});
