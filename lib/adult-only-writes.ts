// Adult-only write-gate registry (issue #2107) — the enforcement half of #1279.
//
// WHAT #1279 ESTABLISHED. Some content is adult-only by product ruling (today:
// substance use, #1174). Hiding the surface is not the gate, because a Server Action
// is independently POST-callable — "a UI-only gate is theater if the write core
// underneath has no independent check". So every substance-use action re-checks life
// stage at the auth boundary.
//
// WHY THAT WASN'T ENOUGH. The instrument write cores are SHARED between the
// mental-health (#716) and substance-use (#998) catalogs, and update/delete resolve
// their instrument from the TARGETED ROW rather than from an argument. The
// mental-health twins called those same cores with no life-stage check, so posting
// them with a substance-instrument row id edited or deleted precisely the scores
// #1279 refuses to touch. A gate one write path skips is worse than no gate: the
// surface reports a protection it does not have.
//
// THE SHAPE OF THE FIX. The refusal moved INTO the core, keyed on the instrument the
// core actually operates on. That protects callers that do not exist yet, which
// narrowing the two known callers would not have. This registry is what keeps it
// true: for every module listed here, the scan in
// lib/__tests__/adult-only-writes-scan.test.ts requires that EVERY exported function
// which mutates also calls the declared gate. A new export that writes without asking
// fails CI on its own name.
//
// Precedents for the shape: STATEFUL_WRITE_TABLES (lib/stateful-writes.ts),
// CROSS_PROFILE_SQL_MODULES (lib/cross-profile.ts), SEND_MARKER_REGISTRY
// (lib/notifications/send-markers.ts).
//
// THE BOUNDARY, STATED HONESTLY. This registry guards the gated CORES. It does not
// and cannot prove that no other module reaches the underlying rows with raw SQL —
// instrument scores are `medical_records` rows, a table with hundreds of legitimate
// writers, so a table-level chokepoint list like STATEFUL_WRITE_TABLES' is not
// available here. What it does guarantee is that the shared cores every surface
// actually uses cannot grow a write path that skips the gate.
//
// This module is PURE on purpose (no db import): the scan runs in the pure tier.

export interface AdultOnlyWriteCore {
  // Repo-relative path of the module whose exported writes must be gated.
  file: string;
  // The gate function every mutating export in that module must call. Matched as a
  // call expression on the callee's name, so renaming the gate without updating the
  // registry fails the scan rather than silently disabling it.
  gate: string;
  // Exported functions in the module that mutate but legitimately do NOT call the
  // gate. Keep EMPTY where possible — an entry here is the exact shape of defect
  // #2107 was, so it has to be argued in writing.
  exempt: readonly { fn: string; why: string }[];
  why: string;
}

export const ADULT_ONLY_WRITE_CORES: readonly AdultOnlyWriteCore[] = [
  {
    file: "lib/instrument-records.ts",
    gate: "adultOnlyRefusal",
    exempt: [],
    why: "#2107: recordInstrumentScore / updateInstrumentScore / deleteInstrumentScore serve BOTH the mental-health and substance-use catalogs, and the two row-resolving cores learn their instrument from the stored row — so the calling surface's family is no evidence at all about what is being written. Each core asks adultOnlyRefusal() about the instrument it resolved and answers a refused one exactly as it answers an unknown row (null / not-found), which is also what the substance surface's own minor path returns.",
  },
];

// Markers that make an exported function a WRITE for the scan's purposes. A function
// containing none of these is a read and needs no gate.
export const ADULT_ONLY_MUTATION_MARKERS: readonly string[] = [
  "writeTx",
  "captureDelete",
  "INSERT INTO",
  "UPDATE ",
  "DELETE FROM",
];
