// PURE UNIT TIER — the status-keyed sync-failure vocabulary (#3618).
//
// What a person met when a sync broke was an HTTP path, an HTTP status, or a vendor
// error number: "Oura /v2/usercollection/sleep request failed (401)", "Withings
// /measure request failed (601)", "weather fetch failed (503)". This module is the
// authored-copy sibling of lib/user-error-copy.ts's caught-text translation, and
// these cases pin the two things that make it a vocabulary rather than a rename: the
// split is keyed on what the status MEANS, and the sentences are the SAME bank the
// caught-text side spends.
//
// The reconnect line's own guarantee — that it appears exactly where the connection
// was flipped to needs_reauth — cannot be asserted here, because it is a property of
// the runner reading recorded state. It is pinned in
// lib/__db_tests__/connection-reauth.test.ts, over both doors into that state.

import { describe, it, expect } from "vitest";
import {
  reconnectCopy,
  syncFailureCopy,
  syncFailureFamily,
} from "@/lib/integrations/sync-failure-copy";
import { userErrorCopy } from "@/lib/user-error-copy";

const OURA = { doing: "sync your Oura data", service: "Oura" } as const;

describe("the split is keyed on what the status means", () => {
  it("groups a 5xx with a request that never got an answer at all", () => {
    // Status 0 is every pull source's "the request THREW". To a reader that and a
    // 503 are one thing, which is why they get one sentence.
    expect(syncFailureFamily(0)).toBe("upstream");
    expect(syncFailureFamily(500)).toBe("upstream");
    expect(syncFailureFamily(503)).toBe("upstream");
  });

  it("calls a 4xx refused — the same split #3007 reads for its retry advice", () => {
    expect(syncFailureFamily(400)).toBe("refused");
    expect(syncFailureFamily(403)).toBe("refused");
    expect(syncFailureFamily(404)).toBe("refused");
    expect(syncFailureFamily(422)).toBe("refused");
  });

  it('calls "not now" upstream, because asking again is exactly what fixes it', () => {
    // THE TWO CODES WHERE "is it a 4xx?" AND "will asking again help?" PART COMPANY.
    // Reading them off the 4xx boundary put a rate limit in the family whose stated
    // contract is "nothing for a person to do" — the opposite of what it means, and
    // the next hourly tick clears it unaided.
    expect(syncFailureFamily(429)).toBe("upstream");
    expect(syncFailureFamily(408)).toBe("upstream");
    // …and the sentence follows the family, so the advice is offered.
    expect(syncFailureCopy(429, OURA)).toBe("Couldn't reach Oura. Try again.");
    expect(syncFailureCopy(408, OURA)).toBe("Couldn't reach Oura. Try again.");
    // Their 4xx neighbours are untouched — this is two codes, not a boundary move.
    expect(syncFailureFamily(428)).toBe("refused");
    expect(syncFailureFamily(430)).toBe("refused");
    expect(syncFailureFamily(407)).toBe("refused");
    expect(syncFailureFamily(409)).toBe("refused");
  });

  it("is true in Withings' envelope dialect too, not only in HTTP", () => {
    // Withings rides its own codes over HTTP 200. 2555 is documented as "an unknown
    // error occurred, try again", which is what `upstream` says; 247 is a bad
    // request parameter, which is what `refused` says.
    expect(syncFailureFamily(2555)).toBe("upstream");
    expect(syncFailureFamily(247)).toBe("refused");
  });

  it("treats an unreadable envelope as no answer, not as a refusal", () => {
    // Withings' -1 is "the body carried no numeric status at all" — a gateway's HTML
    // page where the JSON should be. Nobody refused us anything and a retry is the
    // right advice, so it groups with the status-0 throw rather than landing in the
    // family that offers none.
    expect(syncFailureFamily(-1)).toBe("upstream");
    expect(syncFailureCopy(-1, { doing: "sync your Withings data" })).toContain(
      "Try again"
    );
  });
});

