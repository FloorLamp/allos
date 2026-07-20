// DB INTEGRATION TIER (not the pure unit suite) — issue #1045.
//
// The findings-builder backfill discipline (#448): the pure tier takes a pre-gathered
// `DataQualityInputs` snapshot and structurally can't see the GATHER. These tests seed a
// realistic SPARSE synthetic fixture (a child-shaped profile missing birthdate + a failed
// doc + a name-only medication) and assert the END-TO-END finding output of
// buildDataQualityFindings — the exact dedupeKeys, the coaching tier, and that the
// structurally-complete boundary emits nothing. A reflection guard asserts every emitted
// dedupeKey parses against the known-prefix registry.
//
// Runs via `npm run test:db` (vitest.db.config.ts); the `db` singleton is a throwaway
// per-file temp DB (lib/__db_tests__/setup.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  buildDataQualityFindings,
  collectDataQualityGaps,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import {
  setUserSex,
  setUserBirthdate,
  setSmokingHistory,
  setRiskAttributesReviewed,
} from "@/lib/settings";
import { dataQualityDedupeKey } from "@/lib/data-quality";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

function keysOf(profileId: number): string[] {
  return buildDataQualityFindings(profileId).map((f) => f.dedupeKey);
}

describe("buildDataQualityFindings — sparse fixture end-to-end (#1045)", () => {
  it("a profile missing birthdate/sex + a failed doc + a name-only med emits those exact gaps", () => {
    const { profileId } = makeProfile("dq-sparse");

    // A failed-extraction document (imported but contributing nothing).
    db.prepare(
      `INSERT INTO medical_documents
         (profile_id, filename, stored_path, mime_type, size_bytes,
          extraction_status, extraction_error, uploaded_at)
       VALUES (?, 'broken.txt', '', 'text/plain', 12,
               'failed', 'Unsupported file type.', '2026-01-01 00:00:00')`
    ).run(profileId);

    // An ACTIVE medication with NO confirmed RxCUI → name-only safety matching.
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed)
       VALUES (?, 'Mystery Pill', 1, 'medication', 'daily', 'high', 0)`
    ).run(profileId);

    const findings = buildDataQualityFindings(profileId);
    const keys = new Set(findings.map((f) => f.dedupeKey));

    // No birthdate → age unknown → the highest-leverage gap. No sex. A failed doc. A
    // name-only med. (Age unknown suppresses the adult-gated smoking/risk/phenoage
    // gaps, so those must NOT appear.)
    expect(keys.has(dataQualityDedupeKey("birthdate"))).toBe(true);
    expect(keys.has(dataQualityDedupeKey("sex"))).toBe(true);
    expect(keys.has(dataQualityDedupeKey("failed-extractions"))).toBe(true);
    expect(keys.has(dataQualityDedupeKey("med-rxcui"))).toBe(true);
    expect(keys.has(dataQualityDedupeKey("smoking-status"))).toBe(false);
    expect(keys.has(dataQualityDedupeKey("risk-attributes"))).toBe(false);

    // Every finding is calm coaching tier, guardable, and cites its consumer.
    for (const f of findings) {
      expect(f.tone).toBe("info");
      expect(f.domain).toBe("data-quality");
      expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
      expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
      expect(f.detail && f.detail.length).toBeTruthy();
      expect(f.actionHref).toBeTruthy();
    }

    // Leverage-ranked: birthdate (6) leads.
    expect(findings[0].dedupeKey).toBe(dataQualityDedupeKey("birthdate"));

    // Joins the coaching rollup (never a push/hero) — the #449 tier is real.
    const rolled = collectCoachingFindings(
      profileId,
      today(profileId),
      "kg"
    ).map((f) => f.dedupeKey);
    expect(rolled).toContain(dataQualityDedupeKey("birthdate"));
  });

  it("a pediatric profile with no height flags the pediatric-height gap", () => {
    const { profileId } = makeProfile("dq-child");
    setUserSex(profileId, "female");
    setUserBirthdate(profileId, "2020-01-01"); // ~a young child

    const keys = new Set(keysOf(profileId));
    expect(keys.has(dataQualityDedupeKey("pediatric-height"))).toBe(true);
    // Adult-only gaps never fire for a child.
    expect(keys.has(dataQualityDedupeKey("smoking-status"))).toBe(false);
    expect(keys.has(dataQualityDedupeKey("risk-attributes"))).toBe(false);

    // Add a height reading → the gap clears (structural, gone-for-good).
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'height_cm', '2026-01-01', '2026-01-01T00:00:00', '2026-01-01T00:00:00', 95)`
    ).run(profileId);
    expect(
      new Set(keysOf(profileId)).has(dataQualityDedupeKey("pediatric-height"))
    ).toBe(false);
  });

  it("BOUNDARY: a structurally-complete adult profile emits nothing", () => {
    const { profileId } = makeProfile("dq-complete");
    setUserSex(profileId, "male");
    setUserBirthdate(profileId, "1985-01-01"); // adult
    setSmokingHistory(profileId, {
      status: "never",
      packYears: null,
      quitYear: null,
    });
    setRiskAttributesReviewed(profileId, true);
    // No meds, no failed docs, no labs (phenoage present=0 → not nagged).

    expect(buildDataQualityFindings(profileId)).toEqual([]);
    expect(collectDataQualityGaps(profileId)).toEqual([]);
  });
});
