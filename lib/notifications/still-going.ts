// ONE "STILL GOING?" FAMILY FOR EVERY OPEN EPISODE (#5142 AC 3).
//
// The workout draft had this nudge on its own (#560, #1205): quiet past its bound,
// one gentle question, two buttons that resolve it in place, and never an automatic
// end. The practice kind wanted the same question, and the cheap way to give it one
// would have been a second renderer, a second token pair, a second marker discipline
// and a second handler — four copies of a question this app asks once.
//
// So the KIND is a parameter, not a module. What differs per kind is exactly what
// should: the sentence, the label on the finish button, and which surface the
// deep-link opens. What does not differ is the shape — one message, one one-shot
// marker keyed by row id, one suggest that never ends anything by itself (#560).
//
// The kinds here are the two the app can ACT on from a chat. A fast has its own
// lifecycle and its own nudge (#2756), and the night the app is waiting for is a
// bounded arrival rather than a quiet timer (#5001); neither is a button a person
// can press to say "yes, still going", which is what this family is.

import { dateStrInTz } from "../date";
import { now as clockNow } from "../clock";
import { getWorkoutPresence } from "../queries/presence";
import { stalePracticeSessions } from "../practice-log";
import {
  getProfileSetting,
  setProfileSetting,
  getPublicUrl,
  getTimezone,
} from "../settings";
import { formatMinutes } from "../duration";
import { dispatch } from "./index";
import { stillGoingCallback, type StillGoingKind } from "./callback-data";
import type { NotificationAction, NotificationMessage } from "./types";
import { createLogger } from "../log";
import { GLYPH } from "./glyphs";

const log = createLogger("notify:still-going");

// THE WORKOUT KIND KEEPS THE KEY IT ALREADY HAD, and that is the whole reason this is
// a function with two literals rather than one template. A draft that was nudged an
// hour before this shipped has `notify_stale_workout_<id>` written against it; a
// renamed key would read as "never nudged" and ask the same question twice about the
// same session. Ids never recycle (AUTOINCREMENT, #203), so a marker left behind by a
// closed row is a harmless dead setting.
export const STALE_WORKOUT_MARKER_PREFIX = "notify_stale_workout_";
export const STALE_PRACTICE_MARKER_PREFIX = "notify_stale_practice_";

export function stillGoingMarkerKey(
  kind: StillGoingKind,
  rowId: number
): string {
  const prefix =
    kind === "workout"
      ? STALE_WORKOUT_MARKER_PREFIX
      : STALE_PRACTICE_MARKER_PREFIX;
  return `${prefix}${rowId}`;
}

// What the nudge needs to know about one open episode, whatever kind it is.
export interface StillGoingEpisode {
  kind: StillGoingKind;
  rowId: number;
  // The practice's own name. A workout draft has no name a person would recognise
  // here — the dock says "workout" — so it states the kind instead.
  label: string | null;
  // Quiet in minutes, where the domain measures it. Null when the domain does not
  // report one and the copy therefore does not quote one.
  quietMin: number | null;
}

// The message. Two buttons that RESOLVE the episode in place (the two-way principle —
// one idempotent, low-risk state change through the shared cores each domain already
// exposes; the tokens carry ids only), plus the deep-link that non-Telegram channels
// fall back to because they cannot do a stateful callback.
export function renderStillGoingMessage(
  episode: StillGoingEpisode,
  profileId: number,
  profileName: string,
  deepLinkBase = ""
): NotificationMessage {
  const who = profileName ? ` — ${profileName}` : "";
  const base = deepLinkBase.replace(/\/$/, "");
  const practice = episode.kind === "practice";
  const quiet =
    episode.quietMin == null ? null : formatMinutes(episode.quietMin);

  const actions: NotificationAction[] = [
    {
      label: `${GLYPH.finish} ${practice ? "Finish" : "Finish workout"}`,
      data: stillGoingCallback(
        episode.kind,
        profileId,
        episode.rowId,
        "finish"
      ),
      row: "finish",
    },
    {
      label: `${GLYPH.discarded} Discard`,
      data: stillGoingCallback(
        episode.kind,
        profileId,
        episode.rowId,
        "discard"
      ),
      row: "finish",
    },
  ];
  if (base)
    actions.push({
      label: practice ? "Open practice" : "Open workout",
      url: `${base}${practice ? "/wellness" : "/training"}`,
    });

  return {
    title: practice
      ? `${GLYPH.inProgress} Still doing ${episode.label ?? "your practice"}?${who}`
      : `${GLYPH.inProgress} Still working out?${who}`,
    body: practice
      ? `${quiet ? `Running for ${quiet}` : "Still running"} and nothing since. Finish it or discard — nothing was ended automatically.`
      : "Your session has been quiet for a while. Finish it or discard the draft — nothing was ended automatically.",
    actions,
    kind: "other",
  };
}

// Every open episode this profile holds that has gone quiet past its own kind's stale
// bound. Both domains answer from the SAME model (#5142), so the bound the nudge
// honours and the bound the sweep honours cannot drift apart.
export function stillGoingEpisodes(
  profileId: number,
  now: Date
): StillGoingEpisode[] {
  const out: StillGoingEpisode[] = [];
  const presence = getWorkoutPresence(profileId, now);
  if (
    presence.state === "active" &&
    presence.stale &&
    presence.activityId != null
  )
    out.push({
      kind: "workout",
      rowId: presence.activityId,
      label: null,
      // Workout presence reports elapsed-since-start, not quiet, and the two are
      // different quantities on a draft that saved a set an hour in. The copy says
      // "quiet for a while" rather than inventing a number from the wrong one.
      quietMin: null,
    });
  for (const session of stalePracticeSessions(profileId, now))
    out.push({
      kind: "practice",
      rowId: session.id,
      label: session.practice,
      quietMin: session.quietMin,
    });
  return out;
}

// ONE gentle suggest per stale episode, keyed by row id. Never auto-ends (#560).
// Returns failed for the tick's exit code; never throws for a send failure.
export async function runStillGoingSuggest(
  profileId: number,
  profileName: string,
  now: Date = clockNow()
): Promise<{ failed: boolean }> {
  let failed = false;
  for (const episode of stillGoingEpisodes(profileId, now)) {
    const markerKey = stillGoingMarkerKey(episode.kind, episode.rowId);
    if (getProfileSetting(profileId, markerKey) != null) continue;

    // The DATE THE NUDGE WAS SENT ON, resolved from this run's own instant rather than
    // from the clock (#5249 review). It is invisible under the hourly tick, where the
    // two are the same instant — but a caller that passes a `now` is stating which
    // moment it means, and reading the clock instead would key the marker to a
    // different day than the one the episode was judged against.
    const date = dateStrInTz(getTimezone(profileId), now);
    const results = await dispatch(
      profileId,
      renderStillGoingMessage(episode, profileId, profileName, getPublicUrl())
    );
    if (results.length === 0) continue;
    if (results.some((r) => !r.ok)) failed = true;
    if (results.some((r) => r.ok)) {
      setProfileSetting(profileId, markerKey, date);
      log.info("still-going suggest sent", {
        profile: profileId,
        kind: episode.kind,
        row: episode.rowId,
      });
    }
  }
  return { failed };
}
