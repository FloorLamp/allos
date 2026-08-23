import { describe, expect, it } from "vitest";
import {
  parseJsonPreservingIds,
  quoteUnsafeIntegerIds,
} from "@/lib/integrations/json-big-ids";
import { mapWithingsMeasureGroup } from "@/lib/integrations/withings";
import { mapOuraWorkout } from "@/lib/integrations/oura";

// THE #3593 AUDIT, AS ASSERTIONS.
//
// #3194 established that an upstream int64 id passes through a JS number and loses
// its low digits — silently, with no throw and no parse error — so two upstream rows
// collapse onto one stored external id. It fixed STRAVA only, at `stravaGet`. This
// file is the finding for the two providers that were never looked at, kept as
// executable assertions rather than a paragraph, because "we checked once" is the
// claim that goes stale.
//
// WITHINGS — DEFECTIVE, AND FIXED HERE.
//   `measuregrps[].grpid` is the one id-bearing field that reaches storage
//   (`external_id` = `withings:<grpid>:<analyte>`, ./withings.ts). Withings' own API
//   reference declares it `type: integer, format: int64` — so the CONTRACT permits a
//   value past 2^53 and no measurement of today's magnitudes (their published
//   example is 5586822735, ten digits) can rule one out. It is therefore routed
//   through json-big-ids like Strava's, which needed two coordinated changes: the
//   key list had to learn the `grpid` spelling (the `<word>_id` half never reached
//   it), and the mapper had to stop reading it with a number-only reader, which
//   would have turned every big-id group into a SKIP.
//
// OURA — SOUND AS IT STANDS, so `ouraGet` keeps its plain `res.json()`.
//   Every id-shaped field in Oura's published v2 schema
//   (cloud.ouraring.com/v2/static/json/openapi-1.37.json, 75 schemas, checked
//   2026-08-23) is `"type": "string"` — 19 of them, including PublicWorkout.id,
//   PublicDailySleep.id and PublicDailyReadiness.id. There is no integer id to
//   round. The SECOND half of that verdict is structural and is what the test below
//   pins: the only Oura id this app stores goes through a string-only reader, so a
//   numeric id could never become a rounded external id even if the schema changed —
//   the record would be rejected and counted skipped, loudly, in the tally.

// Two Withings measure-group ids at int64 magnitude, 100 apart. At ~5.6×10^18 the
// spacing between adjacent doubles is 1024, so 100 apart is INSIDE one step and an
// ordinary parse collapses them onto one value — which is the whole defect. Written
// out in full because a fixture with realistic ten-digit grpids cannot exhibit it,
// and would go green forever while proving nothing.
const GRPID_A = "5586822735000123456";
const GRPID_B = "5586822735000123556";
const COLLAPSED = "5586822735000123000";

function measureGroup(grpidJson: string): string {
  return `{"grpid":${grpidJson},"date":1717530817,"timezone":"UTC","category":1,"measures":[{"value":70500,"unit":-3,"type":1},{"value":120,"unit":0,"type":10},{"value":80,"unit":0,"type":9}]}`;
}

describe("the defect these Withings ids exist to prove", () => {
  it("an ordinary JSON.parse loses the low digits of an int64 grpid", () => {
    const parsed = JSON.parse(measureGroup(GRPID_A)) as { grpid: number };
    expect(String(parsed.grpid)).not.toBe(GRPID_A);
    expect(String(parsed.grpid)).toBe(COLLAPSED);
  });

  it("and collapses two DISTINCT grpids onto one external id", () => {
    // Two separate weigh-ins become one stored row: the second overwrites the first
    // on UNIQUE(profile_id, source, external_id), or the write throws. Either way a
    // reading is lost with nothing said about it.
    const ids = [GRPID_A, GRPID_B].map((g) => {
      const rec = JSON.parse(measureGroup(g)) as Record<string, unknown>;
      return mapWithingsMeasureGroup(rec, "UTC")?.vitals[0]?.external_id;
    });
    expect(GRPID_A).not.toBe(GRPID_B);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(`withings:${COLLAPSED}:Blood Pressure Systolic`);
  });
});

