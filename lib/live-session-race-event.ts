// The one string the live-workout editor and its browser guard both have to know
// (#3441), in a module with NO IMPORTS AT ALL — and that emptiness is the point,
// not an accident of a small file.
//
// WHY IT IS NOT DECLARED BESIDE THE CODE THAT LOGS IT. `e2e/*.spec.ts` files are
// IMPORTED, not run, by `playwright test --list`, and `scripts/e2e-shard-plan.ts
// --verify` parses that listing's JSON off stdout to build CI's duration-balanced
// shards. So anything a spec imports is loaded in the listing process too. Importing
// the constant from `components/activity-form/useActivityAutosave.ts` pulls in the
// Server Action module, and through it `lib/db` — which opens the database and runs
// migrations, printing `INFO [migrate] …` onto the very stdout the verifier is
// parsing. The shard plan then dies on `Unexpected non-whitespace character after
// JSON at position 4`, in a job whose name gives no hint that a spec's import is the
// cause. Measured on this branch's first CI round.
//
// `lib/live-workout.ts` is no better: it reaches `lib/db` transitively through
// coaching → lifts → units → settings. A leaf module is the only shape that is safe,
// so keep this file importing nothing.
//
// WHAT IT IS FOR: the editor announces this when a rowless auto-save comes due while
// a live session's create-at-start POST is still in flight — the window in which one
// session used to become two activities. `e2e/workout-discard-settles.spec.ts` holds
// the start POST until it hears this line, so the race is DRIVEN rather than sampled
// and no timing constant is needed anywhere in the spec.
export const LIVE_CREATE_RACE_EVENT = "live-session-create-outran-save";
