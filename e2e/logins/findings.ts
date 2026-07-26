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
