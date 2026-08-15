import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRAINING_TAB,
  RETIRED_FITNESS_TAB,
  TRAINING_TABS,
  parseTrainingTab,
  trainingTabStrip,
} from "@/lib/training-tabs";

// #1496 part B: /training reads ?tab= and builds ONLY the active section (#105, the
// Trends pattern). The tab NAMES are the app's deep-link vocabulary — every link
// the app has EVER shipped (?tab=log from the timeline/integrations, ?tab=analyze
// from the plateau finding, ?tab=fitness from longevity, and the retired
// ?tab=goals / ?tab=routines that live on in Telegram history and bookmarks)
// must keep resolving to a real surface. #2892 merged routines and goals into
// Plan; their names map there, never to the default.

describe("parseTrainingTab", () => {
  it("resolves every live tab to itself", () => {
    for (const tab of TRAINING_TABS) expect(parseTrainingTab(tab)).toBe(tab);
  });

  it("keeps the deep-linked tab names the app already ships", () => {
    expect(parseTrainingTab("log")).toBe("log");
    expect(parseTrainingTab("overview")).toBe("overview");
    expect(parseTrainingTab("analyze")).toBe("analyze");
    expect(parseTrainingTab("plan")).toBe("plan");
  });

  it("no longer parses the retired fitness tab (#2894 — the PAGE redirects it)", () => {
    // The parser can only pick a tab; ?tab=fitness means the battery's route
    // now, so the training page matches RETIRED_FITNESS_TAB and redirects
    // BEFORE parsing. Reaching the parser anyway falls back to the default.
    expect(RETIRED_FITNESS_TAB).toBe("fitness");
    expect(parseTrainingTab("fitness")).toBe(DEFAULT_TRAINING_TAB);
    expect((TRAINING_TABS as readonly string[]).includes("fitness")).toBe(
      false
    );
  });

  it("resolves the retired routines/goals names to Plan, not the default (#2892)", () => {
    expect(parseTrainingTab("routines")).toBe("plan");
    expect(parseTrainingTab("goals")).toBe("plan");
  });

  it("falls back to Overview for an unknown, empty, or missing value (#2893)", () => {
    expect(DEFAULT_TRAINING_TAB).toBe("overview");
    expect(parseTrainingTab(undefined)).toBe("overview");
    expect(parseTrainingTab("")).toBe("overview");
    expect(parseTrainingTab("   ")).toBe("overview");
    expect(parseTrainingTab("strength")).toBe("overview");
  });

  it("trims and takes the FIRST value of a repeated param", () => {
    expect(parseTrainingTab(" overview ")).toBe("overview");
    expect(parseTrainingTab(["goals", "log"])).toBe("plan");
  });
});

describe("trainingTabStrip", () => {
  it("lists every tab once, in display order, with labels", () => {
    const strip = trainingTabStrip();
    expect(strip.map((t) => t.id)).toEqual([...TRAINING_TABS]);
    expect(strip.map((t) => t.label)).toEqual([
      "Overview",
      "Log",
      "Analyze",
      "Plan",
    ]);
  });

  it("leads with the default tab (Overview since #2893)", () => {
    expect(trainingTabStrip()[0]?.id).toBe(DEFAULT_TRAINING_TAB);
  });
});
