// DB INTEGRATION TIER (issue #700 — the flagged-labs adapter, under the #448
// builder-fixture rule).
//
// followUpItems now GATHERS labs follow-up state too (linked, open follow-up
// care_plan_items whose source_kind='labs' + the medical_records readings that are
// their sources and resolving candidates) and hands it to the pure chain core + labs
// adapter, so this carries a DB-tier fixture asserting the END-TO-END finding output —
// the pure tier can't see the SQL gather (the source_kind filter, the #482 family
// resolution, the resolution close). Pins the acceptance: a seeded flagged A1c → its
// linked "Recheck A1c" follow-up surfaces legibly ("for the flagged 8.2% (2026-05)");
// an overdue one is care-persistent and RESISTS a blanket dismiss on collectUpcoming
// (the care-tier contract, end to end); a later A1c/eAG reading lands → the item offers
// the outcome (the FAMILY case: an eAG recheck resolves an A1c); resolving closes the
// loop and it drops off; and tracking is idempotent per #482 family.
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { followUpItems } from "@/lib/followup-findings";
import {
  trackLabFollowUpCore,
  resolveFollowUpCore,
} from "@/lib/followup-write";
import { collectUpcoming, dismissFinding } from "@/lib/queries";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
  declaredReasonCodesFor,
} from "@/lib/rule-finding-prefixes";
import { FOLLOWUP_PREFIX } from "@/lib/followup";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addReading(
  p: number,
  over: {
    canonical_name: string;
    date: string;
    value?: string | null;
    value_num?: number | null;
    unit?: string | null;
    flag?: string | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit, canonical_name, flag, source)
         VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?, 'manual')`
      )
      .run(
        p,
        over.date,
        over.canonical_name,
        over.value ?? null,
        over.value_num ?? null,
        over.unit ?? null,
        over.canonical_name,
        over.flag ?? "high"
      ).lastInsertRowid
  );
}

describe("followUpItems labs builder (#700)", () => {
  it("surfaces a legible, reasoned, care-tier follow-up for a flagged lab", () => {
    const p = newProfile("lab-followup-legible");
    const now = today(p);
    // A flagged A1c dated ~30 days ago with a 91-day interval ⇒ due in the future.
    const readingDate = shiftDateStr(now, -30);
    const recId = addReading(p, {
      canonical_name: "Hemoglobin A1c",
      date: readingDate,
      value: "8.2",
      value_num: 8.2,
      unit: "%",
      flag: "high",
    });
    const res = trackLabFollowUpCore(p, recId, 91, now);
    expect(res.kind).toBe("created");

    const items = followUpItems(p, now);
    expect(items).toHaveLength(1);
    const it = items[0];
    expect(it.domain).toBe("followup");
    expect(it.key).toBe(
      `${FOLLOWUP_PREFIX}${(res as { carePlanItemId: number }).carePlanItemId}`
    );
    expect(dedupeKeyHasKnownPrefix(it.key)).toBe(true);
    expect(tierForDedupeKey(it.key)).toBe("care");
    expect(it.title).toBe("Recheck Hemoglobin A1c");
    // The #656 reason carries the WHY, naming the flagged source finding.
    const reason = (it.reasons ?? [])[0];
    expect(reason?.code).toBe("followup-source");
    expect(reason?.text).toContain("flagged 8.2%");
    expect(declaredReasonCodesFor(it.key)).toContain("followup-source");
    // The item deep-links to the biomarker's detail page.
    expect(it.href).toContain("/biomarkers/view");
    // Not overdue yet ⇒ ordinary suppressibility.
    expect(it.carePersistent).toBeUndefined();
    expect(it.followUpResolve).toBeUndefined();
    // It rides collectUpcoming (reaches Upcoming/hero).
    expect(collectUpcoming(p, now).some((u) => u.key === it.key)).toBe(true);
  });

  it("idempotent per #482 FAMILY — tracking an eAG reading returns the A1c follow-up", () => {
    const p = newProfile("lab-followup-family-idem");
    const now = today(p);
    const a1cId = addReading(p, {
      canonical_name: "Hemoglobin A1c",
      date: shiftDateStr(now, -20),
      value: "8.0",
      value_num: 8.0,
      unit: "%",
    });
    const eagId = addReading(p, {
      canonical_name: "Estimated Average Glucose",
      date: shiftDateStr(now, -19),
      value: "183",
      value_num: 183,
      unit: "mg/dL",
    });
    const a = trackLabFollowUpCore(p, a1cId, 91, now);
    const b = trackLabFollowUpCore(p, eagId, 91, now);
    expect(a.kind).toBe("created");
    // Same measurement family (A1c ↔ eAG) ⇒ the second track returns the existing one.
    expect(b.kind).toBe("exists");
    expect((b as { carePlanItemId: number }).carePlanItemId).toBe(
      (a as { carePlanItemId: number }).carePlanItemId
    );
    expect(followUpItems(p, now)).toHaveLength(1);
  });

  it("an OVERDUE flagged-lab follow-up is care-persistent and resists a blanket dismiss", () => {
    const p = newProfile("lab-followup-overdue");
    const now = today(p);
    // A flagged reading well in the past with a short interval ⇒ planned_date is past.
    const recId = addReading(p, {
      canonical_name: "LDL Cholesterol",
      date: shiftDateStr(now, -200),
      value: "190",
      value_num: 190,
      unit: "mg/dL",
    });
    const res = trackLabFollowUpCore(p, recId, 30, now);
    const key = `${FOLLOWUP_PREFIX}${(res as { carePlanItemId: number }).carePlanItemId}`;

    const before = followUpItems(p, now);
    expect(before).toHaveLength(1);
    expect(before[0].carePersistent).toBe(true);

    // A page dismiss must NOT silence the overdue safety follow-up (care-tier contract).
    dismissFinding(p, key);
    expect(collectUpcoming(p, now).some((u) => u.key === key)).toBe(true);
  });

  it("offers a resolution when a later same-FAMILY reading lands, then closes the loop", () => {
    const p = newProfile("lab-followup-resolve");
    const now = today(p);
    const sourceDate = shiftDateStr(now, -120);
    const a1cId = addReading(p, {
      canonical_name: "Hemoglobin A1c",
      date: sourceDate,
      value: "8.2",
      value_num: 8.2,
      unit: "%",
    });
    const res = trackLabFollowUpCore(p, a1cId, 91, now);
    const cpId = (res as { carePlanItemId: number }).carePlanItemId;

    // No later reading yet ⇒ no resolution offer.
    expect(followUpItems(p, now)[0].followUpResolve).toBeUndefined();

    // A later eAG recheck lands ⇒ the item switches to the resolvable OFFER (FAMILY case).
    const eagId = addReading(p, {
      canonical_name: "Estimated Average Glucose",
      date: shiftDateStr(now, -3),
      value: "126",
      value_num: 126,
      unit: "mg/dL",
      flag: "normal",
    });
    const offering = followUpItems(p, now);
    expect(offering).toHaveLength(1);
    expect(offering[0].band).toBe("today");
    expect(offering[0].followUpResolve).toEqual({
      carePlanItemId: cpId,
      resolvingRecordId: eagId,
    });

    // Confirm-first resolve closes the loop.
    const r = resolveFollowUpCore(p, cpId, "stable", eagId);
    expect(r.kind).toBe("resolved");
    expect(followUpItems(p, now)).toHaveLength(0);

    // Serial view: the chain node carries the outcome + both medical_records links.
    const row = db
      .prepare(
        `SELECT status, resolution, source_medical_record_id AS src,
                resolved_by_medical_record_id AS res
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
    expect(row.src).toBe(a1cId);
    expect(row.res).toBe(eagId);
  });

  it("refuses to resolve or track cross-profile, and a bad outcome is rejected", () => {
    const p = newProfile("lab-followup-scope-a");
    const other = newProfile("lab-followup-scope-b");
    const now = today(p);
    const recId = addReading(p, {
      canonical_name: "Hemoglobin A1c",
      date: shiftDateStr(now, -10),
    });
    const res = trackLabFollowUpCore(p, recId, 30, now);
    const cpId = (res as { carePlanItemId: number }).carePlanItemId;

    // Another profile can't resolve this follow-up.
    expect(resolveFollowUpCore(other, cpId, "resolved", null).kind).toBe(
      "not-found"
    );
    // A bad outcome is rejected before any write.
    expect(resolveFollowUpCore(p, cpId, "grew", null).kind).toBe(
      "invalid-resolution"
    );
    // Tracking a non-existent / cross-profile reading is invalid.
    expect(trackLabFollowUpCore(p, 999999, 30, now).kind).toBe("invalid");
  });
});
