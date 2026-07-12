import { describe, expect, it } from "vitest";
import {
  COMPARABLE_METRICS,
  SOURCE_COLORS,
  SOURCE_FALLBACK_COLOR,
  DOCUMENT_SERIES_COLORS,
  documentSourceId,
  documentSourceLabel,
  sourceSeriesColorMap,
  isComparableMetricKey,
  isValidSourceId,
  parseMetricSourcePriority,
  serializeMetricSourcePriority,
  sourceColor,
  sourceKey,
  sourcePreference,
  withMetricSource,
} from "@/lib/metric-source-priority";
import { PROVIDER_PREFERENCE } from "@/lib/metric-providers";

describe("parseMetricSourcePriority", () => {
  it("round-trips a valid map", () => {
    const map = { resting_hr: "oura", sleep_min: "health-connect" };
    expect(
      parseMetricSourcePriority(serializeMetricSourcePriority(map))
    ).toEqual(map);
  });

  it("returns {} for unset / malformed blobs", () => {
    expect(parseMetricSourcePriority(undefined)).toEqual({});
    expect(parseMetricSourcePriority(null)).toEqual({});
    expect(parseMetricSourcePriority("")).toEqual({});
    expect(parseMetricSourcePriority("not json")).toEqual({});
    expect(parseMetricSourcePriority("[1,2]")).toEqual({});
    expect(parseMetricSourcePriority('"oura"')).toEqual({});
  });

  it("drops entries whose source is not a valid source id", () => {
    expect(
      parseMetricSourcePriority(
        JSON.stringify({
          steps: "oura",
          weight: 42,
          hrv_ms: "NOT VALID!!",
          resting_hr: { a: 1 },
        })
      )
    ).toEqual({ steps: "oura" });
  });
});

describe("isValidSourceId", () => {
  it("accepts integration ids, manual, and document provenance", () => {
    for (const s of [
      "health-connect",
      "oura",
      "strava",
      "manual",
      "document:12",
    ]) {
      expect(isValidSourceId(s), s).toBe(true);
    }
  });

  it("rejects empty, oversized, and shady values", () => {
    expect(isValidSourceId("")).toBe(false);
    expect(isValidSourceId("-leading-dash")).toBe(false);
    expect(isValidSourceId("has space")).toBe(false);
    expect(isValidSourceId("x".repeat(65))).toBe(false);
    expect(isValidSourceId('{"json":1}')).toBe(false);
  });
});

describe("withMetricSource", () => {
  it("sets, replaces, and clears one metric without touching the rest", () => {
    let map = withMetricSource({}, "steps", "oura");
    expect(map).toEqual({ steps: "oura" });
    map = withMetricSource(map, "resting_hr", "health-connect");
    map = withMetricSource(map, "steps", "strava");
    expect(map).toEqual({ steps: "strava", resting_hr: "health-connect" });
    map = withMetricSource(map, "steps", null);
    expect(map).toEqual({ resting_hr: "health-connect" });
    // "" clears like null (form posts send empty strings).
    expect(withMetricSource({ steps: "oura" }, "steps", "")).toEqual({});
  });
});

describe("sourcePreference", () => {
  it("puts the chosen source first, then the defaults, deduped", () => {
    expect(
      sourcePreference("steps", { steps: "oura" }, [
        "manual",
        "health-connect",
        "oura",
      ])
    ).toEqual(["oura", "manual", "health-connect"]);
  });

  it("is the plain default list when unset (single-source passthrough)", () => {
    expect(sourcePreference("steps", {}, PROVIDER_PREFERENCE)).toEqual(
      PROVIDER_PREFERENCE
    );
  });
});

describe("sourceKey", () => {
  it("folds NULL / '' / 'manual' onto manual, passes everything else through", () => {
    expect(sourceKey(null)).toBe("manual");
    expect(sourceKey(undefined)).toBe("manual");
    expect(sourceKey("")).toBe("manual");
    expect(sourceKey("manual")).toBe("manual");
    expect(sourceKey("oura")).toBe("oura");
    expect(sourceKey("document:3")).toBe("document:3");
  });
});

