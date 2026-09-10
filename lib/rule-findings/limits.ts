// The per-family generation limits the coaching collection applies (#2962).
//
// A cap is a COLLECTION contract, not a builder detail — it bounds a fan-out family
// BEFORE shared suppression is applied — so it lives beside the registry rather than in
// any one domain module, and the domain builders that fan out read it from here.

// Profile-owned entities can grow without bound; dashboard findings cannot. Each
// fan-out family declares its generation limit here, before shared suppression is
// applied. That ordering is the important contract: dismissing the visible set does
// not promote a fresh set from the same family.
export const COACHING_ENTITY_FINDING_LIMITS = {
  medicationDuplication: 3,
  staleExerciseNames: 3,
  trainingPlateau: 3,
  bodyHygiene: 3,
  endurancePlan: 3,
  prolongedBleeding: 1,
  goalPacing: 3,
  adherencePattern: 3,
  demotionSuggestion: 3,
  targetRightSize: 3,
} as const;
