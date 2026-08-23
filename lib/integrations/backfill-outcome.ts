// THE PER-ITEM VERDICT a backfill run reaches about one candidate (#2196).
//
// A backfill's candidate query asks "what is still missing?" — it cannot ask "will
// asking again ever help?". Without that second question a candidate the source can
// never answer for stays in the set forever: the job computes `remaining > 0`, ends
// `failed`, and the progress bar says "N retrying" about work that will never
// succeed. Two DIFFERENT classes of candidate land there, and a rule keyed on HTTP
// failure alone only catches the first:
//
//   • the source refuses the row — a Strava activity deleted, or made private after
//     import, answers 404/403 forever;
//   • the source ANSWERS, with nothing — a 200-OK indoor/manual ride simply has no
//     telemetry, and re-asking returns the same empty payload at full API cost.
//
// So the verdict has two inputs, not one: this module owns the HTTP half, and the
// caller owns the "fetched fine, carries no payload" half. Both resolve to
// `unavailable`, which the runner subtracts from `remaining` so the job can finish.
//
// WHAT IS DELIBERATELY NOT HERE: any persisted give-up marker. The verdict is
// recomputed from the source's answer on every run, which costs the two requests per
// unavailable candidate that an explicit user retry spends — and buys back the two
// properties a stored marker would have cost:
//
//   • REVERSIBILITY. A ride made public again, a token re-authorized with
//     `activity:read_all`, or an upload Strava has since finished processing is
//     picked up by the next retry. A stored marker would refuse to look.
//   • NO SILENT ABANDONMENT ACROSS DEPLOYS. A verdict that turns out to be wrong is
//     wrong for one run, not for the life of the row.
//
// The cost is bounded by the thing this fixes: once a job reaches `completed`,
// nothing retries it automatically, so the re-ask happens only when a person asks.
//
// AMENDED BY #3037 (owner ruling, 2026-08-16), and the amendment KEEPS both
// properties above rather than trading them away. One class of candidate turned
// out to be permanent: a HAND-ENTERED or indoor session has no telemetry and never
// will, so "recompute the verdict every run" meant re-asking forever, at two
// requests each — ~800 a run on a profile with 400 of them, against Strava's
// 1000/day ceiling — while the badge could never reach zero. So the source's own
// answer IS now stored, on `activity_telemetry.answer`.
//
// What that does NOT do is give up: reversibility moved from "free on every run"
// to "explicit, and a person chooses" (`recheckStravaAnsweredSessions`), which is
// the same condition this module already names as making the re-ask affordable. And
// the marker is stricter than the recomputed verdict, per #3034 — it is written
// only from a settled answer, never from a transient failure, and the migration
// that added it deliberately left every pre-existing empty row UNCLASSIFIED rather
// than reading it as "nothing".
//
// The HTTP half below is unchanged: no 403/404/410 verdict is persisted anywhere.
//
// ---------------------------------------------------------------------------------
// #2385 — how this would learn it should stop:
//
//   WORKING: a profile holding a deleted/private ride or a telemetry-free indoor ride
//     reaches `status = completed` in a single run, with `failed_items` naming how
//     many, instead of sitting in `failed` while the bar reads "N retrying".
//   WRONG: rides that DO have streams stop arriving — `activity_telemetry` gains no
//     rows across a run that completes, or a manual retry of an already-completed job
//     immediately backfills several rides, which proves the previous run gave up on
//     candidates the source was willing to answer for.
//   DECEPTIVE SUCCESS: "stuck backfill jobs went to zero." An over-eager verdict
//     produces that number FASTER and more completely than a correct one, because it
//     also abandons rides a retry would have fetched — and a candidate wrongly called
//     unavailable is data silently never imported, which nothing else in the app will
//     ever complain about. The honest reading is the SHARE of attempted candidates
//     that come back `unavailable`, read together with whether retrying a completed
//     job still backfills anything. A rising unavailable share is the alarm, not the
//     applause.
// ---------------------------------------------------------------------------------

// `retryable`   — asking again may work: transient network, auth, or server trouble.
// `unavailable` — the source has given its final answer for this candidate.
export type BackfillItemVerdict = "retryable" | "unavailable";

// The statuses that mean "this resource is not yours to have", as opposed to "not
// right now". Kept deliberately narrow: the conservative direction is `retryable`,
// because a wrongly-retryable candidate is visible (the job stays `failed` and says
// so) while a wrongly-unavailable one is silent.
//
//   403 Forbidden — a private activity, or a token without `activity:read_all`.
//   404 Not Found — deleted upstream; Strava also answers 404 on `/streams` for an
//                   activity that has no recorded streams at all.
//   410 Gone      — the explicit tombstone.
//
// Everything else is retryable ON PURPOSE, including 400 (a malformed request is our
// own bug, and the fix is a deploy after which the retry works — so it should stay
// loudly `failed` rather than quietly disappear) and 401 (a dead token is a
// CONNECTION fact, not a fact about this candidate). 429 never reaches here: the
// caller pauses the whole job on a rate limit before it asks for a verdict, and this
// module answers `retryable` for it so a caller that forgets cannot lose the row.
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);

export function backfillFetchVerdict(status: number): BackfillItemVerdict {
  return UNAVAILABLE_STATUSES.has(status) ? "unavailable" : "retryable";
}
