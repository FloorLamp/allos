import { describe, expect, it } from "vitest";
import {
  isPatientLabel,
  isPortalSlug,
  isSyncReportStatus,
  normalizePatientLabel,
  parseSyncReportCounts,
  parseUploadTarget,
  rejectsAddress,
  syncReportEvent,
  SYNC_REPORT_STATUSES,
} from "../acquirer-identity";

// PURE TIER (#1739/#1735). Three decisions an untrusted external tool can reach, plus the
// one security invariant the whole portal design rests on.

describe("portal slugs", () => {
  it("accepts lowercase kebab identifiers", () => {
    for (const s of ["ochsner", "my-chart", "epic2", "a"]) {
      expect(isPortalSlug(s), s).toBe(true);
    }
  });

  it("refuses anything a URL would need", () => {
    // The slug alphabet excludes every character an address requires, so a slug is
    // structurally incapable of being one.
    for (const s of [
      "ochsner.com",
      "https://ochsner",
      "ochsner/login",
      "ochsner:443",
      "user@ochsner",
      "Ochsner",
      "my chart",
      "trailing-",
      "-leading",
      "double--hyphen",
      "",
    ]) {
      expect(isPortalSlug(s), s).toBe(false);
    }
  });

  it("refuses an over-long slug", () => {
    expect(isPortalSlug("a".repeat(41))).toBe(false);
  });
});

describe("rejectsAddress — the never-store-a-URL invariant", () => {
  it("catches every shape of address", () => {
    for (const v of [
      "https://mychart.example.org",
      "http://10.0.0.1/login",
      "//mychart.example.org",
      "mailto:someone@example.org",
      "javascript:alert(1)",
      "mychart.example.org",
      "192.168.1.10",
      "user@host",
      "some/path",
      "  HTTPS://MyChart.Example.org/  ",
    ]) {
      expect(rejectsAddress(v), v).toBe(true);
    }
  });

  it("leaves ordinary display names alone", () => {
    for (const v of [
      "Ochsner MyChart",
      "St. Luke's",
      "Kaiser Permanente",
      "Dr. Smith's office",
      "",
      "Portal 2",
    ]) {
      expect(rejectsAddress(v), v).toBe(false);
    }
  });
});

describe("patient labels — a key, not a search", () => {
  it("strips only transport noise", () => {
    expect(normalizePatientLabel("  Jane Q. Doe  ")).toBe("Jane Q. Doe");
    // A label rendered across a line break must not become a second identity.
    expect(normalizePatientLabel("Jane\n  Q.\tDoe")).toBe("Jane Q. Doe");
  });

  it("does NOT case-fold or strip punctuation", () => {
    // Two labels that differ visibly are two different people until a human says
    // otherwise; unifying them is how one patient's records land under another.
    expect(normalizePatientLabel("JANE DOE")).not.toBe(
      normalizePatientLabel("Jane Doe")
    );
    expect(normalizePatientLabel("Jane Q. Doe")).not.toBe(
      normalizePatientLabel("Jane Q Doe")
    );
  });

  it("is idempotent, so a lookup always finds what a write stored", () => {
    const once = normalizePatientLabel("  Jane   Doe ");
    expect(normalizePatientLabel(once)).toBe(once);
  });

  it("validates non-empty and bounded", () => {
    expect(isPatientLabel("Jane Doe")).toBe(true);
    expect(isPatientLabel("   ")).toBe(false);
    expect(isPatientLabel("")).toBe(false);
    expect(isPatientLabel("x".repeat(121))).toBe(false);
  });
});

