// The one-shot ease-back re-entry nudge on illness-episode close (issue #837).
//
// During an open flagged-illness episode the workout-reminder slot goes quiet
// (recommend.ts) and the coaching gap/pace nags are held (coaching engine). When the
// episode closes, the first waking tick sends ONE gentle "ease back in" note — a
// light session or easy Zone 2 as a re-entry, never a push to resume full volume.
//
// One-shot discipline (marker per episode, #203-keyed by the episode row id — ids
// never recycle so an id-keyed marker is safe and needs no name re-key/cleanup):
//   - notify_ease_back_<episodeId> is set (to the send date) once the nudge is
//     delivered, and it never re-fires for the SAME episode.
//   - A NEW episode (a distinct id) gets its own fresh one-shot on its own close.
// The pure decision (open → held, recently-closed → ease-back ramp) is
// illnessCoachingMode in the coaching engine — the SAME computation the dashboard
// card and the workout slot read, so the surfaces can't drift (#221).

import {
  easeBackRecommendation,
  illnessCoachingMode,
  type CoachingInput,
} from "../coaching";
import {
  getProfileSetting,
  setProfileSetting,
  getPublicUrl,
} from "../settings";
import { dispatch } from "./index";
import type { NotificationAction, NotificationMessage } from "./types";
import { createLogger } from "../log";

const log = createLogger("notify");

// The per-episode one-shot marker (profile_settings key). The episode row id is a
// stable AUTOINCREMENT id, so this key never collides across episodes and never
// needs re-keying on rename (unlike a name-keyed marker, the #203 rule).
export const EASE_BACK_MARKER_PREFIX = "notify_ease_back_";
export function easeBackMarkerKey(episodeId: number): string {
  return `${EASE_BACK_MARKER_PREFIX}${episodeId}`;
}

// Render the ease-back message from the SAME recommendation the read surfaces show,
// so the push and the dashboard card carry identical copy (#221). A deep-link to the
// training page rides along when a public URL is configured (informational, no
// callback — resuming training is a decision, not a one-tap state change).
export function renderEaseBackMessage(
  profileName: string,
  deepLinkBase = ""
): NotificationMessage {
  const rec = easeBackRecommendation();
  const who = profileName ? ` — ${profileName}` : "";
  const base = deepLinkBase.replace(/\/$/, "");
  const actions: NotificationAction[] | undefined = base
    ? [{ label: rec.actionLabel ?? "Open training", url: `${base}/training` }]
    : undefined;
  return {
    title: `🌤️ Ease back in${who}`,
    body: rec.detail,
    actions,
    kind: "ease-back",
  };
}

// Send the one-shot ease-back nudge for a profile if an episode has just closed and
// the nudge hasn't already fired for that episode. Returns whether a send failed
// (aggregated into the tick's exit code). Never throws for an ordinary send failure.
// `input` is the tick's once-per-profile coaching gather (shared with the workout
// slot + rest-episode reconcile); `date` is the profile-local date (marker value).
export async function runEaseBack(
  profileId: number,
  profileName: string,
  input: CoachingInput,
  date: string
): Promise<{ failed: boolean }> {
  const { mode, easeBackEpisodeId } = illnessCoachingMode(
    input.illness,
    input.today
  );
  if (mode !== "ease-back" || easeBackEpisodeId == null)
    return { failed: false };

  const markerKey = easeBackMarkerKey(easeBackEpisodeId);
  // One-shot: already fired for this episode → never re-fire.
  if (getProfileSetting(profileId, markerKey) != null) return { failed: false };

  const results = await dispatch(
    profileId,
    renderEaseBackMessage(profileName, getPublicUrl())
  );
  if (results.length === 0) {
    // No channel configured — leave the marker unset so it can fire once configured.
    log.info("ease-back nudge skipped: no channel", { profile: profileId });
    return { failed: false };
  }
  const delivered = results.some((r) => r.ok);
  const failed = results.some((r) => !r.ok);
  if (delivered) {
    setProfileSetting(profileId, markerKey, date);
    log.info("ease-back nudge sent", {
      profile: profileId,
      episode: easeBackEpisodeId,
    });
  }
  return { failed };
}
