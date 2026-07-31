import { describe, expect, it } from "vitest";
import {
  isAccountSlug,
  isPatientLabel,
  isPortalSlug,
  isSyncReportStatus,
  mintSlug,
  normalizePatientLabel,
  parseDiscoveredLabels,
  parseSyncReportCounts,
  parseUploadTarget,
  rejectsAddress,
  syncReportEvent,
  DISCOVERED_LABELS_MAX,
  PORTAL_SLUG_MAX,
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
        // Null, not "default": which login an omitted account means is a fact about
        // stored rows, so only the DB layer may answer it — and it refuses rather than
        // picking when the portal has more than one.
        accountSlug: null,
        patientLabel: "Jane Doe",
      },
    });
  });

  it("carries the optional account through when the tool names one", () => {
    expect(
      parseUploadTarget({
        portal: "ochsner",
        account: "mom",
        patient: "SMITH, ALEX",
      })
    ).toEqual({
      ok: true,
      target: {
        kind: "identity",
        portalSlug: "ochsner",
        accountSlug: "mom",
        patientLabel: "SMITH, ALEX",
      },
    });
  });

  it("REFUSES a malformed account rather than ignoring it", () => {
    // Silently dropping a named login would land the run under a different one.
    const r = parseUploadTarget({
      portal: "ochsner",
      account: "Not A Slug",
      patient: "Jane Doe",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("`account`");
  });

  it("treats an account alone as an identity attempt, not as an absent destination", () => {
    // Otherwise a tool that sent only `account` would get "a destination is required",
    // which is true but unhelpfully far from the real mistake.
    const r = parseUploadTarget({ account: "mom" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("`portal`");
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

describe("mintSlug — allos owns the key, the user owns the name", () => {
  it("derives a stable kebab slug from a display name", () => {
    expect(mintSlug("Ochsner MyChart")).toBe("ochsner-mychart");
    expect(mintSlug("Baptist Health — Downtown")).toBe(
      "baptist-health-downtown"
    );
    expect(mintSlug("Mom")).toBe("mom");
  });

  it("folds accents to their base letters rather than dropping them", () => {
    expect(mintSlug("Hôpital Général")).toBe("hopital-general");
  });

  it("produces only valid slugs, or nothing at all", () => {
    for (const name of [
      "Ochsner MyChart",
      "  spaced  out  ",
      "Dad's login!",
      "123",
      "A".repeat(200),
    ]) {
      const slug = mintSlug(name);
      expect(isPortalSlug(slug), `${name} → ${slug}`).toBe(true);
      expect(isAccountSlug(slug)).toBe(true);
    }
    // No slug-able characters at all → empty, and the caller refuses rather than
    // inventing a key.
    expect(mintSlug("•••")).toBe("");
    expect(mintSlug("   ")).toBe("");
  });

  it("truncates long names on a hyphen boundary, never leaving a trailing separator", () => {
    const slug = mintSlug(
      "Really Very Extremely Long Health System Name That Goes On"
    );
    expect(slug.length).toBeLessThanOrEqual(PORTAL_SLUG_MAX);
    expect(slug.endsWith("-")).toBe(false);
    expect(isPortalSlug(slug)).toBe(true);
  });

  it("is deterministic — the same name always mints the same slug", () => {
    expect(mintSlug("Ochsner MyChart")).toBe(mintSlug("Ochsner MyChart"));
  });

  it("collapses two different names onto one slug, leaving disambiguation to the DB", () => {
    // A pure function cannot know what already exists, so it does not pretend to.
    expect(mintSlug("Baptist Health")).toBe(mintSlug("baptist   health"));
  });
});

describe("parseDiscoveredLabels — an untrusted proxy list", () => {
  it("keeps labels verbatim, only normalizing whitespace", () => {
    expect(parseDiscoveredLabels(["  SMITH,   ALEX ", "Ruth O'Hara"])).toEqual([
      "SMITH, ALEX",
      "Ruth O'Hara",
    ]);
  });

  it("never case-folds — a label is a key, not a search", () => {
    expect(parseDiscoveredLabels(["Jane Doe", "JANE DOE"])).toEqual([
      "Jane Doe",
      "JANE DOE",
    ]);
  });

  it("drops non-strings and empties rather than erroring the whole report", () => {
    // A run that genuinely happened must still be recorded even if one label was junk.
    expect(
      parseDiscoveredLabels(["Real Person", 42, null, "", "   ", {}])
    ).toEqual(["Real Person"]);
  });

  it("collapses exact duplicates", () => {
    expect(parseDiscoveredLabels(["A B", "A  B", "A B"])).toEqual(["A B"]);
  });

  it("is BOUNDED, so one authenticated report cannot fill the pending list", () => {
    const many = Array.from({ length: 500 }, (_, i) => `Patient ${i}`);
    expect(parseDiscoveredLabels(many)).toHaveLength(DISCOVERED_LABELS_MAX);
  });

  it("treats a non-array as no list at all", () => {
    expect(parseDiscoveredLabels(undefined)).toEqual([]);
    expect(parseDiscoveredLabels("Jane Doe")).toEqual([]);
    expect(parseDiscoveredLabels({ 0: "Jane Doe" })).toEqual([]);
  });
});