describe("parseUploadTarget — exactly one destination", () => {
  it("accepts the human CLI's profile form", () => {
    expect(parseUploadTarget({ profile: "2" })).toEqual({
      ok: true,
      target: { kind: "profile", profileId: 2 },
    });
  });

  it("accepts the acquirer's identity form, normalizing the label", () => {
    expect(
      parseUploadTarget({ portal: "ochsner", patient: "  Jane   Doe " })
    ).toEqual({
      ok: true,
      target: {
        kind: "identity",
        portalSlug: "ochsner",
        patientLabel: "Jane Doe",
      },
    });
  });

  it("refuses BOTH forms together rather than picking one", () => {
    // Preferring one would silently ignore the other destination the caller named.
    const r = parseUploadTarget({
      profile: "2",
      portal: "ochsner",
      patient: "Jane Doe",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("not both");
  });

  it("refuses neither form", () => {
    const r = parseUploadTarget({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("destination is required");
  });

  it("refuses a half identity", () => {
    expect(parseUploadTarget({ portal: "ochsner" }).ok).toBe(false);
    expect(parseUploadTarget({ patient: "Jane Doe" }).ok).toBe(false);
  });

  it("refuses a portal that is not a slug — including a URL", () => {
    expect(
      parseUploadTarget({ portal: "https://evil.example", patient: "Jane" }).ok
    ).toBe(false);
  });

  it("refuses profile-id spellings that would alias", () => {
    for (const p of ["007", "+2", "2e0", "0", "-1", "two"]) {
      expect(parseUploadTarget({ profile: p }).ok, p).toBe(false);
    }
  });

  it("treats whitespace-only fields as absent, not as a destination", () => {
    expect(parseUploadTarget({ profile: "   " }).ok).toBe(false);
  });
});

describe("sync report", () => {
  it("has exactly the three run outcomes", () => {
    expect([...SYNC_REPORT_STATUSES]).toEqual([
      "downloaded",
      "nothing-new",
      "failed",
    ]);
    expect(isSyncReportStatus("nothing-new")).toBe(true);
    expect(isSyncReportStatus("ok")).toBe(false);
    expect(isSyncReportStatus("")).toBe(false);
  });

  it("clamps untrusted counts", () => {
    expect(
      parseSyncReportCounts({
        inserted: -5,
        updated: "3",
        unchanged: 2.6,
        failed: "not a number",
      })
    ).toEqual({ inserted: 0, updated: 3, unchanged: 3, failed: 0 });
  });

  it("records nothing-new as a CALM SUCCESS", () => {
    // The common case. ok:true keeps the connection looking alive and keeps the Review
    // failure badge quiet — a quiet day must not read as broken.
    const ev = syncReportEvent(
      "nothing-new",
      { inserted: 0, updated: 0, unchanged: 4, failed: 0 },
      null
    );
    expect(ev.ok).toBe(true);
    expect(ev.error).toBeNull();
    expect(ev.unchanged).toBe(4);
    expect(ev.received).toBe(4);
  });

  it("records downloaded with its accounting", () => {
    const ev = syncReportEvent(
      "downloaded",
      { inserted: 2, updated: 1, unchanged: 3, failed: 0 },
      null
    );
    expect(ev.ok).toBe(true);
    expect(ev.received).toBe(6);
    expect(ev.inserted).toBe(2);
  });

  it("records failed as ok:false so the Review badge fires", () => {
    const ev = syncReportEvent(
      "failed",
      { inserted: 0, updated: 0, unchanged: 0, failed: 2 },
      "portal login timed out"
    );
    expect(ev.ok).toBe(false);
    expect(ev.error).toBe("portal login timed out");
    // A document the run could not push is `skipped` in the shared vocabulary.
    expect(ev.skipped).toBe(2);
    expect(ev.received).toBe(2);
  });

  it("never invents an error line, but always has one on failure", () => {
    expect(
      syncReportEvent(
        "downloaded",
        { inserted: 1, updated: 0, unchanged: 0, failed: 0 },
        "ignored"
      ).error
    ).toBeNull();
    expect(
      syncReportEvent(
        "failed",
        { inserted: 0, updated: 0, unchanged: 0, failed: 0 },
        null
      ).error
    ).toBe("sync failed");
  });
});
