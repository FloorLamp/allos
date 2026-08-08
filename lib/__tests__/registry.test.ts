import { describe, expect, it } from "vitest";
import { INTEGRATIONS, getIntegration } from "@/lib/integrations/registry";
import {
  FITBIT_READINESS_SCORE_METRIC,
  FITBIT_SLEEP_SCORE_METRIC,
} from "@/lib/integrations/fitbit-takeout";

describe("INTEGRATIONS", () => {
  it("has unique ids", () => {
    const ids = INTEGRATIONS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists Health Connect as the available push integration", () => {
    const hc = INTEGRATIONS.find((i) => i.id === "health-connect");
    expect(hc?.status).toBe("available");
    expect(hc?.kind).toBe("push");
  });
});

describe("getIntegration", () => {
  it("looks up a definition by id", () => {
    expect(getIntegration("health-connect")?.name).toBe(
      "Google Health Connect"
    );
    expect(getIntegration("strava")?.status).toBe("available");
    expect(getIntegration("strava")?.kind).toBe("oauth");
  });

  it("returns undefined for an unknown id", () => {
    // Cast through unknown since the arg is typed to known ids.
    expect(getIntegration("nope" as unknown as never)).toBeUndefined();
  });
});

// ── The ARCHIVE REFRESH facet (#2164) ────────────────────────────────────────
//
// The registry is DATA; this is its completeness guard, in the house style. It also
// pins the one deliberate looseness in the declaration: the two Fitbit vendor-score
// metric keys are written as LITERALS in registry.ts (keeping that file's imports
// type-only), so they are checked against the constants the parser actually writes.

describe("archiveRefresh — the #2164 declaration", () => {
  const declared = INTEGRATIONS.filter((i) => i.archiveRefresh != null);

  it("is declared only by archive providers, and by every one that needs it", () => {
    // Exemption is by OMISSION, so the set is small and deliberate: the Takeout
    // archive is the only provider with streams nothing else can deliver.
    expect(declared.map((i) => i.id)).toEqual(["fitbit-takeout"]);
    for (const def of declared) expect(def.kind).toBe("archive");
  });

  it("states a positive horizon, its evidence, and at least one stream", () => {
    for (const def of declared) {
      const facet = def.archiveRefresh!;
      expect(facet.horizonDays).toBeGreaterThan(0);
      // A number without a reason is how a threshold drifts (the #2146 discipline).
      expect(facet.because.length).toBeGreaterThan(40);
      // A provider with nothing exclusive omits the whole facet rather than
      // declaring an empty list.
      expect(facet.streams.length).toBeGreaterThan(0);
    }
  });

  it("gives every stream a unique id, a lowercase label and its own reason", () => {
    for (const def of declared) {
      const streams = def.archiveRefresh!.streams;
      expect(new Set(streams.map((s) => s.id)).size).toBe(streams.length);
      for (const s of streams) {
        expect(s.label).toBe(s.label.toLowerCase());
        expect(s.because.length).toBeGreaterThan(20);
      }
    }
  });

  it("pins the Fitbit score selectors against the constants the parser writes", () => {
    const streams = getIntegration("fitbit-takeout")!.archiveRefresh!.streams;
    const metricOf = (id: string) => {
      const sel = streams.find((s) => s.id === id)?.selector;
      return sel && sel.table === "metric_samples" ? sel.metric : null;
    };
    expect(metricOf("sleep-score")).toBe(FITBIT_SLEEP_SCORE_METRIC);
    expect(metricOf("readiness-score")).toBe(FITBIT_READINESS_SCORE_METRIC);
  });

  it("declares each provider's streams over readable stores only", () => {
    for (const def of declared) {
      for (const s of def.archiveRefresh!.streams) {
        // The union is closed, so this is really a runtime echo of the type — but it
        // is what makes a hand-edited registry entry fail here rather than at a query.
        expect(["body_metrics", "metric_samples"]).toContain(s.selector.table);
      }
    }
  });
});