describe("comparable metric allowlist + source colors", () => {
  it("knows the comparable keys and rejects arbitrary ones", () => {
    expect(isComparableMetricKey("resting_hr")).toBe(true);
    expect(isComparableMetricKey("sleep_min")).toBe(true);
    expect(isComparableMetricKey("totally_made_up")).toBe(false);
  });

  it("every comparable metric has a unique key", () => {
    const keys = COMPARABLE_METRICS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("color follows the source entity, with one fallback for unknowns", () => {
    expect(sourceColor("oura")).toBe(SOURCE_COLORS.oura);
    expect(sourceColor(null)).toBe(SOURCE_COLORS.manual); // NULL = manual
    expect(sourceColor("document:9")).toBe(SOURCE_FALLBACK_COLOR);
  });

  it("every default-preference source has a fixed color assigned", () => {
    for (const source of PROVIDER_PREFERENCE) {
      expect(SOURCE_COLORS[source], source).toBeTruthy();
    }
  });
});

describe("documentSourceId", () => {
  it("parses a document provenance to its id, else null", () => {
    expect(documentSourceId("document:7")).toBe(7);
    expect(documentSourceId("document:42")).toBe(42);
    expect(documentSourceId("manual")).toBeNull();
    expect(documentSourceId("oura")).toBeNull();
    expect(documentSourceId("document:")).toBeNull();
    expect(documentSourceId("document:0")).toBeNull();
    expect(documentSourceId("document:x")).toBeNull();
  });
});

describe("documentSourceLabel (issue #533)", () => {
  const docs = {
    5: { filename: "quest-labs.pdf", document_date: "2025-01-08" },
    7: { filename: null, document_date: "2025-03-01" },
    9: { filename: null, document_date: null },
  };

  it("prefers filename, then document date, then #id", () => {
    expect(documentSourceLabel("document:5", docs)).toBe("quest-labs.pdf");
    expect(documentSourceLabel("document:7", docs)).toBe(
      "Document (2025-03-01)"
    );
    expect(documentSourceLabel("document:9", docs)).toBe("Document #9");
    // A doc not in the lookup still gets a distinguishing #id label.
    expect(documentSourceLabel("document:11", docs)).toBe("Document #11");
  });

  it("gives two documents DISTINCT labels (no longer both 'Document')", () => {
    const a = documentSourceLabel("document:5", docs);
    const b = documentSourceLabel("document:7", docs);
    expect(a).not.toBe(b);
  });
});

describe("sourceSeriesColorMap (issue #533)", () => {
  it("keeps fixed brand colors for known sources", () => {
    const map = sourceSeriesColorMap(["manual", "oura", "health-connect"]);
    expect(map.get("oura")).toBe(SOURCE_COLORS.oura);
    expect(map.get("manual")).toBe(SOURCE_COLORS.manual);
    expect(map.get("health-connect")).toBe(SOURCE_COLORS["health-connect"]);
  });

  it("gives two document keys distinct colors from the document palette", () => {
    const map = sourceSeriesColorMap(["document:5", "document:7"]);
    const c5 = map.get("document:5");
    const c7 = map.get("document:7");
    expect(c5).not.toBe(c7);
    expect(DOCUMENT_SERIES_COLORS).toContain(c5);
    expect(DOCUMENT_SERIES_COLORS).toContain(c7);
    // Never the single fallback teal that used to collapse them.
    expect(c5).not.toBe(SOURCE_FALLBACK_COLOR);
    expect(c7).not.toBe(SOURCE_FALLBACK_COLOR);
  });

  it("is stable per key regardless of the order/other keys present", () => {
    const a = sourceSeriesColorMap(["document:5", "document:7", "oura"]);
    const b = sourceSeriesColorMap(["oura", "document:7", "document:5"]);
    expect(a.get("document:5")).toBe(b.get("document:5"));
    expect(a.get("document:7")).toBe(b.get("document:7"));
  });
});
