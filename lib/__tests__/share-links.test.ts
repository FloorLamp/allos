import { describe, expect, it } from "vitest";
import {
  normalizeShareFields,
  serializeShareFields,
  parseShareFields,
  isFieldInScope,
  shareLinkStatus,
  isShareLinkValid,
  ttlMsForKey,
  expiresAtFor,
} from "../share-links";
import { hashShareToken } from "../share-token";

describe("normalizeShareFields", () => {
  it("keeps only known keys, dedupes, and imposes canonical order", () => {
    // Submitted out of order with a dupe and an unknown key.
    expect(
      normalizeShareFields([
        "history",
        "blood_type",
        "bogus",
        "blood_type",
        "identity",
      ])
    ).toEqual(["identity", "blood_type", "history"]);
  });

  it("drops non-string / empty input", () => {
    expect(normalizeShareFields([1, null, undefined, ""])).toEqual([]);
  });
});

describe("serialize/parse round-trip", () => {
  it("round-trips a valid selection", () => {
    const s = serializeShareFields(["vitals", "medications"]);
    expect(parseShareFields(s)).toEqual(["vitals", "medications"]);
  });

  it("parse tolerates null, garbage, and non-arrays without throwing", () => {
    expect(parseShareFields(null)).toEqual([]);
    expect(parseShareFields("not json")).toEqual([]);
    expect(parseShareFields('{"a":1}')).toEqual([]);
    expect(parseShareFields('["identity","nope"]')).toEqual(["identity"]);
  });
});

describe("isFieldInScope", () => {
  it("gates a field against the allow-list", () => {
    const fields = parseShareFields('["blood_type","medications"]');
    expect(isFieldInScope(fields, "blood_type")).toBe(true);
    expect(isFieldInScope(fields, "history")).toBe(false);
  });

  // family_history is its OWN scope, distinct from the subject's conditions —
  // relatives' diagnoses are third-party PHI. A conditions-only link must NOT
  // expose family history (and, since existing links carry no family_history key,
  // they correctly stop exposing it).
  it("keeps family_history independent of conditions", () => {
    const conditionsOnly = parseShareFields('["conditions"]');
    expect(isFieldInScope(conditionsOnly, "conditions")).toBe(true);
    expect(isFieldInScope(conditionsOnly, "family_history")).toBe(false);

    const familyOnly = parseShareFields('["family_history"]');
    expect(isFieldInScope(familyOnly, "family_history")).toBe(true);
    expect(isFieldInScope(familyOnly, "conditions")).toBe(false);
  });

  it("normalize/round-trips the family_history field in canonical order", () => {
    // Submitted after body; canonical order puts family_history before body.
    expect(normalizeShareFields(["body", "family_history"])).toEqual([
      "family_history",
      "body",
    ]);
    expect(parseShareFields(serializeShareFields(["family_history"]))).toEqual([
      "family_history",
    ]);
  });
});

describe("hashShareToken", () => {
  it("is a deterministic 64-hex SHA-256, and never the raw token", () => {
    const h = hashShareToken("abc123");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashShareToken("abc123"));
    expect(h).not.toBe("abc123");
    expect(hashShareToken("abc124")).not.toBe(h);
  });
});

describe("shareLinkStatus", () => {
  const now = new Date("2026-07-06T12:00:00Z");

  it("is valid before expiry when not revoked", () => {
    expect(
      shareLinkStatus(
        { expires_at: "2026-07-06T13:00:00Z", revoked_at: null },
        now
      )
    ).toBe("valid");
    expect(
      isShareLinkValid(
        { expires_at: "2026-07-06T13:00:00Z", revoked_at: null },
        now
      )
    ).toBe(true);
  });

  it("is expired once past expires_at", () => {
    expect(
      shareLinkStatus(
        { expires_at: "2026-07-06T11:00:00Z", revoked_at: null },
        now
      )
    ).toBe("expired");
  });

  it("revocation wins even when also expired", () => {
    expect(
      shareLinkStatus(
        {
          expires_at: "2026-07-06T11:00:00Z",
          revoked_at: "2026-07-06T10:00:00Z",
        },
        now
      )
    ).toBe("revoked");
  });

  it("fails closed on an unparseable expiry", () => {
    expect(
      shareLinkStatus({ expires_at: "garbage", revoked_at: null }, now)
    ).toBe("expired");
  });
});

describe("TTL helpers", () => {
  it("resolves known keys and defaults an unknown key to 7 days", () => {
    expect(ttlMsForKey("1h")).toBe(60 * 60 * 1000);
    expect(ttlMsForKey("30d")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(ttlMsForKey("bogus")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(ttlMsForKey(null)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("expiresAtFor returns now + ttl as ISO", () => {
    const now = new Date("2026-07-06T12:00:00Z");
    expect(expiresAtFor("1h", now)).toBe("2026-07-06T13:00:00.000Z");
  });
});
