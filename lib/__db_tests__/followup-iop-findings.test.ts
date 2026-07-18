// DB INTEGRATION TIER (issue #698 §6 — the IOP glaucoma follow-up adapter, under the
// #448 builder-fixture rule).
//
// followUpItems now GATHERS IOP follow-up state too (linked, open follow-up
// care_plan_items whose source_kind='iop' + the intraocular-pressure medical_records
// readings that are their sources and resolving candidates) and hands it to the pure
// chain core + IOP adapter, so this carries a DB-tier fixture asserting the END-TO-END
// finding output — the pure tier can't see the SQL gather (the source_kind filter, the
// IOP-name pool, the resolution close). Pins the acceptance: a seeded flagged IOP → its
// linked "Recheck IOP / glaucoma workup" follow-up surfaces legibly ("for the flagged
// 28 mmHg, right eye (…)"); the follow-up is ONE bilateral question (tracking from
// either eye returns the same one); an overdue one is care-persistent and RESISTS a
// blanket dismiss (the care-tier contract, end to end); a later pressure in EITHER eye
// lands → the item offers the outcome; resolving closes the loop and it drops off.
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { followUpItems } from "@/lib/followup-findings";
import {
  trackIopFollowUpCore,
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

function addIop(
  p: number,
  over: {
    canonical_name: string;
    date: string;
    value?: string | null;
    value_num?: number | null;
    flag?: string | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit, canonical_name, flag, source)
         VALUES (?, ?, 'vitals', ?, ?, ?, 'mmHg', ?, ?, 'manual')`
      )
      .run(
        p,
        over.date,
        over.canonical_name,
        over.value ?? null,
        over.value_num ?? null,
        over.canonical_name,
        over.flag ?? "high"
      ).lastInsertRowid
  );
}

describe("followUpItems IOP builder (#698 §6)", () => {
  it("surfaces a legible, reasoned, care-tier glaucoma follow-up for a flagged IOP", () => {
    const p = newProfile("iop-followup-legible");
    const now = today(p);
    const readingDate = shiftDateStr(now, -30);
    const recId = addIop(p, {
      canonical_name: "Intraocular Pressure, Right Eye",
      date: readingDate,
      value: "28",
      value_num: 28,
      flag: "high",
    });
    const res = trackIopFollowUpCore(p, recId, 91, now);
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
    expect(it.title).toBe("Recheck IOP / glaucoma workup");
    const reason = (it.reasons ?? [])[0];
    expect(reason?.code).toBe("followup-source");
    expect(reason?.text).toContain("flagged 28 mmHg, right eye");
    expect(declaredReasonCodesFor(it.key)).toContain("followup-source");
    expect(it.href).toContain("/biomarkers/view");
    expect(it.carePersistent).toBeUndefined();
    expect(it.followUpResolve).toBeUndefined();
    expect(collectUpcoming(p, now).some((u) => u.key === it.key)).toBe(true);
  });

  it("is ONE bilateral question — tracking the other eye returns the same follow-up", () => {
    const p = newProfile("iop-followup-bilateral");
    const now = today(p);
    const rightId = addIop(p, {
      canonical_name: "Intraocular Pressure, Right Eye",
      date: shiftDateStr(now, -20),
      value: "28",
      value_num: 28,
    });
    const leftId = addIop(p, {
      canonical_name: "Intraocular Pressure, Left Eye",
      date: shiftDateStr(now, -20),
      value: "26",
      value_num: 26,
    });
    const a = trackIopFollowUpCore(p, rightId, 91, now);
    const b = trackIopFollowUpCore(p, leftId, 91, now);
    expect(a.kind).toBe("created");
    // The other eye is the same glaucoma workup ⇒ returns the existing follow-up.
    expect(b.kind).toBe("exists");
    expect((b as { carePlanItemId: number }).carePlanItemId).toBe(
      (a as { carePlanItemId: number }).carePlanItemId
    );
    expect(followUpItems(p, now)).toHaveLength(1);
  });

  it("an OVERDUE IOP follow-up is care-persistent and resists a blanket dismiss", () => {
    const p = newProfile("iop-followup-overdue");
    const now = today(p);
    const recId = addIop(p, {
      canonical_name: "Intraocular Pressure, Right Eye",
      date: shiftDateStr(now, -200),
      value: "30",
      value_num: 30,
    });
    const res = trackIopFollowUpCore(p, recId, 30, now);
    const key = `${FOLLOWUP_PREFIX}${(res as { carePlanItemId: number }).carePlanItemId}`;

    const before = followUpItems(p, now);
    expect(before).toHaveLength(1);
    expect(before[0].carePersistent).toBe(true);

    // A page dismiss must NOT silence the overdue safety follow-up (care-tier contract).
    dismissFinding(p, key);
    expect(collectUpcoming(p, now).some((u) => u.key === key)).toBe(true);
  });

  it("offers a resolution when a later pressure (either eye) lands, then closes the loop", () => {
    const p = newProfile("iop-followup-resolve");
    const now = today(p);
    const sourceDate = shiftDateStr(now, -120);
    const rightId = addIop(p, {
      canonical_name: "Intraocular Pressure, Right Eye",
      date: sourceDate,
      value: "28",
      value_num: 28,
    });
    const res = trackIopFollowUpCore(p, rightId, 91, now);
    const cpId = (res as { carePlanItemId: number }).carePlanItemId;

    // No later reading yet ⇒ no resolution offer.
    expect(followUpItems(p, now)[0].followUpResolve).toBeUndefined();

    // A later LEFT-eye repeat pressure lands ⇒ the item switches to the resolvable OFFER
    // (bilateral — one workup covers both eyes).
    const leftId = addIop(p, {
      canonical_name: "Intraocular Pressure, Left Eye",
      date: shiftDateStr(now, -3),
      value: "17",
      value_num: 17,
      flag: "normal",
    });
    const offering = followUpItems(p, now);
    expect(offering).toHaveLength(1);
    expect(offering[0].band).toBe("today");
    expect(offering[0].followUpResolve).toEqual({
      carePlanItemId: cpId,
      resolvingRecordId: leftId,
    });

    const r = resolveFollowUpCore(p, cpId, "stable", leftId);
    expect(r.kind).toBe("resolved");
    expect(followUpItems(p, now)).toHaveLength(0);

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
    expect(row.src).toBe(rightId);
    expect(row.res).toBe(leftId);
  });

  it("refuses to resolve or track cross-profile, and a bad outcome is rejected", () => {
    const p = newProfile("iop-followup-scope-a");
    const other = newProfile("iop-followup-scope-b");
    const now = today(p);
    const recId = addIop(p, {
      canonical_name: "Intraocular Pressure, Right Eye",
      date: shiftDateStr(now, -10),
    });
    const res = trackIopFollowUpCore(p, recId, 30, now);
    const cpId = (res as { carePlanItemId: number }).carePlanItemId;

    expect(resolveFollowUpCore(other, cpId, "resolved", null).kind).toBe(
      "not-found"
    );
    expect(resolveFollowUpCore(p, cpId, "grew", null).kind).toBe(
      "invalid-resolution"
    );
    expect(trackIopFollowUpCore(p, 999999, 30, now).kind).toBe("invalid");
  });
});
