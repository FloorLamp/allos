import { describe, expect, it } from "vitest";
import {
  defaultLogSegment,
  logSheetSegments,
  LOG_SEGMENT_CENSUS,
} from "@/lib/log-sheet";
import { QUICK_LOG_IDS, quickLogMenu } from "@/lib/quick-log";

// The "Everything else" section is a VIEW over the quick-log registry, not a
// second membership list. These tests pin exactly that: nothing is added,
// nothing is dropped, and both existing gates still decide.

describe("LOG_SEGMENT_CENSUS", () => {
  it("assigns every quick-log id to a segment", () => {
    for (const id of QUICK_LOG_IDS) {
      expect(LOG_SEGMENT_CENSUS[id]).toBeTruthy();
    }
  });
});

describe("logSheetSegments", () => {
  it("carries exactly the entries quickLogMenu carries, once each", () => {
    for (const [restricted, cycle] of [
      [false, true],
      [false, false],
      [true, true],
      [true, false],
    ] as const) {
      const flat = quickLogMenu(restricted, cycle).map((i) => i.id);
      const grouped = logSheetSegments(restricted, cycle).flatMap((s) =>
        s.items.map((i) => i.id)
      );
      expect([...grouped].sort()).toEqual([...flat].sort());
      expect(new Set(grouped).size).toBe(grouped.length);
    }
  });

  it("drops a segment with no surviving entry rather than disabling it", () => {
    // Training is the whole of the `train` segment, and an age-restricted profile
    // has no training surface at all.
    expect(logSheetSegments(false, true).map((s) => s.id)).toContain("train");
    expect(logSheetSegments(true, true).map((s) => s.id)).not.toContain(
      "train"
    );
    for (const segment of logSheetSegments(true, false)) {
      expect(segment.items.length).toBeGreaterThan(0);
    }
  });

  it("keeps the Body segment when the cycle bit is off", () => {
    // The period entry is cycle-gated; measurements is not, so the segment
    // survives with one fewer row.
    const body = logSheetSegments(false, false).find((s) => s.id === "body");
    expect(body?.items.map((i) => i.id)).toEqual(["log-measurements"]);
  });

  it("orders the track Train · Food · Body · Care", () => {
    expect(logSheetSegments(false, true).map((s) => s.id)).toEqual([
      "train",
      "food",
      "body",
      "care",
    ]);
  });
});

describe("defaultLogSegment", () => {
  const all = logSheetSegments(false, true);

  it("opens on the segment holding the route's promoted log", () => {
    expect(defaultLogSegment(all, "/nutrition", null)).toBe("food");
    expect(defaultLogSegment(all, "/medications", null)).toBe("care");
    // /trends' default tab promotes measurements, which lives in Body.
    expect(defaultLogSegment(all, "/trends", null)).toBe("body");
  });

  it("falls back to Train, the activity fallback's segment, on an opinionless route", () => {
    expect(defaultLogSegment(all, "/settings", null)).toBe("train");
  });

  it("never names a segment that is not on the track", () => {
    const restricted = logSheetSegments(true, true);
    // The route promotes Log activity, whose segment was dropped for this
    // profile — so the answer must be a surviving segment, not `train`.
    const chosen = defaultLogSegment(restricted, "/settings", null);
    expect(restricted.map((s) => s.id)).toContain(chosen);
    expect(chosen).not.toBe("train");
  });
});
