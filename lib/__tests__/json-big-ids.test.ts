import { describe, expect, it } from "vitest";
import {
  idSurvivesJsNumber,
  parseJsonPreservingIds,
  quoteUnsafeIntegerIds,
} from "@/lib/integrations/json-big-ids";
import { mapStravaActivityArtifacts } from "@/lib/integrations/strava";

// Two REAL-MAGNITUDE Strava effort ids (~3.5×10^18). They are 100 apart, which is
// inside the 512 spacing of doubles at that magnitude — so an ordinary JSON.parse
// collapses them onto ONE value, which is both the wrong id and the UNIQUE
// violation that killed the prod backfill. A fixture with small ids cannot exhibit
// either, which is why these are written out in full.
const EFFORT_A = "3502836819860123456";
const EFFORT_B = "3502836819860123556";
const LAP_ID = "1810452937100055123";

describe("the defect these ids exist to prove", () => {
  it("an ordinary JSON.parse loses the low digits of a real Strava effort id", () => {
    const parsed = JSON.parse(`{"id":${EFFORT_A}}`) as { id: number };
    expect(String(parsed.id)).not.toBe(EFFORT_A);
    expect(String(parsed.id)).toBe("3502836819860123600");
  });

  it("and collapses two DISTINCT ids in one payload onto one string", () => {
    const a = JSON.parse(`{"id":${EFFORT_A}}`) as { id: number };
    const b = JSON.parse(`{"id":${EFFORT_B}}`) as { id: number };
    expect(EFFORT_A).not.toBe(EFFORT_B);
    expect(String(a.id)).toBe(String(b.id));
  });
});

describe("idSurvivesJsNumber", () => {
  it("is false for an id past 2^53 whose digits a double cannot hold", () => {
    expect(idSurvivesJsNumber(EFFORT_A)).toBe(false);
    expect(idSurvivesJsNumber(LAP_ID)).toBe(false);
  });

  it("is EXACT at 2^53, in both directions", () => {
    // The boundary itself is exactly representable, so it is left alone; its
    // odd neighbours on either side are not, so they are quoted. A gate that was
    // off by one here would either mangle a real id or restring a faithful one.
    expect(idSurvivesJsNumber("9007199254740992")).toBe(true);
    expect(idSurvivesJsNumber("-9007199254740992")).toBe(true);
    expect(idSurvivesJsNumber("9007199254740993")).toBe(false);
    expect(idSurvivesJsNumber("-9007199254740993")).toBe(false);
    expect(quoteUnsafeIntegerIds(`{"id":9007199254740992}`)).toBe(
      `{"id":9007199254740992}`
    );
    expect(quoteUnsafeIntegerIds(`{"id":9007199254740993}`)).toBe(
      `{"id":"9007199254740993"}`
    );
  });

  it("is true for the ids this app already stores faithfully", () => {
    // A Strava activity id (~1.5×10^10) and a segment id (~10^7): both exact.
    expect(idSurvivesJsNumber("15308821234")).toBe(true);
    expect(idSurvivesJsNumber("7654321")).toBe(true);
    // 16 digits, and still exact — the gate is precision, not digit count.
    expect(idSurvivesJsNumber("3502836819860123")).toBe(true);
  });
});

describe("quoteUnsafeIntegerIds", () => {
  it("quotes an unsafe id and leaves a safe one a number", () => {
    const text = `{"id":${EFFORT_A},"segment":{"id":7654321}}`;
    expect(quoteUnsafeIntegerIds(text)).toBe(
      `{"id":"${EFFORT_A}","segment":{"id":7654321}}`
    );
  });

  it("covers *_id keys too, so the stored raw payload is faithful as well", () => {
    const text = `{"activity_id":${EFFORT_A},"start_index":12}`;
    expect(quoteUnsafeIntegerIds(text)).toBe(
      `{"activity_id":"${EFFORT_A}","start_index":12}`
    );
  });

  it("stays QUIET on the neighbours an over-eager pass would take", () => {
    // Not id-shaped keys; not integers; not in key position. Each of these is a
    // real shape in a Strava payload and each must come through byte-identical.
    const benign = [
      `{"moving_time":3600,"distance":20000.5}`,
      `{"average_watts":2.8e2}`,
      `{"id":"b12345678"}`,
      `{"name":"ride 3502836819860123456"}`,
      `{"latlng":[38.5,-120.2]}`,
      `{"upload_id_str":"3502836819860123456"}`,
    ];
    for (const text of benign) expect(quoteUnsafeIntegerIds(text)).toBe(text);
  });

  it("handles whitespace and newlines between key and value", () => {
    const text = `{\n  "id" : ${EFFORT_A}\n}`;
    expect(JSON.parse(quoteUnsafeIntegerIds(text))).toEqual({ id: EFFORT_A });
  });
});

