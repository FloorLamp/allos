// DB INTEGRATION TIER — enzyme U/L ⇄ IU/L unit interchangeability (issue #828).
//
// ALT/AST/ALP/GGT/amylase/lipase report the identical µmol/min catalytic assay as
// both "U/L" and "IU/L". All six store canonical unit "U/L" and (before #828) had
// NO IU/L conversion, so the parser — which keeps bare catalytic U ("enzyme") and
// international-unit IU ("activity") in separate dimensions (issue #759) — could not
// convert an IU/L reading: its out-of-range flag never derived (the exact #759 bug,
// reintroduced for this unit pair) and its trend series would split by spelling.
//
// This proves the fix END-TO-END against the real schema + flag-reconcile gate,
// following pediatric-flag-reconcile.test.ts:
//   • an AST reading stored in IU/L ABOVE the canonical U/L range re-derives to
//     "high" through the same boot-time reconcile the deploy path runs, and
//   • that IU/L reading joins the SAME trend series (getBiomarkerSeries, grouped by
//     canonical name) as a plain U/L reading of AST, converting to a comparable
//     canonical value (factor 1) so both land on one axis.
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { getBiomarkerSeries } from "@/lib/queries";
import { convertToCanonical } from "@/lib/unit-conversions";
import { reconcileFlagsIfCanonicalChanged } from "@/lib/migrations/boot-tasks";

let profileId: number;
let iuHighId: number; // AST 200 IU/L — above range, must flag "high"
let ulHighId: number; // AST 200 U/L  — the same value in the canonical spelling
let ulNormalId: number; // AST 25 U/L — in range, stays unflagged

const AST_CB = { name: "Aspartate Aminotransferase (AST)", unit: "U/L" };

function flagOf(id: number): string | null {
  const r = db
    .prepare("SELECT flag FROM medical_records WHERE id = ?")
    .get(id) as { flag: string | null } | undefined;
  return r?.flag ?? null;
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Enzyme IU Patient')").run()
      .lastInsertRowid
  );
  const base = today(profileId);
  const insert = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, flag)
     VALUES (?, ?, 'lab', 'Aspartate Aminotransferase (AST)', ?, ?, 'Aspartate Aminotransferase (AST)', ?, ?)`
  );
  // Three AST readings on distinct dates so the read-layer dedup keeps all three.
  // Flags seeded NULL — the reconcile gate is what must derive them.
  ulNormalId = Number(
    insert.run(profileId, "2026-01-01", "25", "U/L", 25, null).lastInsertRowid
  );
  ulHighId = Number(
    insert.run(profileId, "2026-02-01", "200", "U/L", 200, null).lastInsertRowid
  );
  iuHighId = Number(
    insert.run(profileId, base, "200", "IU/L", 200, null).lastInsertRowid
  );
});

describe("enzyme U/L ⇄ IU/L unit interchangeability (#828)", () => {
  it("converts an IU/L reading to the U/L canonical at factor 1 (value preserved)", () => {
    // The pure conversion the reconcile + chart both rely on.
    expect(convertToCanonical(200, "IU/L", AST_CB)).toBe(200);
    expect(convertToCanonical(25, "IU/L", AST_CB)).toBe(25);
  });

  it("derives an out-of-range flag for an IU/L reading above the U/L range", () => {
    // Move the stored signature so the gate reconciles once (as a deploy would).
    db.prepare(
      "UPDATE settings SET value = 'stale-signature-828' WHERE key = 'canonical_flags_sig'"
    ).run();
    reconcileFlagsIfCanonicalChanged(db);

    // AST is lower_better with ref_high 40; 200 (IU/L or U/L) is above → "high".
    expect(flagOf(iuHighId)).toBe("high");
    // …and the plain U/L reading of the same value flags identically (no spelling
    // dependence), while an in-range U/L reading stays unflagged.
    expect(flagOf(ulHighId)).toBe("high");
    expect(flagOf(ulNormalId)).toBeNull();
  });

  it("joins the IU/L reading into the same AST trend series as the U/L readings", () => {
    const series = getBiomarkerSeries(
      profileId,
      "Aspartate Aminotransferase (AST)"
    );
    const ids = series.map((r) => r.id);
    // All three readings — regardless of unit spelling — are ONE series.
    expect(ids).toContain(iuHighId);
    expect(ids).toContain(ulHighId);
    expect(ids).toContain(ulNormalId);

    // Every point converts to the canonical U/L unit, so the IU/L point plots on the
    // same numeric axis as the U/L points (factor 1 — no rescale).
    const converted = series.map((r) =>
      convertToCanonical(r.value_num, r.unit, AST_CB)
    );
    expect(converted).not.toContain(null);
    // The IU/L 200 and the U/L 200 map to the identical canonical value.
    const iu = series.find((r) => r.id === iuHighId)!;
    const ul = series.find((r) => r.id === ulHighId)!;
    expect(convertToCanonical(iu.value_num, iu.unit, AST_CB)).toBe(
      convertToCanonical(ul.value_num, ul.unit, AST_CB)
    );
  });
});
