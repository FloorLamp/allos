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
  {
    file: "lib/fast-write.ts",
    gate: "fastAdultOnlyRefusal",
    // THE REGISTRY'S FIRST EXEMPTIONS. The test they have to pass is not "does this
    // function INSERT" — it is "can this function leave the profile with an ACTIVE fast
    // it did not have". `ended_at IS NULL` IS the active state, so a core that clears
    // that column causes an active fast to exist without inserting anything, and reading
    // the gate as an insert-guard is exactly how a hole opens. Both entries below
    // STRICTLY REDUCE fasting state and have no input that could make them enlarge it.
    // `reopenFast` was on this list and is not any more, for precisely that reason.
    exempt: [
      {
        fn: "endFast",
        why: "#2756 owner ruling: starts refuse, ending an existing active fast ALWAYS succeeds. A birthdate edit that makes a profile restricted MID-FAST must not leave an active row nobody can close — that would strand the profile permanently mid-fast, with its food nudges stood down by #2757 and no affordance anywhere to fix it, which is a worse outcome for the same person the gate exists to protect. Closing out is harm-reduction, not tracking: it moves a fast from active to completed, so the count of active fasts strictly decreases and no input can make it do otherwise. The bounding evidence is `startFast` and `reopenFast` beside it, both GATED and both reachable from real surfaces — that is what makes this an asymmetry rather than a hole.",
      },
      {
        fn: "discardFast",
        why: "#2756: 'I never actually fasted' — the stale suggest's second resolution, a row DELETE. Same harm-reduction reasoning as endFast, and the strongest case of it: this is the path that removes fasting data entirely, so refusing it for a restricted profile would keep the very content the gate exists to withhold. A gate here would protect nothing and lock in a row.",
      },
    ],
    why: "#2756: fasting is an eating-restriction tracker, and on a known-minor profile that is eating-disorder-adjacent — a safety question, not a preference. Gated on the #1174/#2107 pattern: hiding the /nutrition surface is theater because the Server Actions are independently POST-callable, so the refusal lives in the CORE and a refused start answers exactly as an unknown row does. The line is lib/life-stage's own `isMinor` (age < 18) rather than a fresh constant, and unknown age PASSES per that module's documented positive-match-only policy. The two exemptions above are the ruling's deliberate asymmetry, not gaps: the criterion is whether a core can leave the profile with an ACTIVE fast it did not have, and both of them strictly reduce fasting state instead. `reopenFast` fails that criterion — clearing `ended_at` IS how an active fast comes to exist — so it is gated alongside `startFast`.",
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
