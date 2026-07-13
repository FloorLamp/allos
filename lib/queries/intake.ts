// Re-export barrel for the intake (supplements & medications) query domain.
// Same #126 treatment training got: the implementation is split into modules
// under lib/queries/intake/*; this file preserves the historical import surface
// (everything is still re-exported from @/lib/queries). Every export keeps its
// original name and signature.
export * from "./intake/schedule";
export * from "./intake/refill";
export * from "./intake/adherence";
export * from "./intake/pairs";
export * from "./intake/warnings";
export * from "./intake/medications";
export * from "./intake/insights";
export * from "./intake/safety";
