// Health Connect metric policy used by both payload ingest and migration-time overlap
// repair. Keep this module dependency-free: lib/db.ts loads every migration at startup,
// and a migration importing the full parser would make every DB test worker transform
// the parser's application-sized dependency graph.

// A daily-stored additive metric arriving in windows an hour or narrower is a
// fine-grained exporter setting. The parser uses this to warn about a wrong setting;
// the overlap rule uses the same boundary to keep sub-daily readings out of reach.
export const SUB_DAILY_WINDOW_MAX_MIN = 60;

// THE METRICS WHOSE WINDOWS TILE BY CONSTRUCTION — the only ones #3424's overlap
// supersede may delete a row of. These are exactly the additive interval types checked
// by Health Connect's fine-grained-setting detector, expressed as emitted metric names.
// Nutrition, hydration and sleep are absent on purpose: their real windows can nest.
//
// HYDRATION WAS RE-EXAMINED AND STAYS OUT (#3448). The granularity gate is sixty
// minutes, while AndroidX permits a drink logged across a longer window, so adding it
// would erase a legitimate nested drink. The real-ingest cases live in
// lib/__db_tests__/hydration-day-bucket-3448.test.ts.
export const DAY_BUCKET_METRICS: ReadonlySet<string> = new Set([
  "steps",
  "distance_km",
  "active_kcal",
  "total_kcal",
]);
