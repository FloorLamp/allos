// WHICH CANONICAL NAMES ARE A BLOOD-PRESSURE COMPONENT.
//
// Split out of lib/bp-percentiles.ts (#2794) so the question "is this reading a BP
// component?" can be asked without importing the AAP normative dataset. The flag
// core (lib/reference-range/flags.ts) has to ask it on every numeric row, and that
// module is reached from client components through components/ui.tsx — pulling a
// percentile table into that graph to answer a two-key lookup would be a bundle
// cost for nothing. lib/bp-percentiles.ts re-exports both symbols, so every existing
// import path is unchanged and there is still ONE marker list.
//
// Pure, no imports.

export type BpComponent = "systolic" | "diastolic";

// The canonical biomarker names carrying pediatric BP interpretation. Must match
// the canonical_result_definitions rows / vitals-input canonical names byte-for-byte.
const MARKER_COMPONENT: Record<string, BpComponent> = {
  "Blood Pressure Systolic": "systolic",
  "Blood Pressure Diastolic": "diastolic",
};

// Which BP component a canonical biomarker name is, or null when it isn't a BP
// marker. Drives whether a detail surface shows the pediatric BP card, and whether
// the flag core defers to that card instead of judging against the adult band.
export function bpComponentFor(name: string): BpComponent | null {
  return MARKER_COMPONENT[name] ?? null;
}
