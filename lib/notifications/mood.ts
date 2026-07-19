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
import { shouldSendMoodCheckin, MOOD_FACES, MOOD_LABELS } from "../mood";
import type { NotificationAction, NotificationMessage } from "./types";

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

// Build the day's check-in, or null when it shouldn't send: opt-in off, already
// logged today (nothing to ask), or auto-paused after too many ignored days.
export function buildMoodCheckin(
  profileId: number,
  date: string
): NotificationMessage | null {
  const send = shouldSendMoodCheckin({
    enabled: getProfileMoodCheckin(profileId),
    alreadyLoggedToday: getMoodOnDate(profileId, date) != null,
    ignoredCount: getMoodCheckinIgnored(profileId),
  });
  if (!send) return null;

  const actions: NotificationAction[] = MOOD_FACES.map((face, i) => ({
    label: `${face} ${MOOD_LABELS[i]}`,
    data: moodCheckinCallbackData(profileId, i + 1, date),
    // One row of five compact buttons.
    row: "mood",
  }));

  return {
    title: "How are you today?",
    // Gentle, optional, zero-pressure copy — skipping is always fine.
    body: "One tap logs your day — or just skip this. You can add detail any time from the dashboard.",
    actions,
    kind: "mood",
  };
}