describe("parseJsonPreservingIds", () => {
  it("hands the mapper the exact digit string for an int64 id", () => {
    const parsed = parseJsonPreservingIds(
      `{"segment_efforts":[{"id":${EFFORT_A}}]}`
    ) as { segment_efforts: { id: unknown }[] };
    expect(parsed.segment_efforts[0].id).toBe(EFFORT_A);
  });

  it("keeps two near-neighbour effort ids DISTINCT", () => {
    const parsed = parseJsonPreservingIds(
      `{"segment_efforts":[{"id":${EFFORT_A}},{"id":${EFFORT_B}}]}`
    ) as { segment_efforts: { id: unknown }[] };
    expect(parsed.segment_efforts.map((e) => e.id)).toEqual([
      EFFORT_A,
      EFFORT_B,
    ]);
  });

  it("leaves an id-shaped key INSIDE a string value completely alone", () => {
    // This test used to be called "falls back to the plain parse when the rewrite
    // would not parse", and it never reached the fallback. JSON escapes every `"`
    // inside a string, so the `[{,]\\s*"` anchor cannot match there: the rewrite
    // makes no change at all and the plain-parse branch runs. Asserting that is
    // the honest version of what this input proves.
    const text = `{"name":"a ride called {\\"lap_id\\": ${EFFORT_A}}","id":9}`;
    expect(quoteUnsafeIntegerIds(text)).toBe(text);
    expect((parseJsonPreservingIds(text) as { id: number }).id).toBe(9);
  });

  it("reports a broken body's SyntaxError against the ORIGINAL offsets", () => {
    // The fallback's real (and only) effect, and the reason to keep it. A
    // truncated response IS rewritten — the id is past 2^53 — and the rewritten
    // text does not parse either, so the fallback fires and re-parses the
    // original. The two texts differ in length by the two quotes it inserted, so
    // the error's position differs too: 26 here, 28 from the rewrite.
    const truncated = `{"id":${EFFORT_A},`;
    expect(quoteUnsafeIntegerIds(truncated)).not.toBe(truncated);
    expect(() => parseJsonPreservingIds(truncated)).toThrow(/position 26\b/);
    expect(() => JSON.parse(quoteUnsafeIntegerIds(truncated))).toThrow(
      /position 28\b/
    );
  });

  it("still throws on genuinely malformed JSON", () => {
    expect(() => parseJsonPreservingIds("{not json")).toThrow();
  });

  it("turns ONE invalid payload into a value: a leading-zero id", () => {
    // Recorded, not fixed. JSON forbids leading zeros, so no compliant serializer
    // (Strava's included) can emit this and it is unreachable in practice — but it
    // is the single input where this pass is not outcome-preserving, and the next
    // reader should meet it here rather than discover it.
    const text = `{"id":00${EFFORT_A}}`;
    expect(() => JSON.parse(text)).toThrow();
    expect(parseJsonPreservingIds(text)).toEqual({ id: `00${EFFORT_A}` });
  });
});

describe("mapStravaActivityArtifacts over an id-preserving parse", () => {
  it("stores the exact digit string for effort and lap ids past 2^53", () => {
    const detail = parseJsonPreservingIds(
      JSON.stringify({
        laps: [{ id: "__LAP__", lap_index: 1, name: "Lap 1" }],
        segment_efforts: [
          { id: "__A__", name: "Climb", segment: { id: 7654321 } },
          { id: "__B__", name: "Climb again", segment: { id: 7654321 } },
        ],
      })
        .replace('"__LAP__"', LAP_ID)
        .replace('"__A__"', EFFORT_A)
        .replace('"__B__"', EFFORT_B)
    );
    const artifacts = mapStravaActivityArtifacts(
      "15308821234",
      detail,
      null,
      null,
      null,
      "2026-08-23T12:00:00.000Z"
    );
    expect(artifacts.laps[0].lap_external_id).toBe(LAP_ID);
    expect(artifacts.segmentEfforts.map((e) => e.effort_external_id)).toEqual([
      EFFORT_A,
      EFFORT_B,
    ]);
    // The segment id is small and stays exactly what it always was.
    expect(artifacts.segmentEfforts[0].segment_id).toBe("7654321");
  });

  it("leaves the synthetic fallback alone when an id is absent", () => {
    const artifacts = mapStravaActivityArtifacts(
      "15308821234",
      { laps: [{ lap_index: 1 }], segment_efforts: [{ name: "No id" }] },
      null,
      null,
      null,
      "2026-08-23T12:00:00.000Z"
    );
    expect(artifacts.laps[0].lap_external_id).toBe("15308821234:lap:1");
    expect(artifacts.segmentEfforts[0].effort_external_id).toBe(
      "15308821234:segment:1"
    );
  });
});
