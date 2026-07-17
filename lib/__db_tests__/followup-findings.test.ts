// DB INTEGRATION TIER (issue #700 — the #448 builder-fixture rule).
//
// followUpItems GATHERS DB state (linked, open follow-up care_plan_items + the
// imaging studies that are their sources and resolving candidates) and hands it to
// the pure chain core + imaging adapter, so it carries a DB-tier fixture asserting
// the END-TO-END finding output — the pure tier can't see the SQL gather (the
// source_kind filter, the source/candidate joins, the resolution close). Pins the
// acceptance: a seeded imaging finding → its linked follow-up surfaces legibly; an
// overdue one is care-persistent and RESISTS a blanket dismiss on collectUpcoming
// (the care-tier contract, end to end); a resolving study lands → the item offers
// the outcome; resolving closes the loop and it drops off; every dedupeKey is
// guardable (#448).
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { followUpItems } from "@/lib/followup-findings";
import {
  trackImagingFollowUpCore,
  resolveFollowUpCore,
} from "@/lib/followup-write";
import { collectUpcoming, dismissFinding } from "@/lib/queries";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";
import { FOLLOWUP_PREFIX } from "@/lib/followup";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addStudy(
  p: number,
  over: {
    modality?: string;
    body_region?: string | null;
    study_date: string | null;
    impression?: string | null;
    document_id?: number | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO imaging_studies
           (profile_id, modality, body_region, contrast, study_date, impression, document_id)
         VALUES (?, ?, ?, 0, ?, ?, ?)`
      )
      .run(
        p,
        over.modality ?? "ct",
        over.body_region ?? null,
        over.study_date,
        over.impression ?? null,
        over.document_id ?? null
      ).lastInsertRowid
  );
}

describe("followUpItems builder (#700)", () => {
  it("surfaces a legible, reasoned follow-up for a tracked imaging finding", () => {
    const p = newProfile("followup-legible");
    const now = today(p);
    // A future-dated follow-up (study 90 days ago, 365-day interval ⇒ ~9mo out).
    const studyDate = shiftDateStr(now, -90);
    const studyId = addStudy(p, {
      modality: "ct",
      body_region: "Chest",
      study_date: studyDate,
      impression: "6 mm RLL nodule, recommend follow-up CT in 12 months",
    });
    const res = trackImagingFollowUpCore(p, studyId, 365, now);
    expect(res.kind).toBe("created");

    const items = followUpItems(p, now);
    expect(items).toHaveLength(1);
    const it = items[0];
    expect(it.domain).toBe("followup");
    expect(it.key).toBe(
      `${FOLLOWUP_PREFIX}${(res as { carePlanItemId: number }).carePlanItemId}`
    );
    expect(dedupeKeyHasKnownPrefix(it.key)).toBe(true);
    expect(it.title).toBe("Follow-up CT chest");
    // The #656 reason carries the WHY, naming the source finding.
    const reason = (it.reasons ?? [])[0];
    expect(reason?.code).toBe("followup-source");
    expect(reason?.text).toContain("6 mm RLL nodule");
    // Not overdue yet ⇒ ordinary suppressibility.
    expect(it.carePersistent).toBeUndefined();
    expect(it.followUpResolve).toBeUndefined();

    // It rides collectUpcoming (reaches Upcoming/hero).
    expect(collectUpcoming(p, now).some((u) => u.key === it.key)).toBe(true);
  });

  it("idempotent per source study — a second track returns the existing one", () => {
    const p = newProfile("followup-idem");
    const now = today(p);
    const studyId = addStudy(p, { study_date: shiftDateStr(now, -30) });
    const a = trackImagingFollowUpCore(p, studyId, 182, now);
    const b = trackImagingFollowUpCore(p, studyId, 182, now);
    expect(a.kind).toBe("created");
    expect(b.kind).toBe("exists");
    expect((b as { carePlanItemId: number }).carePlanItemId).toBe(
      (a as { carePlanItemId: number }).carePlanItemId
    );
    expect(followUpItems(p, now)).toHaveLength(1);
  });

  it("an OVERDUE follow-up is care-persistent and resists a blanket dismiss (care-tier contract, end to end)", () => {
    const p = newProfile("followup-overdue");
    const now = today(p);
    // A study a year ago with a short interval ⇒ planned_date is in the past.
    const studyId = addStudy(p, {
      modality: "ct",
      study_date: shiftDateStr(now, -400),
    });
    const res = trackImagingFollowUpCore(p, studyId, 30, now);
    const key = `${FOLLOWUP_PREFIX}${(res as { carePlanItemId: number }).carePlanItemId}`;

    const before = followUpItems(p, now);
    expect(before).toHaveLength(1);
    expect(before[0].carePersistent).toBe(true);

    // A page dismiss must NOT silence the overdue safety follow-up.
    dismissFinding(p, key);
    expect(collectUpcoming(p, now).some((u) => u.key === key)).toBe(true);
  });

  it("offers a resolution when a matching later study lands, then closes the loop", () => {
    const p = newProfile("followup-resolve");
    const now = today(p);
    const sourceDate = shiftDateStr(now, -365);
    const studyId = addStudy(p, {
      modality: "ct",
      body_region: "Chest",
      study_date: sourceDate,
      impression: "6 mm RLL nodule",
    });
    const res = trackImagingFollowUpCore(p, studyId, 365, now);
    const cpId = (res as { carePlanItemId: number }).carePlanItemId;

    // No later study yet ⇒ no resolution offer.
    expect(followUpItems(p, now)[0].followUpResolve).toBeUndefined();

    // A later matching CT lands ⇒ the item switches to the resolvable OFFER.
    const laterId = addStudy(p, {
      modality: "ct",
      body_region: "Chest",
      study_date: shiftDateStr(now, -5),
    });
    const offering = followUpItems(p, now);
    expect(offering).toHaveLength(1);
    expect(offering[0].band).toBe("today");
    expect(offering[0].followUpResolve).toEqual({
      carePlanItemId: cpId,
      resolvingRecordId: laterId,
    });

    // Confirm-first resolve closes the loop.
    const r = resolveFollowUpCore(p, cpId, "stable", laterId);
    expect(r.kind).toBe("resolved");
    expect(followUpItems(p, now)).toHaveLength(0);

    // Serial view: the chain node carries the outcome + both links.
    const row = db
      .prepare(
        `SELECT status, resolution, source_imaging_study_id AS src,
                resolved_by_imaging_study_id AS res
           FROM care_plan_items WHERE id = ? AND profile_id = ?`
      )
      .get(cpId, p) as {
      status: string;
      resolution: string;
      src: number;
      res: number;
    };
    expect(row.status).toBe("completed");
    expect(row.resolution).toBe("stable");
    expect(row.src).toBe(studyId);
    expect(row.res).toBe(laterId);
  });

  it("refuses to resolve or track cross-profile, and a bad outcome is rejected", () => {
    const p = newProfile("followup-scope-a");
    const other = newProfile("followup-scope-b");
    const now = today(p);
    const studyId = addStudy(p, { study_date: shiftDateStr(now, -10) });
    const res = trackImagingFollowUpCore(p, studyId, 30, now);
    const cpId = (res as { carePlanItemId: number }).carePlanItemId;

    // Another profile can't resolve this follow-up.
    expect(resolveFollowUpCore(other, cpId, "resolved", null).kind).toBe(
      "not-found"
    );
    // A bad outcome is rejected before any write.
    expect(resolveFollowUpCore(p, cpId, "grew", null).kind).toBe(
      "invalid-resolution"
    );
    // Tracking a non-existent / cross-profile study is invalid.
    expect(trackImagingFollowUpCore(p, 99999, 30, now).kind).toBe("invalid");
  });
});
