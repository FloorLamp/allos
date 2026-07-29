import { describe, expect, it } from "vitest";
import {
  COMPARABLE_METRICS,
  DOCUMENTS_SOURCE_CLASS,
  hasDocumentSeries,
  isSourceClassId,
  resolveMetricSources,
  sourceGroupKey,
  sourceMatchesSelector,
  withDocumentsClassSeries,
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
import { BODY_METRIC_META } from "@/lib/trends-body-metrics";

describe("parseMetricSourcePriority", () => {
  it("round-trips a valid map", () => {
    const map = {
      resting_hr: { source: "oura", strict: false },
      sleep_min: { source: "health-connect", strict: false },
    };
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
    ).toEqual({ steps: { source: "oura", strict: false } });
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
    expect(map).toEqual({ steps: { source: "oura", strict: false } });
    map = withMetricSource(map, "resting_hr", "health-connect");
    map = withMetricSource(map, "steps", "strava");
    expect(map).toEqual({
      steps: { source: "strava", strict: false },
      resting_hr: { source: "health-connect", strict: false },
    });
    map = withMetricSource(map, "steps", null);
    expect(map).toEqual({
      resting_hr: { source: "health-connect", strict: false },
    });
    // "" clears like null (form posts send empty strings).
    expect(
      withMetricSource(
        { steps: { source: "oura", strict: false } },
        "steps",
        ""
      )
    ).toEqual({});
  });
});

