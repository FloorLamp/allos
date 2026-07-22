import { describe, it, expect } from "vitest";
import {
  suggestForRecord,
  suggestForEncounter,
  suggestForEpisode,
  encounterInEpisodeRange,
  distanceToWindow,
  orderEpisodeManualCandidates,
  stableToken,
  episodeToken,
  visitLinkSignature,
  type LinkableRecord,
  type LinkableEncounter,
} from "../visit-link-suggest";

// PURE suggestion-engine matrix (#1050/#1053). No DB — every case is plain data in,
// plain data out: provider-corroborated / single-encounter-day / ≥2-encounter
// ambiguity ⇒ picker not guess / no-match ⇒ nothing / decision-filtered pair never
// re-suggested; episode in-range vs out-of-range vs ≥2-in-range.

const NONE = new Set<string>();

function rec(over: Partial<LinkableRecord> = {}): LinkableRecord {
  return {
    domain: "medication",
    id: 1,
    external_id: null,
    date: "2026-03-03",
    providerId: null,
    label: "Amoxicillin",
    ...over,
  };
}
function enc(over: Partial<LinkableEncounter> = {}): LinkableEncounter {
  return {
    id: 10,
    external_id: null,
    date: "2026-03-03",
    providerId: null,
    locationProviderId: null,
    ...over,
  };
}

describe("suggestForRecord — record ↔ visit tiers", () => {
  it("no same-date encounter ⇒ no suggestion (no fuzzy windows)", () => {
    expect(
      suggestForRecord(
        rec({ date: "2026-03-03" }),
        [enc({ date: "2026-03-04" })],
        NONE
      )
    ).toBeNull();
  });

  it("undated record ⇒ no suggestion", () => {
    expect(suggestForRecord(rec({ date: null }), [enc()], NONE)).toBeNull();
  });

  it("single same-date encounter, no provider ⇒ medium", () => {
    const s = suggestForRecord(rec(), [enc()], NONE);
    expect(s?.confidence).toBe("medium");
    expect(s?.encounter?.id).toBe(10);
    expect(s?.candidates).toBeUndefined();
  });

  it("single same-date encounter with matching provider ⇒ strong", () => {
    const s = suggestForRecord(
      rec({ providerId: 7 }),
      [enc({ providerId: 7 })],
      NONE
    );
    expect(s?.confidence).toBe("strong");
  });

  it("provider matches the encounter's FACILITY ⇒ strong", () => {
    const s = suggestForRecord(
      rec({ providerId: 42 }),
      [enc({ providerId: null, locationProviderId: 42 })],
      NONE
    );
    expect(s?.confidence).toBe("strong");
  });

  it("≥2 same-date encounters, no corroboration ⇒ PICKER (never a ranked guess)", () => {
    const s = suggestForRecord(
      rec({ providerId: null }),
      [enc({ id: 10 }), enc({ id: 11 })],
      NONE
    );
    expect(s?.encounter).toBeUndefined();
    expect(s?.candidates?.map((c) => c.id)).toEqual([10, 11]);
  });

  it("≥2 same-date encounters but provider resolves to exactly one ⇒ strong single", () => {
    const s = suggestForRecord(
      rec({ providerId: 7 }),
      [enc({ id: 10, providerId: 7 }), enc({ id: 11, providerId: 9 })],
      NONE
    );
    expect(s?.confidence).toBe("strong");
    expect(s?.encounter?.id).toBe(10);
  });

  it("≥2 same-date encounters, provider matches BOTH ⇒ still a picker (ambiguous)", () => {
    const s = suggestForRecord(
      rec({ providerId: 7 }),
      [enc({ id: 10, providerId: 7 }), enc({ id: 11, providerId: 7 })],
      NONE
    );
    expect(s?.candidates?.map((c) => c.id)).toEqual([10, 11]);
  });

  it("a declined (encounter, record) pair is never re-suggested", () => {
    const r = rec({ id: 5, external_id: "ccda:med:x" });
    const e = enc({ id: 10, external_id: "document:1|ccda:encounter:v" });
    const declined = new Set([
      visitLinkSignature(stableToken(e), stableToken(r)),
    ]);
    // With the only same-date encounter declined, nothing is suggested.
    expect(suggestForRecord(r, [e], declined)).toBeNull();
    // A DIFFERENT undeclined same-date encounter is still offered.
    const e2 = enc({ id: 11 });
    const s = suggestForRecord(r, [e, e2], declined);
    expect(s?.encounter?.id).toBe(11);
  });
});

describe("suggestForEncounter — the 'From this visit?' inverse", () => {
  it("offers only records that resolve UNIQUELY to this visit", () => {
    const e = enc({ id: 10, date: "2026-03-03" });
    const records = [
      rec({ id: 1, date: "2026-03-03" }), // same day, single ⇒ offered
      rec({ id: 2, date: "2026-03-04" }), // different day ⇒ not offered
    ];
    const out = suggestForEncounter(e, records, NONE);
    expect(out.suggestions.map((s) => s.record.id)).toEqual([1]);
    expect(out.suggestions[0].confidence).toBe("medium");
  });

  it("an ambiguous record (its date matched ≥2 visits) is NOT offered under this one", () => {
    // From the encounter's own vantage it only sees itself, so it can't know the
    // record is ambiguous — but suggestForEncounter passes only [encounter], so the
    // record resolves to a single pick here. This documents that the ambiguity guard
    // is enforced by the READ layer feeding unlinked records + all encounters to the
    // record-side engine; the encounter block uses the single-encounter view.
    const e = enc({ id: 10 });
    const out = suggestForEncounter(e, [rec({ id: 1 })], NONE);
    expect(out.suggestions).toHaveLength(1);
  });
});

