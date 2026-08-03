import { describe, it, expect } from "vitest";
import {
  EXTRACTION_STATES_ENDPOINT,
  IMPORT_JOB_STATES_ENDPOINT,
  isExtractionState,
  isImportJobState,
  readStatesEnvelope,
} from "@/lib/toaster-poll";

// How a chrome poller reads what it observed (issue #1878).
//
// The toasters used to call a Server Action, which handed them a typed value or
// threw. They now `fetch` a route handler, and that swap is the whole fix: an
// action's response carries a freshly rendered page tree the client applies, so
// polling one repainted the page underneath a half-typed record form with no
// `router.refresh()` anywhere — outside everything the dirty-form registry gates.
//
// The swap introduces one new way to be wrong, and it is the dangerous kind: a
// fetch can succeed at the HTTP level and still return something that is not the
// answer — a 401 envelope, a proxy error page, a login redirect followed to HTML.
// Reading any of those as "this profile has no jobs" would replace the toaster's
// seed with an empty map, and the NEXT successful poll would re-announce every
// already-finished job as freshly finished (#296). So every one of them is a
// typed refusal the caller retries, never an empty result set. That is what this
// file pins.

const jobs = [
  { id: 1, status: "processing", summary: null, error: null },
  { id: 2, status: "ready", summary: "3 workouts", error: null },
];

describe("readStatesEnvelope", () => {
  it("reads a well-formed envelope", () => {
    const observed = readStatesEnvelope(
      200,
      { ok: true, states: jobs },
      isImportJobState
    );
    expect(observed).toEqual({ ok: true, states: jobs });
  });

  it("accepts an empty set only when the server genuinely said so", () => {
    // The distinction that matters: an ANSWER of "no jobs" is fine and seeds an
    // empty map; a FAILURE that merely looks like one must not.
    expect(
      readStatesEnvelope(200, { ok: true, states: [] }, isImportJobState)
    ).toEqual({ ok: true, states: [] });
  });

  it("refuses any non-200 rather than reporting an empty set", () => {
    // 401 is the live case: the session lapsed while the tab sat open. The poll
    // must retry, not decide the profile's jobs all vanished.
    for (const status of [401, 403, 404, 429, 500, 502]) {
      expect(
        readStatesEnvelope(
          status,
          { ok: false, error: "auth" },
          isImportJobState
        )
      ).toEqual({ ok: false, reason: "http" });
    }
  });

  it("refuses a 200 that is not the envelope", () => {
    // A body that failed to parse as JSON at all arrives as undefined.
    for (const body of [
      undefined,
      null,
      "<!doctype html>",
      [],
      { ok: false, error: "auth" },
      { ok: true },
      { ok: true, states: "none" },
    ]) {
      expect(readStatesEnvelope(200, body, isImportJobState)).toEqual({
        ok: false,
        reason: "shape",
      });
    }
  });

  it("refuses a well-shaped envelope carrying a malformed row", () => {
    // One bad row poisons the whole diff (a missing `status` reads as a
    // transition), so the observation is refused wholesale rather than filtered.
    expect(
      readStatesEnvelope(
        200,
        { ok: true, states: [jobs[0], { id: 3 }] },
        isImportJobState
      )
    ).toEqual({ ok: false, reason: "shape" });
  });

  it("applies the caller's own row guard", () => {
    // The import rows are not extraction rows: the same envelope must not pass
    // for the other endpoint's shape.
    expect(
      readStatesEnvelope(200, { ok: true, states: jobs }, isExtractionState)
    ).toEqual({ ok: false, reason: "shape" });
  });
});

describe("row guards", () => {
  it("accepts the shapes the endpoints answer with", () => {
    expect(isImportJobState(jobs[0])).toBe(true);
    expect(
      isExtractionState({
        id: 7,
        filename: "labs.pdf",
        status: "done",
        count: 12,
        error: null,
      })
    ).toBe(true);
  });

  it("rejects rows missing a field the diff depends on", () => {
    expect(isImportJobState({ id: 1, summary: null, error: null })).toBe(false);
    expect(
      isImportJobState({ status: "ready", summary: null, error: null })
    ).toBe(false);
    expect(
      isExtractionState({
        id: 7,
        filename: "labs.pdf",
        status: "done",
        error: null,
      })
    ).toBe(false);
  });

  it("rejects a non-object", () => {
    for (const v of [null, undefined, 3, "ready", []]) {
      expect(isImportJobState(v)).toBe(false);
      expect(isExtractionState(v)).toBe(false);
    }
  });
});

describe("endpoints", () => {
  it("point at route handlers, never at an action", () => {
    // The load-bearing property: these are GET paths under /api, so the response
    // is JSON and cannot carry an RSC tree. A Server Action POSTs to the current
    // page URL, which is exactly how the repaint used to arrive.
    expect(IMPORT_JOB_STATES_ENDPOINT).toBe("/api/jobs/imports");
    expect(EXTRACTION_STATES_ENDPOINT).toBe("/api/jobs/extractions");
  });
});