describe("sourcePreference", () => {
  it("puts the chosen source first, then the defaults, deduped", () => {
    expect(
      sourcePreference("steps", { steps: { source: "oura", strict: false } }, [
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

  it("ranks fitbit-takeout below health-connect, and LISTS it at all", () => {
    // Listed: pickOneProviderPerDay falls back to "largest single-source total"
    // for an unlisted provider, which for sleep would systematically pick the
    // archive purely because it reports a longer session than the live push.
    expect(PROVIDER_PREFERENCE).toContain("fitbit-takeout");
    // Below health-connect: importing an archive must never silently rewrite days
    // the live stream already covered. Preferring the archive is a deliberate
    // per-profile choice, not a default.
    expect(PROVIDER_PREFERENCE.indexOf("fitbit-takeout")).toBeGreaterThan(
      PROVIDER_PREFERENCE.indexOf("health-connect")
    );
  });

  it("lets a profile deliberately prefer the archive over the live push", () => {
    expect(
      sourcePreference(
        "sleep_min",
        { sleep_min: { source: "fitbit-takeout", strict: false } },
        PROVIDER_PREFERENCE
      )[0]
    ).toBe("fitbit-takeout");
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

  it("capitalizes every word in comparable metric titles", () => {
    for (const metric of COMPARABLE_METRICS) {
      for (const word of metric.title.split(/\s+/)) {
        const firstLetter = word.match(/[A-Za-z]/)?.[0];
        if (firstLetter) {
          expect(firstLetter, `${metric.key}: ${metric.title}`).toBe(
            firstLetter.toUpperCase()
          );
        }
      }
    }
  });

  it("uses the Body registry for body and vital display metadata", () => {
    const expected = {
      weight: BODY_METRIC_META.weight,
      body_fat: BODY_METRIC_META["body-fat"],
      resting_hr: BODY_METRIC_META["resting-hr"],
      steps: BODY_METRIC_META.steps,
      active_kcal: BODY_METRIC_META["active-calories"],
      hrv_ms: BODY_METRIC_META.hrv,
      heart_rate: BODY_METRIC_META.hr,
    };

    for (const [key, meta] of Object.entries(expected)) {
      const metric = COMPARABLE_METRICS.find(
        (candidate) => candidate.key === key
      );
      expect(metric?.title, key).toBe(meta.title);
      expect(metric?.decimals, key).toBe(meta.decimals);
    }
  });

  it("color follows the source entity, with one fallback for unknowns", () => {
    expect(sourceColor("oura")).toBe(SOURCE_COLORS.oura);
    expect(sourceColor(null)).toBe(SOURCE_COLORS.manual); // NULL = manual
    expect(sourceColor("document:9")).toBe(SOURCE_FALLBACK_COLOR);
  });

  it("gives fitbit-takeout its OWN color, not the unknown fallback", () => {
    // It is routinely plotted AGAINST health-connect on the compare-sources
    // overlay (both describe the same nights), so sharing the generic fallback
    // would make two first-class providers indistinguishable there.
    expect(sourceColor("fitbit-takeout")).toBe(SOURCE_COLORS["fitbit-takeout"]);
    expect(sourceColor("fitbit-takeout")).not.toBe(SOURCE_FALLBACK_COLOR);
    const used = Object.values(SOURCE_COLORS);
    expect(new Set(used).size, "every source color is distinct").toBe(
      used.length
    );
    expect(used).not.toContain(SOURCE_FALLBACK_COLOR);
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

// ── The documents source CLASS (issue #1640) ────────────────────────────────────

describe("sourceMatchesSelector (issue #1640)", () => {
  it("matches a concrete source only by its own key", () => {
    expect(sourceMatchesSelector("oura", "oura")).toBe(true);
    expect(sourceMatchesSelector("oura", "health-connect")).toBe(false);
    expect(sourceMatchesSelector("manual", null)).toBe(true); // NULL folds to manual
    expect(sourceMatchesSelector("document:5", "document:5")).toBe(true);
    expect(sourceMatchesSelector("document:5", "document:7")).toBe(false);
  });

  it("the class matches EVERY document provenance and nothing else", () => {
    expect(sourceMatchesSelector(DOCUMENTS_SOURCE_CLASS, "document:5")).toBe(
      true
    );
    expect(sourceMatchesSelector(DOCUMENTS_SOURCE_CLASS, "document:71")).toBe(
      true
    );
    expect(sourceMatchesSelector(DOCUMENTS_SOURCE_CLASS, "oura")).toBe(false);
    expect(sourceMatchesSelector(DOCUMENTS_SOURCE_CLASS, null)).toBe(false);
    // Not a document id, so not a member — the class can't be spoofed by shape.
    expect(sourceMatchesSelector(DOCUMENTS_SOURCE_CLASS, "document:x")).toBe(
      false
    );
  });

  it("isValidSourceId accepts the class id (it is a storable pick)", () => {
    expect(isValidSourceId(DOCUMENTS_SOURCE_CLASS)).toBe(true);
    expect(isSourceClassId(DOCUMENTS_SOURCE_CLASS)).toBe(true);
    expect(isSourceClassId("document:5")).toBe(false);
    expect(isSourceClassId("oura")).toBe(false);
  });
});

describe("sourceGroupKey (issue #1640)", () => {
  const withClass = [DOCUMENTS_SOURCE_CLASS, ...PROVIDER_PREFERENCE];

  it("collapses every document onto the class when the class is in play", () => {
    expect(sourceGroupKey("document:5", withClass)).toBe(
      DOCUMENTS_SOURCE_CLASS
    );
    expect(sourceGroupKey("document:7", withClass)).toBe(
      DOCUMENTS_SOURCE_CLASS
    );
    // Non-members keep their own identity.
    expect(sourceGroupKey("oura", withClass)).toBe("oura");
    expect(sourceGroupKey(null, withClass)).toBe("manual");
  });

  it("keeps two documents DISTINCT when no class is selected (#533 intact)", () => {
    expect(sourceGroupKey("document:5", PROVIDER_PREFERENCE)).toBe(
      "document:5"
    );
    expect(sourceGroupKey("document:7", PROVIDER_PREFERENCE)).toBe(
      "document:7"
    );
    // And when ONE document is the explicit pick, the sibling stays separate.
    const onePicked = ["document:5", ...PROVIDER_PREFERENCE];
    expect(sourceGroupKey("document:7", onePicked)).toBe("document:7");
  });
});

describe("withDocumentsClassSeries / hasDocumentSeries (issue #1640)", () => {
  const manual = { source: "manual", data: [{ date: "2026-03-01", value: 20 }] };
  const docA = {
    source: "document:5",
    data: [{ date: "2026-01-10", value: 21.4 }],
  };
  const docB = {
    source: "document:7",
    data: [{ date: "2026-02-10", value: 19.8 }],
  };

  it("adds ONE aggregate spanning every document, members intact", () => {
    const out = withDocumentsClassSeries([manual, docA, docB]);
    expect(out.map((s) => s.source)).toEqual([
      "manual",
      DOCUMENTS_SOURCE_CLASS, // the aggregate leads its family
      "document:5",
      "document:7",
    ]);
    const aggregate = out.find((s) => s.source === DOCUMENTS_SOURCE_CLASS)!;
    expect(aggregate.data).toEqual([
      { date: "2026-01-10", value: 21.4 },
      { date: "2026-02-10", value: 19.8 },
    ]);
    // The per-document series are untouched (#533 must not regress).
    expect(out.find((s) => s.source === "document:5")!.data).toEqual(docA.data);
  });

  it("averages two documents that report the SAME day", () => {
    const sameDayA = {
      source: "document:5",
      data: [{ date: "2026-01-10", value: 20 }],
    };
    const sameDayB = {
      source: "document:7",
      data: [{ date: "2026-01-10", value: 24 }],
    };
    const out = withDocumentsClassSeries([sameDayA, sameDayB]);
    expect(out.find((s) => s.source === DOCUMENTS_SOURCE_CLASS)!.data).toEqual([
      { date: "2026-01-10", value: 22 },
    ]);
  });

  it("adds no aggregate for zero or one document, but still OFFERS the class at one", () => {
    expect(withDocumentsClassSeries([manual, docA]).map((s) => s.source)).toEqual(
      ["manual", "document:5"]
    );
    expect(withDocumentsClassSeries([manual]).map((s) => s.source)).toEqual([
      "manual",
    ]);
    // The picker gate is separate: one report is already worth electing the class,
    // because the NEXT report is a new document id the class covers for free.
    expect(hasDocumentSeries([manual, docA])).toBe(true);
    expect(hasDocumentSeries([manual])).toBe(false);
  });
});

// ── Strict "only this source" mode (issue #1642) ────────────────────────────────

describe("parse/serialize across BOTH value shapes (issue #1642)", () => {
  it("reads a bare string as PREFERENCE mode (every stored blob keeps working)", () => {
    expect(parseMetricSourcePriority('{"weight":"withings"}')).toEqual({
      weight: { source: "withings", strict: false },
    });
  });

  it("reads the object form and round-trips strict", () => {
    const strict = { weight: { source: DOCUMENTS_SOURCE_CLASS, strict: true } };
    const blob = serializeMetricSourcePriority(strict);
    expect(JSON.parse(blob)).toEqual({
      weight: { source: "documents", strict: true },
    });
    expect(parseMetricSourcePriority(blob)).toEqual(strict);
  });

  it("writes the BARE STRING for preference mode (no gratuitous blob churn)", () => {
    expect(
      serializeMetricSourcePriority({
        weight: { source: "withings", strict: false },
      })
    ).toBe('{"weight":"withings"}');
  });

  it("drops object entries with no valid source, and non-true strict is preference", () => {
    expect(
      parseMetricSourcePriority(
        JSON.stringify({
          a: { strict: true },
          b: { source: "NOT VALID!!", strict: true },
          c: { source: "oura", strict: "yes" },
          d: { source: "oura", strict: true },
        })
      )
    ).toEqual({
      c: { source: "oura", strict: false },
      d: { source: "oura", strict: true },
    });
  });

  it("withMetricSource carries the mode, and clearing drops it", () => {
    const map = withMetricSource({}, "weight", "documents", true);
    expect(map).toEqual({ weight: { source: "documents", strict: true } });
    expect(withMetricSource(map, "weight", "documents")).toEqual({
      weight: { source: "documents", strict: false },
    });
    expect(withMetricSource(map, "weight", null)).toEqual({});
  });
});

describe("resolveMetricSources (issue #1642)", () => {
  it("preference mode is the chosen source then the defaults", () => {
    expect(
      resolveMetricSources(
        "weight",
        { weight: { source: "documents", strict: false } },
        PROVIDER_PREFERENCE
      )
    ).toEqual({
      order: ["documents", ...PROVIDER_PREFERENCE],
      strict: false,
    });
  });

  it("strict mode is that selector ALONE — nothing else may answer", () => {
    expect(
      resolveMetricSources(
        "weight",
        { weight: { source: "documents", strict: true } },
        PROVIDER_PREFERENCE
      )
    ).toEqual({ order: ["documents"], strict: true });
  });

  it("unset is the plain default list in preference mode (today's behavior)", () => {
    expect(resolveMetricSources("weight", {}, PROVIDER_PREFERENCE)).toEqual({
      order: [...PROVIDER_PREFERENCE],
      strict: false,
    });
  });
});
