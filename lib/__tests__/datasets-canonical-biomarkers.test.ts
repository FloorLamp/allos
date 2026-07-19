import { describe, expect, it } from "vitest";
import rawCanonical from "@/lib/canonical-biomarkers.json";
import {
  canonicalBiomarkersDataset,
  canonicalBiomarkerForName,
  CANONICAL_BIOMARKERS,
} from "@/lib/datasets/canonical-biomarkers";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  nameStrategy,
  runHarness,
} from "@/lib/datasets";
import { canonicalFlagsSignature } from "@/lib/canonical-flags-version";

// Framework-contract + BEHAVIOR-PRESERVATION tests for the canonical-biomarkers dataset
// (issue #860 Track B — the sole deferred dataset, migrated as a READ LAYER over the
// byte-identical committed JSON; see lib/datasets/canonical-biomarkers.ts). These assert
// the reusable harness (citation / identity / refusal) AND the load-bearing invariant of
// this particular migration: the framework wrapping copies NO value — the envelope's
// entries ARE the committed rows, so the ranges the boot task seeds are unchanged. The
// end-to-end seed-parity + flag-gate proof lives in the DB tier
// (lib/__db_tests__/canonical-biomarkers-dataset.test.ts). Pure — no DB, no network.

// The flag-relevant signature of the committed dataset at migration time. It is the
// SAME sha256 the boot reconcile keys on (canonicalFlagsSignature) — pinning it here
// makes the migration a fixed point: wrapping the file in the envelope must not perturb
// any range/optimal/unit/direction value. If you INTENTIONALLY edit a curated range,
// this golden changes on purpose — update it (the boot reconcile will re-flag stored
// records the same way).
// Updated for #918: the curated urinalysis, immunoglobulin, and audit-confirmed
// gap entries (tumor markers, serology, urine chemistry, ratios) add flag-relevant
// ranges, so the signature legitimately changes (the boot reconcile re-flags stored
// records against the new bands).
// Updated for #698: the vision analytes (intraocular pressure — the 10–21 mmHg band —
// and visual acuity, qualitative/null bands) add new dataset rows, so the signature
// legitimately changes and the boot reconcile re-flags stored IOP records against the
// new band (an already-stored >21 mmHg reading picks up its "high" flag on next boot).
// Updated for #716: the mental-health instruments (PHQ-9, GAD-7) add two dataset rows
// with null bands (they carry NO numeric flag — the severity band is the on-screen
// signal, not a MedicalFlag), so the signature changes but no stored record re-flags.
// Updated for #705: the periodontal analytes (probing depth ≤3 mm, bleeding-on-probing
// <10%, clinical attachment loss ≤1 mm — all lower_better) add new flag-relevant rows,
// so the signature legitimately changes and the boot reconcile re-flags stored perio
// records against the new bands.
// Updated for #718: cycle-phase reference ranges — the ranges_by_cycle_phase field is
// added to FLAG_RELEVANT_FIELDS (and FLAG_LOGIC_VERSION bumps to 8), the four hormones
// (FSH/LH/estradiol/progesterone) gain phase ranges, and Progesterone is a new curated
// row, so the signature legitimately changes. On the next boot the reconcile re-derives
// the hormone flags for profiles WITH a cycle log against the phase range (a no-op for
// profiles with none — they derive no phase and re-flag to the identical prior value).
// Updated for #713: the audiogram pure-tone thresholds (12 per-ear, per-frequency dB HL
// analytes, all lower_better with the ≤25 dB HL WHO band) add new flag-relevant rows,
// so the signature legitimately changes again and the boot reconcile re-flags stored
// hearing records against the new bands (the combined value below covers both changes).
const FLAG_SIGNATURE_GOLDEN =
  // A SHA-256 content hash of the canonical dataset; a digit substring
  // coincidentally forms a Luhn-valid NPI shape — provably synthetic.
  "e980fc216e0b96f67e76199220de43ddcd58143f48d29ed974ba1b6e55cf6394"; // phi-scan-ok

describe("canonical-biomarkers dataset on the curated-dataset framework", () => {
  it("passes the whole framework harness (citation + identity + refusal + no collisions)", () => {
    const r = runHarness(canonicalBiomarkersDataset, nameStrategy);
    expect(r.problems, r.problems.join("; ")).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("carries an honest, externally-grounded citation", () => {
    const r = citationPresent(canonicalBiomarkersDataset);
    expect(r.problems).toEqual([]);
    // Not a circular self-citation: real clinical/pediatric provenance.
    expect(
      canonicalBiomarkersDataset.citation.some((c) =>
        /reference intervals|CALIPER|longevity/i.test(c.source)
      )
    ).toBe(true);
  });

  it("resolves every entry by its exact canonical name", () => {
    const r = identityResolves(canonicalBiomarkersDataset, nameStrategy);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses a name the controlled vocabulary does not contain (null, never a guess)", () => {
    const r = refusalGate(canonicalBiomarkersDataset, nameStrategy, [
      "__no_such_biomarker__",
      "",
    ]);
    expect(r.problems).toEqual([]);
    expect(canonicalBiomarkerForName("__no_such_biomarker__")).toBeNull();
  });

  it("resolves a known biomarker case-insensitively (behavior-identical lookup)", () => {
    const ldl = canonicalBiomarkerForName("ldl cholesterol");
    expect(ldl).toBeTruthy();
    expect(ldl!.name).toBe("LDL Cholesterol");
    expect(ldl!.direction).toBe("lower_better");
  });

  it("wraps the committed file WITHOUT copying or transforming any value (fixed point)", () => {
    // The envelope's entries are the raw file's `biomarkers` array itself — the same
    // reference, no map/clone — so no range/optimal value can drift in the wrap.
    expect(canonicalBiomarkersDataset.entries).toBe(
      (rawCanonical as { biomarkers: unknown[] }).biomarkers
    );
    expect(CANONICAL_BIOMARKERS).toBe(canonicalBiomarkersDataset.entries);
    expect(CANONICAL_BIOMARKERS.length).toBe(
      (rawCanonical as { biomarkers: unknown[] }).biomarkers.length
    );
    expect(CANONICAL_BIOMARKERS.length).toBeGreaterThan(150);
  });

  it("is flag-signature-stable: the read layer and the boot reconcile see the same data", () => {
    // The framework entries produce the identical flag signature as the boot module's
    // own read of the committed file — they can never diverge — and it matches the
    // migration-time golden, proving no flag-relevant value changed.
    const sigFromDataset = canonicalFlagsSignature(
      canonicalBiomarkersDataset.entries as unknown as Parameters<
        typeof canonicalFlagsSignature
      >[0]
    );
    expect(sigFromDataset).toBe(canonicalFlagsSignature());
    expect(sigFromDataset).toBe(FLAG_SIGNATURE_GOLDEN);
  });
});