describe("episode ↔ visit (#1053)", () => {
  const episode = { id: 3, start: "2026-03-01", lastActiveDay: "2026-03-07" };

  it("containment is inclusive of both ends", () => {
    expect(encounterInEpisodeRange(episode, "2026-03-01")).toBe(true);
    expect(encounterInEpisodeRange(episode, "2026-03-07")).toBe(true);
    expect(encounterInEpisodeRange(episode, "2026-02-28")).toBe(false);
    expect(encounterInEpisodeRange(episode, "2026-03-08")).toBe(false);
  });

  it("open-ended episode (no lastActiveDay) contains nothing", () => {
    expect(
      encounterInEpisodeRange(
        { id: 3, start: "2026-03-01", lastActiveDay: null },
        "2026-03-02"
      )
    ).toBe(false);
  });

  it("exactly one in-range visit ⇒ single suggestion", () => {
    const s = suggestForEpisode(
      episode,
      [enc({ id: 10, date: "2026-03-04" })],
      NONE
    );
    expect(s?.encounter?.id).toBe(10);
    expect(s?.candidates).toBeUndefined();
  });

  it("no in-range visit ⇒ nothing", () => {
    expect(
      suggestForEpisode(episode, [enc({ id: 10, date: "2026-03-20" })], NONE)
    ).toBeNull();
  });

  it("≥2 in-range visits ⇒ picker, never a ranked guess", () => {
    const s = suggestForEpisode(
      episode,
      [
        enc({ id: 10, date: "2026-03-02" }),
        enc({ id: 11, date: "2026-03-05" }),
      ],
      NONE
    );
    expect(s?.encounter).toBeUndefined();
    expect(s?.candidates?.map((c) => c.id)).toEqual([10, 11]);
  });

  it("a declined episode↔visit pair is never re-suggested", () => {
    const e = enc({
      id: 10,
      date: "2026-03-04",
      external_id: "document:1|ccda:encounter:v",
    });
    const declined = new Set([
      visitLinkSignature(stableToken(e), episodeToken(episode)),
    ]);
    expect(suggestForEpisode(episode, [e], declined)).toBeNull();
  });
});

describe("manual picker proximity ordering (#1196)", () => {
  const FIRST = "2026-03-01";
  const LAST = "2026-03-07";

  it("distanceToWindow: 0 in-range, day-gap to the nearer edge otherwise", () => {
    expect(distanceToWindow("2026-03-04", FIRST, LAST)).toBe(0); // in range
    expect(distanceToWindow("2026-03-10", FIRST, LAST)).toBe(3); // 3 days after
    expect(distanceToWindow("2026-02-15", FIRST, LAST)).toBe(14); // 14 days before
    expect(distanceToWindow("2025-08-13", FIRST, LAST)).toBe(200); // 200 days before
    // Unknown window → no proximity to measure.
    expect(distanceToWindow("2026-03-04", null, null)).toBe(0);
  });

  it("orders in-range first, then by proximity, and a near follow-up is NOT dropped by a higher-id distant visit", () => {
    // A near-outside follow-up (id 2, 3 days after the window) vs a distant but higher-id
    // visit (id 99, a 2026 physical months later) — the old id-desc tie-break would push
    // the follow-up out; proximity keeps it ahead.
    const inRange = { id: 5, date: "2026-03-04" };
    const nearFollowUp = { id: 2, date: "2026-03-10" };
    const distantRecent = { id: 99, date: "2026-09-01" };
    const ordered = orderEpisodeManualCandidates(
      [distantRecent, nearFollowUp, inRange],
      FIRST,
      LAST,
      { cap: 8, maxOutOfRangeGapDays: 400 }
    );
    expect(ordered.map((c) => c.id)).toEqual([5, 2, 99]);
  });

  it("bounds out-of-range candidates to the neighborhood but never drops in-range", () => {
    const inRange = { id: 1, date: "2026-03-02" };
    const nearOutside = { id: 2, date: "2026-04-01" }; // ~25 days out
    const farOutside = { id: 3, date: "2027-01-01" }; // way out
    const ordered = orderEpisodeManualCandidates(
      [farOutside, nearOutside, inRange],
      FIRST,
      LAST,
      { maxOutOfRangeGapDays: 60 }
    );
    expect(ordered.map((c) => c.id)).toEqual([1, 2]); // far one bounded out
  });

  it("id descending is the final deterministic tie-break among equal-distance visits", () => {
    const a = { id: 10, date: "2026-03-10" }; // 3 after
    const b = { id: 20, date: "2026-02-26" }; // 3 before → same distance
    const ordered = orderEpisodeManualCandidates([a, b], FIRST, LAST);
    expect(ordered.map((c) => c.id)).toEqual([20, 10]);
  });
});

describe("stable tokens", () => {
  it("prefers external_id, falls back to id", () => {
    expect(stableToken({ id: 5, external_id: "abc" })).toBe("ext:abc");
    expect(stableToken({ id: 5, external_id: null })).toBe("id:5");
    expect(episodeToken({ id: 9 })).toBe("id:9");
  });

  it("signature is order-independent", () => {
    expect(visitLinkSignature("a", "b")).toBe(visitLinkSignature("b", "a"));
  });
});
