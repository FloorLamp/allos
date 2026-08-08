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
// The stream is no longer named here. #2146 moved the declaration into the provider
// registry (`continuousStreams`, with `reminder: "bedtime-wear"` on the entry this
// watches), so `streamsWithReminder` below IS the binding: which provider, which
// table, and — through the shared reader — how its timestamps are read. A second
// wearable becomes a registry entry rather than an edit here.
//
// The sole other `hr_minutes` writer, the Fitbit Takeout archive import, declares no
// continuous stream at all: it has no live cadence to be silent against, so it is
// exempt BY CONSTRUCTION rather than by a special case.
//
// ── The timestamp convention, read from its declaration ──────────────────────
//
// This module used to convert `hr_minutes.ts` with `zonedWallIsoToUtc`, because that
// column WAS a profile-local wall clock (#94/#1333). Migration 164 made it a canonical
// UTC instant, and `zonedWallIsoToUtc` refuses a stamp carrying `Z` — so the
// conversion silently returned null, `minutesSinceStream` was always null, and the
// verdict was permanently `no-stream`. The reminder could not fire at all. Its DB test
// stayed green because its fixture wrote the retired shape.
//
// The fix is not a different hard-coded conversion, it is not hard-coding one:
// `latestStreamInstant` (lib/queries/continuous-streams.ts) resolves the column
// through lib/time-columns.ts's declaration of what it means, so the next conversion
// moves this reader with it. That is exactly the #2096 failure class #2146 constraint
// 6 names, caught in the module #2146 was told to unify with.

import { now } from "../clock";
import { dateStrInTz, parseUtcSql, zonedDateParts } from "../date";
import { getTimezone, getProfileWearReminder } from "../settings";
import { isSleepTracking } from "../sleep-summary";
import { getSyncedSleepWakeDays } from "../queries/sleep";
import { getIntegrationAttention } from "../queries/integrations";
import {
  latestOkSyncInstant,
  latestStreamInstant,
} from "../queries/continuous-streams";
import { reminderStream } from "../integrations/continuous-streams";
import {
  BEDTIME_WEAR_TITLE,
  bedtimeWearBody,
  bedtimeWearVerdict,
  type BedtimeWearVerdict,
} from "../wear-reminder";
import type { NotificationMessage } from "./types";

/**
 * The (provider, stream) pair this reminder watches, resolved from the registry.
 *
 * The "first declared entry wins" rule moved into `reminderStream` in #2162, because
 * the offboarding prompt has to name the SAME stream this send watches — it claims
 * those sends have paused, and a prompt about a different device would be explaining a
 * pause that never happened.
 */
function watchedStream() {
  return reminderStream("bedtime-wear");
}

/**
 * Did the provider record a SUCCESSFUL sync at or after `sinceUtc`?
 *
 * Asked through the SHARED reader and compared as epoch milliseconds, not as SQL text.
 * The hand-rolled `at >= ?` this replaced bound a bare `YYYY-MM-DD HH:MM:SS` against a
 * column migration 163 had put on the canonical `…Z` shape: ' ' sorts below 'T', so
 * the bound was always below every row and the predicate matched unconditionally. It
 * happened to be the permissive direction, which is why nothing noticed.
 */
function syncedSince(
  profileId: number,
  provider: string,
  sinceUtc: Date
): boolean {
  const latestOk = parseUtcSql(latestOkSyncInstant(profileId, provider));
  return latestOk != null && latestOk.getTime() >= sinceUtc.getTime();
}

/**
 * Tonight's verdict plus the copy ingredient, for the builder and for tests that want
 * to assert WHY nothing was sent rather than only that nothing was.
 */
export function bedtimeWearReminderState(
  profileId: number,
  at: Date = now()
): { verdict: BedtimeWearVerdict; lastSeenLocalHhmm: string | null } {
  const watched = watchedStream();
  // Consent first, and cheaply: a profile that never opted in pays one settings read
  // and nothing else, which is what "off is exactly today's behaviour" means in
  // practice as well as in the copy.
  const enabled = getProfileWearReminder(profileId);
  if (!enabled || !watched)
    return {
      verdict: bedtimeWearVerdict({
        enabled: enabled && watched != null,
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
    (row) => row.id === watched.provider
  );

  const latest = latestStreamInstant(
    profileId,
    watched.stream.table,
    watched.provider
  );
  const latestUtc = latest ? parseUtcSql(latest) : null;
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
        latestUtc == null
          ? false
          : syncedSince(profileId, watched.provider, latestUtc),
    }),
    // The stored instant PROJECTED to the profile's own wall clock — "since 21:05"
    // must be the hour the user saw, not the UTC one.
    lastSeenLocalHhmm: latestUtc ? zonedDateParts(tz, latestUtc).hhmm : null,
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