// The one claim in the module that a single dialect could not support (#3618 review).
describe("a vendor code that rode an HTTP 200 never says we couldn't reach anyone", () => {
  const WITHINGS = {
    doing: "sync your Withings data",
    service: "Withings",
  } as const;

  it("drops the service name for a vendor code, and keeps the retry advice", () => {
    // 2554/2555/2556 are Withings' "unknown error, try again" family. They are >= 500
    // so the family is right — but they arrive INSIDE a 200 response, so "Couldn't
    // reach Withings." is false on its face: we reached them and they answered.
    for (const code of [2554, 2555, 2556]) {
      const line = syncFailureCopy(code, WITHINGS, "vendor");
      expect(line, `code ${code}`).toBe(
        "Couldn't sync your Withings data. Try again."
      );
      expect(line, `code ${code}`).not.toContain("reach");
    }
    // Same for the unreadable envelope.
    expect(syncFailureCopy(-1, WITHINGS, "vendor")).toBe(
      "Couldn't sync your Withings data. Try again."
    );
  });

  it("still names them when the status really was an HTTP one", () => {
    // A Withings 503 IS a failure to reach them, and the dialect travels with the
    // status (withings-sync.ts's WGet) so this half keeps the sentence that names
    // the third party.
    expect(syncFailureCopy(503, WITHINGS, "http")).toBe(
      "Couldn't reach Withings. Try again."
    );
    expect(syncFailureCopy(503, WITHINGS)).toBe(
      "Couldn't reach Withings. Try again."
    );
  });

  it("needs no dialect care on the refused side — it names nobody either way", () => {
    expect(syncFailureCopy(247, WITHINGS, "vendor")).toBe(
      syncFailureCopy(247, WITHINGS, "http")
    );
  });
});

describe("the sentences", () => {
  it("names the third party a 5xx came from, and offers the retry that can work", () => {
    expect(syncFailureCopy(503, OURA)).toBe("Couldn't reach Oura. Try again.");
  });

  it("offers NO retry on a refused request — it will be refused again", () => {
    expect(syncFailureCopy(404, OURA)).toBe("Couldn't sync your Oura data.");
    expect(syncFailureCopy(404, OURA)).not.toContain("Try again");
  });

  it("falls back to the verb phrase when no third party is named", () => {
    expect(
      syncFailureCopy(503, { doing: "refresh the weather forecast" })
    ).toBe("Couldn't refresh the weather forecast. Try again.");
  });

  it("spends the SAME sentence a thrown network error already earned (#3592)", () => {
    // THE POINT OF SHARING THE BANK. A 503 answered by Oura and an ECONNRESET while
    // reaching Oura are one event to a reader, and they arrive on the card through
    // two different modules. If these ever diverge, one of them was edited alone.
    const thrown = new Error("fetch failed");
    expect(syncFailureCopy(503, OURA)).toBe(userErrorCopy(thrown, OURA));
    expect(syncFailureCopy(0, OURA)).toBe(userErrorCopy(thrown, OURA));
  });

  it("never renders a status, a path or a vendor code, at any status", () => {
    // The whole class, swept rather than sampled: every status any of the four
    // sources can hand this, including Withings' envelope dialect.
    const statuses = [
      -1, 0, 100, 247, 286, 400, 401, 403, 404, 408, 422, 429, 500, 502, 503,
      504, 601, 2555,
    ];
    for (const status of statuses) {
      const line = syncFailureCopy(status, OURA);
      expect(line, `status ${status}`).not.toMatch(/\d/);
      expect(line, `status ${status}`).not.toContain("/");
    }
  });
});

describe("the reconnect line", () => {
  it("states the state and one next step, and the step is on screen beside it", () => {
    // The second sentence is lib/attention.ts's own fallback for a broken
    // integration, reused rather than re-minted. The step matches the affordance
    // `needs_reauth` renders — "Reconnect <name> →" in ConnectedSources, and the
    // reconnect notice on the source's own page.
    expect(reconnectCopy("Oura Ring")).toBe(
      "Your Oura Ring connection expired. Reconnect to resume syncing."
    );
    expect(reconnectCopy("Oura Ring")).not.toMatch(/\d/);
  });
});
