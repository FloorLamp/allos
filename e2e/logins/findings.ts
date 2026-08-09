// Shared credential + fixture-profile names for the e2e findings fixtures. Composed
// into e2e/fixture-logins.ts (which every spec and seeder still imports from) —
// see that file's header for the rules these constants live under. Add a login or
// fixture-profile name for THIS domain here, beside the fixtures that use it.

// #1151 — the aggregated Upcoming "Snoozed & dismissed" section. A dedicated
// adult profile carrying one suppression from each class the section now spans:
// a CARE snooze (a future appointment), a COACHING dismissal (a training-obs
// plateau key), and a SUGGESTION dismissal (a med-bridge key with no backing
// record — the shape a pre-092 dismissal leaves behind, labelled purely from
// its key, #1232). Isolated on purpose: the spec restores/clears
// suppression rows (and resets them itself), which on profile 1 would race the
// needs-attention/coaching specs' bus reads.
export const E2E_LOGIN_SUPPRESSED = "e2e_suppressed";
export const SUPPRESSED_PROFILE = "Suppressed Center (e2e)";

// #1119 — progress photos. A dedicated adult profile the progress-photos spec
// captures into (via the PhotoCapture fallback file input) and CLEANS ITSELF
// (it deletes the profile's progress_photos rows at spec start), so the
// data-gated "Progress photos" nav entry flips within its OWN sidebar — and the
// shared admin session's exact top-level order (nav-consolidation.spec.ts,
// which enumerates profile 1's sidebar verbatim) never changes.
export const E2E_LOGIN_PHOTOS = "e2e_photos";
export const PROGRESS_PHOTOS_PROFILE = "Progress Photos (e2e)";

// #1224 — video capture. A dedicated ADULT profile (birthdate seeded, so /training
// isn't age-gated) carrying ONE seeded strength activity the video spec attaches a
// form-check clip to, and its own episode/symptom surfaces. The spec CLEANS ITSELF
// (deletes the profile's activity_videos / symptom_videos rows at spec start), so
// its clip counts stay isolated from profile 1 and the shared admin sidebar.
export const E2E_LOGIN_VIDEO = "e2e_video";
export const VIDEO_PROFILE = "Video Capture (e2e)";

// #1172 — the Open-Meteo weather/UV integration + the two-sided UV-dose sun model.
// A dedicated adult profile seeded with a home location, Fitzpatrick skin type,
// the weather connection ENABLED, an outdoor daytime activity today, and cached
// live UV for that day+location — so the weather spec can assert the integration
// page's connected state AND the timeline's live UV badge without touching profile
// 1's shared timeline/integration surfaces (whose exact state other specs pin).
// Isolated on purpose: the spec toggles the weather connection (enable/disable),
// which on profile 1 would race the review-inbox/integration specs.
export const E2E_LOGIN_WEATHER = "e2e_weather";
export const WEATHER_PROFILE = "Weather (e2e)";

// #2353 — goal pacing (#45 domain 6). A dedicated adult profile carrying its OWN
// weight series and its OWN off-pace weight goal, so the goal-pacing finding is
// asserted against data no other spec can reach. It used to be asserted on profile
// 1 against the base seed's "Reach 74 kg" / "Cut to 78 kg" goals, and profile 1's
// weight series is shared: any earlier test in the same worker that logs a weight
// (palette-actions' "Log weight" saves 72.5 kg) re-fits the projection, both goals
// then read as reaching early, and the card stops rendering. That made the failure
// depend on the SHARD ORDER — adding any spec file anywhere moved a weight-logging
// test ahead of it and reddened an innocent PR. A test owns its fixture data.
export const E2E_LOGIN_GOAL_PACE = "e2e_goal_pace";
export const GOAL_PACE_PROFILE = "Goal Pacing (e2e)";

// #2177 — the paired-observations registry. A dedicated ADULT profile carrying
// #2177's own motivating fixture: 30 evenings, 21 with a standard drink logged and 9
// without, each with the overnight HRV recorded on the morning after. Its own profile
// because the pair's arms are computed over the WHOLE 90-day window: any other spec
// logging a drink or an HRV reading on a shared profile would move both means, and a
// finding whose numbers the spec asserts must own every row behind them. Read-only in
// the spec apart from a dismissal it resets itself. Synthetic, no PHI.
export const E2E_LOGIN_PAIRED_OBS = "e2e_paired_obs";
export const PAIRED_OBS_PROFILE = "Paired Observations (e2e)";
