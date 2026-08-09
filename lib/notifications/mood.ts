// The opt-in daily mood check-in (issue #992). This is the GATHER half (DB reads →
// a rendered NotificationMessage), mirroring how food.ts gathers for the food
// nudge. OFF by default (mood_checkin_enabled, per profile); rides the profile's
// EVENING supplement slot hour (wired in scripts/notify.ts) so it needs no
// schedule of its own; deduped per day by the tick's notify_last_mood_checkin
// marker.
//
// ENGAGEMENT-AWARE (product-decided): the pure shouldSendMoodCheckin gate
// (lib/mood.ts) holds the check-in once MOOD_CHECKIN_AUTOPAUSE_DAYS consecutive
// sends went unanswered — it must never nag someone who's disengaged. Every
// submitted check-in (any write path — the card, offline replay, a Telegram tap)
// resets the counter via upsertMoodLog, which re-arms it. Pausing is the ONLY
// behavior: a low answer or a long silence never escalates anything (#992's hard
// contract — the daily layer never editorializes).
//
// The Telegram keyboard is the food-nudge one-tap pattern: five face buttons,
// each an idempotent per-day mood log (the two-way principle — an existing
// idempotent server function, ids only in the token). Sends go through
// dispatch()'s channels; nothing here touches telegram-api (the chokepoint rule).

import { getMoodOnDate } from "../queries";
import { getProfileMoodCheckin, getMoodCheckinIgnored } from "../settings";
import {
  isFinalMoodCheckin,
  shouldSendMoodCheckin,
  MOOD_CHECKIN_PAUSE_NOTICE,
  MOOD_FACES,
  MOOD_LABELS,
} from "../mood";
import type { NotificationAction, NotificationMessage } from "./types";
import { GLYPH } from "./glyphs";

// The callback token for one face tap: "mood:<profileId>:<valence>:<date>".
// Carries ids/values only; the handler re-resolves the acting profile from the
// chat and runs the same upsertMoodLog core as every other write path.
export function moodCheckinCallbackData(
  profileId: number,
  valence: number,
  date: string
): string {
  return `mood:${profileId}:${valence}:${date}`;
}

// The "keep these coming" token (#1668): "moodkeep:<profileId>:<date>". Ids only, like
// every other callback. Tapping it resets the ignored streak — the SAME write logging a
// mood performs, so there is one mechanism behind three entry points (a logged mood,
// this button, and the in-app Resume action).
export function moodKeepCallbackData(profileId: number, date: string): string {
  return `moodkeep:${profileId}:${date}`;
}

// Build the day's check-in, or null when it shouldn't send: opt-in off, already
// logged today (nothing to ask), or auto-paused after too many ignored days.
export function buildMoodCheckin(
  profileId: number,
  date: string
): NotificationMessage | null {
  const ignoredCount = getMoodCheckinIgnored(profileId);
  const send = shouldSendMoodCheckin({
    enabled: getProfileMoodCheckin(profileId),
    alreadyLoggedToday: getMoodOnDate(profileId, date) != null,
    ignoredCount,
  });
  if (!send) return null;
  // The send that will EXHAUST the streak announces the pause (#1668) — ride the nag,
  // zero additional sends. Ignoring it lets the pause proceed exactly as before, now as
  // informed silence rather than reminders that appear to have broken.
  const final = isFinalMoodCheckin(ignoredCount);

  const actions: NotificationAction[] = MOOD_FACES.map((face, i) => ({
    label: `${face} ${MOOD_LABELS[i]}`,
    data: moodCheckinCallbackData(profileId, i + 1, date),
    // One row of five compact buttons.
    row: "mood",
  }));

  if (final) {
    actions.push({
      label: "Keep daily check-ins",
      data: moodKeepCallbackData(profileId, date),
      row: "mood-keep",
    });
  }

  return {
    title: `${GLYPH.mood} How are you today?`,
    // Gentle, optional, zero-pressure copy — skipping is always fine.
    body: final
      ? `One tap logs your day — or just skip this. You can add detail any time from the dashboard.\n${MOOD_CHECKIN_PAUSE_NOTICE}`
      : "One tap logs your day — or just skip this. You can add detail any time from the dashboard.",
    actions,
    kind: "mood",
  };
}