describe("the Withings fetch boundary, parsed the way withingsPost parses it", () => {
  it("quotes an int64 grpid, which the `<word>_id` pattern alone never reached", () => {
    expect(quoteUnsafeIntegerIds(`{"grpid":${GRPID_A}}`)).toBe(
      `{"grpid":"${GRPID_A}"}`
    );
  });

  it("leaves a real-magnitude grpid a plain number", () => {
    // Withings' own documented example. The gate is precision, not key name: an id
    // a double holds exactly is not restrung, so today's payloads parse exactly as
    // they always did.
    const text = `{"grpid":5586822735,"model_id":51,"id":12345}`;
    expect(quoteUnsafeIntegerIds(text)).toBe(text);
  });

  it("keeps two near-neighbour grpids distinct, all the way to the external id", () => {
    const ids = [GRPID_A, GRPID_B].map((g) => {
      const rec = parseJsonPreservingIds(measureGroup(g)) as Record<
        string,
        unknown
      >;
      return mapWithingsMeasureGroup(rec, "UTC")?.vitals[0]?.external_id;
    });
    expect(ids).toEqual([
      `withings:${GRPID_A}:Blood Pressure Systolic`,
      `withings:${GRPID_B}:Blood Pressure Systolic`,
    ]);
  });

  it("still maps the group's readings — a quoted grpid is not a skip", () => {
    // The failure this mapper change exists to prevent: a number-only `grpid` read
    // returns null for a quoted id and the WHOLE group is dropped, which is worse
    // than the collision it was meant to fix.
    const rec = parseJsonPreservingIds(measureGroup(GRPID_A)) as Record<
      string,
      unknown
    >;
    const mapped = mapWithingsMeasureGroup(rec, "UTC");
    expect(mapped).not.toBeNull();
    expect(mapped?.bodyMetric?.weight_kg).toBe(70.5);
    expect(mapped?.vitals.map((v) => v.canonical).sort()).toEqual([
      "Blood Pressure Diastolic",
      "Blood Pressure Systolic",
    ]);
  });

  it("rejects a group with no usable grpid, as it always did", () => {
    const rec = JSON.parse(
      `{"date":1717530817,"timezone":"UTC","measures":[{"value":70500,"unit":-3,"type":1}]}`
    ) as Record<string, unknown>;
    expect(mapWithingsMeasureGroup(rec, "UTC")).toBeNull();
  });
});

describe("Oura's boundary needs no rewrite, and this is why", () => {
  const workout = (id: unknown) => ({
    id,
    day: "2024-05-02",
    activity: "running",
    start_datetime: "2024-05-02T07:00:00-07:00",
    end_datetime: "2024-05-02T07:45:00-07:00",
  });

  it("stores a long string id verbatim — there is nothing to round", () => {
    // Oura's schema says every id is a string; a UUID is what one actually looks
    // like, and a string never meets a double at all.
    const mapped = mapOuraWorkout(
      workout("8f9a5221-639e-4a85-81cb-4065ef23f979")
    );
    expect(mapped?.activity.external_id).toBe(
      "oura:8f9a5221-639e-4a85-81cb-4065ef23f979"
    );
  });

  it("REJECTS a numeric id rather than storing a rounded one", () => {
    // The structural half of the audit. If Oura ever contradicted its own schema and
    // sent an integer id past 2^53, this mapper's string-only read makes the record
    // a counted SKIP — visible in the run's tally — instead of a silently rounded
    // external id colliding with its neighbour. That is why a plain `res.json()` is
    // safe here in a way it was not at `withingsPost`, where the reader took numbers.
    expect(mapOuraWorkout(workout(3502836819860123456))).toBeNull();
    expect(mapOuraWorkout(workout(12345))).toBeNull();
  });
});
