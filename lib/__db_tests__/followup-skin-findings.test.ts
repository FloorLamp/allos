// DB INTEGRATION TIER (issue #700 — the skin adapter, under the #448 builder-fixture
// rule).
//
// followUpItems now GATHERS skin follow-up state too (linked, open follow-up
// care_plan_items whose source_kind='skin' + the skin_lesions records that are their
// sources and resolving candidates) and hands it to the pure chain core + skin adapter,
// so this carries a DB-tier fixture asserting the END-TO-END finding output — the pure
// tier can't see the SQL gather (the source_kind filter, the #482 identity resolution,
// the resolution close). Pins the acceptance: a seeded "watch this mole" lesion → its
// linked "Recheck skin lesion — …" follow-up surfaces legibly; an overdue one is
// care-persistent and RESISTS a blanket dismiss on collectUpcoming (the care-tier
// contract, end to end); a LATER record of the SAME lesion lands → the item offers the
// outcome; resolving closes the loop and it drops off; tracking is idempotent per
// source lesion.
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { followUpItems } from "@/lib/followup-findings";
import {
  trackSkinFollowUpCore,
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

function addLesion(
  p: number,
  over: {
    label?: string | null;
    body_region?: string | null;
    body_side?: string | null;
    status?: string;
    observed_date: string | null;
    evolving?: 0 | 1;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO skin_lesions
           (profile_id, label, body_region, body_side, status, observed_date, evolving, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`
      )
      .run(
        p,
        over.label ?? "Left forearm mole",
        over.body_region ?? "forearm",
        over.body_side ?? "left",
        over.status ?? "watch",
        over.observed_date,
        over.evolving ?? 0
      ).lastInsertRowid
  );
}

describe("followUpItems builder — skin adapter (#715)", () => {
  it("surfaces a legible, reasoned, care-tier follow-up for a tracked skin lesion", () => {
    const p = newProfile("skin-legible");
    const now = today(p);
    const lesionId = addLesion(p, {
      observed_date: shiftDateStr(now, -30),
      evolving: 1,
    });
    const res = trackSkinFollowUpCore(p, lesionId, 91, now);
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
    expect(it.title).toBe("Recheck skin lesion — Left forearm mole");
    const reason = (it.reasons ?? [])[0];
    expect(reason?.code).toBe("followup-source");
    expect(reason?.text).toContain("Left forearm mole");
    expect(reason?.text).toContain("ABCDE E"); // the recorded observation, neutrally
    expect(declaredReasonCodesFor(it.key)).toContain("followup-source");
    expect(it.href).toBe("/skin");
    // Not overdue yet ⇒ ordinary suppressibility.
    expect(it.carePersistent).toBeUndefined();
    expect(collectUpcoming(p, now).some((u) => u.key === it.key)).toBe(true);
  });

  it("idempotent per source lesion — a second track returns the existing one", () => {
    const p = newProfile("skin-idem");
    const now = today(p);
    const lesionId = addLesion(p, { observed_date: shiftDateStr(now, -10) });
    const a = trackSkinFollowUpCore(p, lesionId, 91, now);
    const b = trackSkinFollowUpCore(p, lesionId, 91, now);
    expect(a.kind).toBe("created");
    expect(b.kind).toBe("exists");
    expect((b as { carePlanItemId: number }).carePlanItemId).toBe(
      (a as { carePlanItemId: number }).carePlanItemId
    );
    expect(followUpItems(p, now)).toHaveLength(1);
  });

  it("an OVERDUE recheck is care-persistent and resists a blanket dismiss", () => {
    const p = newProfile("skin-overdue");
    const now = today(p);
    const lesionId = addLesion(p, { observed_date: shiftDateStr(now, -200) });
    const res = trackSkinFollowUpCore(p, lesionId, 30, now);
    const key = `${FOLLOWUP_PREFIX}${(res as { carePlanItemId: number }).carePlanItemId}`;

    const before = followUpItems(p, now);
    expect(before).toHaveLength(1);
    expect(before[0].carePersistent).toBe(true);

    dismissFinding(p, key);
    expect(collectUpcoming(p, now).some((u) => u.key === key)).toBe(true);
  });

  it("offers a resolution when a LATER same-lesion record lands, then closes the loop", () => {
    const p = newProfile("skin-resolve");
    const now = today(p);
    const sourceId = addLesion(p, { observed_date: shiftDateStr(now, -120) });
    const res = trackSkinFollowUpCore(p, sourceId, 91, now);
    const cpId = (res as { carePlanItemId: number }).carePlanItemId;

    // A record of a DIFFERENT lesion must not offer resolution.
    addLesion(p, {
      label: "Right shoulder mole",
      body_region: "shoulder",
      body_side: "right",
      observed_date: shiftDateStr(now, -5),
    });
    expect(followUpItems(p, now)[0].followUpResolve).toBeUndefined();

    // A later record of the SAME lesion ⇒ the item switches to the resolvable OFFER.
    const laterId = addLesion(p, {
      status: "active",
      observed_date: shiftDateStr(now, -2),
    });
    const offering = followUpItems(p, now);
    expect(offering).toHaveLength(1);
    expect(offering[0].band).toBe("today");
    expect(offering[0].followUpResolve).toEqual({
      carePlanItemId: cpId,
      resolvingRecordId: laterId,
    });

    // Confirm-first resolve (a 'changed' verdict) closes the loop.
    const r = resolveFollowUpCore(p, cpId, "changed", laterId);
    expect(r.kind).toBe("resolved");
    expect(followUpItems(p, now)).toHaveLength(0);

    const row = db
      .prepare(
        `SELECT status, resolution, source_skin_lesion_id AS src,
                resolved_by_skin_lesion_id AS res
           FROM care_plan_items WHERE id = ? AND profile_id = ?`
      )
      .get(cpId, p) as {
      status: string;
      resolution: string;
      src: number;
      res: number;
    };
    expect(row.status).toBe("completed");
    expect(row.resolution).toBe("changed");
    expect(row.src).toBe(sourceId);
    expect(row.res).toBe(laterId);
  });

  it("refuses to track or resolve cross-profile", () => {
    const p = newProfile("skin-scope-a");
    const other = newProfile("skin-scope-b");
    const now = today(p);
    const lesionId = addLesion(p, { observed_date: shiftDateStr(now, -10) });
    const res = trackSkinFollowUpCore(p, lesionId, 30, now);
    const cpId = (res as { carePlanItemId: number }).carePlanItemId;

    expect(resolveFollowUpCore(other, cpId, "resolved", null).kind).toBe(
      "not-found"
    );
    expect(trackSkinFollowUpCore(p, 99999, 30, now).kind).toBe("invalid");
  });
});
