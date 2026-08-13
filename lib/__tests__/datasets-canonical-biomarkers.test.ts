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
// Updated for #998: the substance-use instruments (AUDIT-C, AUDIT, DAST-10) add three
// dataset rows with null bands (the #716 contract: no numeric flag — the severity band
// is the on-screen signal, never a MedicalFlag, so a score can't ride the flagged-
// biomarker digest push), so the signature changes but no stored record re-flags.
// Updated for #1018: FLAG_LOGIC_VERSION bumps to 9 — sameUnit/convertToCanonical now
// strip UCUM brackets/annotations (mm[Hg] ≡ mmHg, [degF] ≡ degF), so imported rows
// whose flags were never derived become judgeable; the dataset rows are unchanged, but
// the version bump legitimately changes the signature so the boot reconcile runs once
// (also re-flagging the Body Temperature rows migration 074 converted to °F).
// Updated for #1193/#1195: five new curated entries — the vitamin-D D2/D3 fractions
// (null bands, so no fraction re-flags) and calcitriol (1,25-dihydroxy, 18–72 pg/mL),
// plus plain C-Reactive Protein (mg/L, ≤10) and Glucose, Fasting (70–99 mg/dL) — add
// flag-relevant rows, so the signature legitimately changes and the boot reconcile
// re-flags stored orphaned readings (a fasting glucose / plain CRP that had no band)
// against the new bands on the next boot.
// Updated for the "map every LOINC" sweep: ~30 curated qualitative entries
// (serology / PCR / IgG-immunity / NIPT screens / culture organism / Hep B/C /
// hemoglobin electrophoresis) — all RANGELESS (in_range, null bands), so they add
// NO flag-relevant rows — plus ONE ranged addition (Glucose, Gestational Screen
// (50 g), ref_high 135), which does change the signature and re-flags a stored
// gestational-screen reading that previously had no band.
// Updated for the bare-abbreviation → "Full Name (ABBR)" consolidation: 15
// measured-lab entries (ALT/AST/GGT/BUN/TSH/hs-CRP/PSA/ApoB/TIBC/IGF-1 + the CBC
// indices MCV/MCH/MCHC/MPV/RDW) were renamed to their spelled-out form. Their
// bands are UNCHANGED — only the name changed — so the signature moves (name is
// part of it) but no stored record re-flags. Migration 093 rewrites stored
// canonical_name so existing rows keep matching their (renamed) entry.
// Updated for the respiratory domain (#1850): four `vitals` entries — Peak Expiratory
// Flow, FEV1 and FVC are RANGELESS (no population band exists for any of them, which
// is the whole argument in lib/peak-flow.ts), so they add no flag-relevant band; the
// FEV1/FVC Ratio's ref_low 70 is the one real cutoff and is what a stored ratio row
// now re-flags against. The signature moves because names are part of it.
// Updated for #2300: 23 new curated entries close out the last unresolved analyte
// names (urinalysis microscopy + physical description, a stool group, three CBC smear
// lines, indirect bilirubin, the two urine ratios, HDL as a % of cholesterol, total
// omega-6, and the ANA screen). Every one is RANGELESS, so none adds a numeric band —
// but `name`, `unit` and `direction` are all part of the signature, so it legitimately
// changes and the boot reconcile runs once. What that pass buys is real: a stored
// reading that previously matched no entry now resolves to one, and the qualitative
// classifier (#549/#629) can finally judge it — a positive fecal occult blood or ANA
// screen reaches its flag instead of staying an unbanded orphan. FLAG_LOGIC_VERSION is
// deliberately NOT bumped: the derivation LOGIC is unchanged, and the dataset half of
// the signature already forces the re-reconcile on its own.
// Updated for #2337: the unqualified `Glucose` entry gives up its bands (ref 65–99 and
// optimal 70–85 → null). Both were FASTING intervals — 65–99 is the lab-printed CMP one,
// and CMP glucose is reported in a fasting frame — so the app had no band for a glucose
// whose fasting state is unknown, which is exactly what an unqualified reading is. Four
// flag-relevant fields go null, so the signature legitimately changes and the boot
// reconcile runs once. FLAG_LOGIC_VERSION is deliberately NOT bumped: the derivation
// LOGIC is unchanged, and the dataset half of the signature already forces the
// re-reconcile on its own (same reasoning as #2300). `Glucose, Fasting` keeps 70–99 —
// it is correct, and 70 (the clinical hypoglycemia threshold, not the 65 lab artifact)
// is now the only fasting floor left in the dataset.
// Updated for #2335: 20 entries were RENAMED so every canonical name states what it
// measures (the CBC differential's relative/absolute halves, the two unqualified eye
// entries, and the remaining opaque abbreviations). `name` is a FLAG_RELEVANT_FIELD,
// so a pure rename legitimately moves the signature and the boot reconcile runs once
// — which is exactly what the renamed rows need, since a reading re-pointed by
// migration 177 is judged against its entry's band under the new name. No range, unit
// or direction changed, so FLAG_LOGIC_VERSION is again NOT bumped.
// Updated for #2322: 19 new curated entries close out the uncatalogued analytes that
// had no home — the ECG group (intervals, the three frontal-plane axes, ventricular
// rate and the reading clinician's interpretation), the per-side ABI and CAVI, the
// two whole-body mass indices, peak METs, and four qualitative verdicts. Most are
// RANGELESS, but several add real bands the boot reconcile now judges stored readings
// against: QTc (450 ms, 460 in women — the one in this set that changes what a person
// is told), PR 120–200 ms, QRS ≤110 ms, the P/QRS axis arcs, ventricular rate 60–100,
// ABI 1.00–1.40, CAVI ≤8.0 and the sex-specific Fat Mass Index range. A stored ECG or
// vascular reading that previously matched no entry picks up its flag on the next
// boot. FLAG_LOGIC_VERSION is deliberately NOT bumped: the derivation LOGIC is
// unchanged and the dataset half of the signature already forces the re-reconcile on
// its own (the #2300/#2337/#2335 reasoning).
// Updated for #2371: the insulin twin of the #2337 glucose split. `Insulin, Fasting`
// is coined carrying the bands the unqualified entry used to hold (ref ≤18.4, optimal
// 2–5, lower_better) — they were always FASTING intervals, asserted by a one-word
// "Fasting" note rather than by the name — and the unqualified `Insulin` gives them
// up, because an insulin of unstated frame has no band the app can honestly apply and
// the post-prandial spread is wider here than it is on glucose. A new entry plus four
// fields going null legitimately moves the signature, and the boot reconcile runs
// once: a stored bare `Insulin` reading loses a flag it should never have carried, and
// nothing is re-pointed, because a reading that does not state a fasting frame is not
// ours to re-file under one (#2338). FLAG_LOGIC_VERSION is deliberately NOT bumped:
// the derivation LOGIC is unchanged (the #2300/#2337/#2335 reasoning).
// Updated for #2321: EPDS joins the instrument entries beside PHQ-9 and GAD-7. Like
// them it is a RANGELESS instrument score — no ref/optimal bounds, so it contributes no
// flag of its own and the severity band remains the only on-screen signal — but a new
// entry moves the signature by construction, so the boot reconcile runs once and
// changes no stored flag. FLAG_LOGIC_VERSION is deliberately NOT bumped: the derivation
// LOGIC is unchanged (the #2300/#2337/#2335 reasoning).
// Updated for #2526: the cortisol twin of the same split, found by the audit #2518
// asked for. `Cortisol, Morning` is coined carrying the 6-18 ug/dL band the unqualified
// entry used to hold — it is a MORNING interval, asserted by the two-word note "Morning
// draw" rather than by the name, and cortisol's diurnal swing is the widest of the three:
// a value normal at 8 p.m. is low against the 8 a.m. band. The unqualified `Cortisol`
// gives the band up. One new entry plus two fields going null moves the signature, and
// the boot reconcile runs once: a stored bare `Cortisol` reading loses a flag it should
// never have carried, and nothing is re-pointed (#2338/#2518). FLAG_LOGIC_VERSION is
// deliberately NOT bumped: the derivation LOGIC is unchanged.
// Updated for the hepatitis A total-antibody entry: ONE new curated row, RANGELESS
// (every ref/optimal field null), so it adds no numeric band and re-judges nothing by
// value. What it changes is IDENTITY — a name that had no curated entry now has one,
// so the ai-coined `Hepatitis A Ab Total` vocabulary row is superseded, its stored
// readings are re-pointed by mergeSupersededCanonicalNames, and the boot reconcile
// judges them against a real entry instead of none. It fell through a seam rather
// than being declined: the hepatitis serology was curated as INFECTION markers
// (HBsAg, anti-HCV) and the immunity titers as the MMR/varicella set, and total
// anti-HAV is a hepatitis marker that reads as an immunity titer — belonging to
// neither list's author. FLAG_LOGIC_VERSION is again NOT bumped: the derivation logic
// is unchanged and the dataset half of the signature forces the one re-reconcile.
const FLAG_SIGNATURE_GOLDEN =
  // A SHA-256 content hash of the canonical dataset; provably synthetic.
  "b52823b75ec93baffdd0e521bdb2ba906b27b6c6972a01d91fde2aa82ba99b22"; // phi-scan-ok

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
