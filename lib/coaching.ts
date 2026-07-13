// Training coaching barrel: turn logged history into a concrete next-set target
// (double progression), detect personal records to celebrate, and run the
// deterministic "one clear thing to do today" recommender. Implementation lives
// in domain submodules under lib/coaching/ (#597); this file re-exports them so
// import paths and export names are unchanged. Pure and client-safe.
export * from "./coaching/strength";
export * from "./coaching/cardio";
export * from "./coaching/engine";
// The variety window's single definition lives with the unified next-workout
// core (#221); re-exported here so existing importers keep working.
export { VARIETY_LOOKBACK_DAYS } from "./workout-recommendation";
