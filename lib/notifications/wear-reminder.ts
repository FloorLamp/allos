// The GATHER half of the opt-in bedtime wear reminder (issue #2161) — DB reads → a
// rendered NotificationMessage, mirroring how mood.ts gathers for the check-in. The
// decision itself is pure and lives in lib/wear-reminder.ts; nothing here re-derives it.
//
// OFF BY DEFAULT and only ever turned on by a user action (`wear_reminder_enabled`,
// profile tier). Rides the profile's existing BEDTIME supplement slot, so it needs no
// schedule of its own, and dedupes per night on the tick's `notify_last_wear_reminder`
// marker. Sends go through dispatch()'s channels; nothing here touches telegram-api.
//
// ── The declared continuous stream ───────────────────────────────────────────
//
// One stream, declared rather than discovered: Health Connect's `hr_minutes`. It is the
// only continuous wear stream the app ingests — the sole other `hr_minutes` writer is
// the Fitbit Takeout archive import, which has no live cadence to be silent against and
// is therefore exempt BY CONSTRUCTION rather than by a special case. #2146 moves this
// declaration into the provider registry alongside `silenceToleranceMinutes`, where it
// belongs once a second provider needs one; keeping it here until then avoids inventing a
// registry facet that issue is specced to design.
//
// ── The three timestamp conventions, joined carefully ────────────────────────
//
// #2146 constraint 6 / #94 / #1333: `hr_minutes.ts` is PROFILE-LOCAL bare (no zone),
// `integration_sync_events.at` is UTC bare. This gather touches both, so it converts
// the stream's local wall time to a real instant through `zonedWallIsoToUtc` ONCE and
// compares everything in UTC from there. Reading `hr_minutes.ts` as UTC is exactly the
// #2096 failure class, and subtracting two bare local strings would also quietly report
// wall-clock difference rather than elapsed time on a DST night.

import { db } from "../db";
import { now } from "../clock";
import { dateStrInTz, utcSqlString, zonedWallIsoToUtc } from "../date";
import { getTimezone, getProfileWearReminder } from "../settings";
import { isSleepTracking } from "../sleep-summary";
import { getSyncedSleepWakeDays } from "../queries/sleep";
import { getIntegrationAttention } from "../queries/integrations";
import { HEALTH_CONNECT_ID } from "../integrations/health-connect";
import {
  BEDTIME_WEAR_TITLE,
  bedtimeWearBody,
  bedtimeWearVerdict,
  type BedtimeWearVerdict,
} from "../wear-reminder";
import type { NotificationMessage } from "./types";

/**
 * The provider whose continuous stream this reminder watches. A profile that has never
 * pushed Health Connect heart-rate minutes gets `no-stream` and no send, enabled or not.
 */
export const WEAR_STREAM_PROVIDER = HEALTH_CONNECT_ID;

/** The newest minute on the declared stream, profile-local bare, or null. */
function latestStreamMinute(profileId: number): string | null {
  const row = db
    .prepare(
      `SELECT MAX(ts) AS ts FROM hr_minutes
        WHERE profile_id = ? AND source = ?`
    )
    .get(profileId, WEAR_STREAM_PROVIDER) as { ts: string | null } | undefined;
  return row?.ts ?? null;
}

/** Did the provider record a SUCCESSFUL sync at or after `sinceUtc`? */
function syncedSince(profileId: number, sinceUtc: Date): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM integration_sync_events
        WHERE profile_id = ? AND provider = ? AND ok = 1 AND at >= ?
        LIMIT 1`
    )
    .get(profileId, WEAR_STREAM_PROVIDER, utcSqlString(sinceUtc)) as
    { hit: number } | undefined;
  return row != null;
}

/**
 * Tonight's verdict plus the copy ingredient, for the builder and for tests that want
 * to assert WHY nothing was sent rather than only that nothing was.
 */
export function bedtimeWearReminderState(
  profileId: number,
  at: Date = now()
): { verdict: BedtimeWearVerdict; lastSeenLocalHhmm: string | null } {
  // Consent first, and cheaply: a profile that never opted in pays one settings read
  // and nothing else, which is what "off is exactly today's behaviour" means in
  // practice as well as in the copy.
  const enabled = getProfileWearReminder(profileId);
  if (!enabled)
    return {
      verdict: bedtimeWearVerdict({
        enabled: false,
        expectedActive: false,
        providerHealthy: false,
        minutesSinceStream: null,
        syncedDuringGap: false,
      }),
      lastSeenLocalHhmm: null,
    };

  const tz = getTimezone(profileId);
  // The SHARED expected-active vocabulary (#2097), not a second one: is this profile
  // recording sleep at all? `getSyncedSleepWakeDays` deliberately counts only nights a
  // SYNCING source wrote, so a manual-only sleep logger is never reminded about a
  // device they do not wear.
  const localToday = dateStrInTz(tz, at);
  const expectedActive = isSleepTracking(
    getSyncedSleepWakeDays(profileId, localToday),
    localToday
  );

  // Yields to the bigger problem (#1685): while the provider is failing or stale a
  // reconnect item already owns the contact, and "still on the charger?" would be
  // false advice with the pipeline down.
  const providerHealthy = !getIntegrationAttention(profileId).some(
    (row) => row.id === WEAR_STREAM_PROVIDER
  );

  const latest = latestStreamMinute(profileId);
  const latestUtc = latest ? zonedWallIsoToUtc(tz, latest) : null;
  const minutesSinceStream =
    latestUtc == null
      ? null
      : Math.floor((at.getTime() - latestUtc.getTime()) / 60_000);

  return {
    verdict: bedtimeWearVerdict({
      enabled,
      expectedActive,
      providerHealthy,
      minutesSinceStream,
      // Only asked once there is a gap to ask about; an absent stream short-circuits
      // in the pure decision before this value is read.
      syncedDuringGap:
        latestUtc == null ? false : syncedSince(profileId, latestUtc),
    }),
    lastSeenLocalHhmm: latest ? latest.slice(11, 16) : null,
  };
}

/**
 * Build tonight's reminder, or null when it must not send. Null covers every skip
 * reason equally — the tick's dueSlots loop treats it as "nothing due" and, crucially,
 * leaves the per-day marker unset, so a night that skipped never spends the cadence.
 *
 * No actions: the message carries its whole meaning as words, so Web Push and Email can
 * deliver it truthfully (the #1718 channel-honesty rule — a builder's copy must never
 * reference an affordance the channel strips).
 */
export function buildWearReminder(
  profileId: number
): NotificationMessage | null {
  const { verdict, lastSeenLocalHhmm } = bedtimeWearReminderState(profileId);
  if (!verdict.send || lastSeenLocalHhmm == null) return null;
  return {
    title: BEDTIME_WEAR_TITLE,
    body: bedtimeWearBody(lastSeenLocalHhmm),
    kind: "wear-reminder",
  };
}
