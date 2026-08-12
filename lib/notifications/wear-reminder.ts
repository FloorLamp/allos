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
// The stream is no longer named here. #2146 moved the declaration into the source
// registry (`continuousStreams`, with a `reminder` facet on the entry this watches),
// so `streamsWithReminder` below IS the binding: which source, which table, and —
// through the shared reader — how its timestamps are read. A second wearable becomes a
// registry entry rather than an edit here.
//
// #2341 finished the job: the THRESHOLD moved there too (`reminder.frontierFloorMin`,
// beside the quiet facet's `dipToleranceMin`, each carrying its evidence). It was the
// last thing this feature decided for itself, and it is the thing it got wrong.
//
// ── What is read, since #2341 ────────────────────────────────────────────────
//
// Two reads, not two-and-a-bit: the stream's frontier (`MAX(ts)`, for its AGE) and the
// stored frontier OBSERVATION the ingest path writes (`syncs_since_advance`, for
// whether it is MOVING). The retired third read was "was there an ok sync after the
// last row" — which is true of a late push and a dead watch alike, and is what let this
// send fire on 2026-08-08 while the watch was recording.
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
  latestStreamInstant,
  readStreamFrontier,
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
 * The (source, stream) pair this reminder watches, resolved from the registry.
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
        sourceHealthy: false,
        frontierAgeMin: null,
        syncsSinceAdvance: null,
        // Never read: `enabled` is false here by construction, and it is checked
        // first. There is no floor to state because there is no stream to state it
        // for — the declaration lives on the stream, and this path has none.
        floorMin: 0,
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

  // Yields to the bigger problem (#1685): while the source is failing or stale a
  // reconnect item already owns the contact, and "still on the charger?" would be
  // false advice with the pipeline down.
  const sourceHealthy = !getIntegrationAttention(profileId).some(
    (row) => row.id === watched.sourceId
  );

  const latest = latestStreamInstant(
    profileId,
    watched.stream.table,
    watched.sourceId
  );
  const latestUtc = latest ? parseUtcSql(latest) : null;
  const frontierAgeMin =
    latestUtc == null
      ? null
      : Math.floor((at.getTime() - latestUtc.getTime()) / 60_000);
  // The stored observation the INGEST path writes (#2341): how many successful pushes
  // have landed against this exact frontier. Null until the first push after the
  // source connected — no evidence, so no send, and the next push repairs it.
  const frontier = readStreamFrontier(
    profileId,
    watched.sourceId,
    watched.stream.id
  );

  return {
    verdict: bedtimeWearVerdict({
      enabled,
      expectedActive,
      sourceHealthy,
      frontierAgeMin,
      syncsSinceAdvance: frontier?.syncsSinceAdvance ?? null,
      // DECLARED on the stream, beside the quiet facet's own tolerance — the whole
      // point of #2341 item 2. A stream carrying the `bedtime-wear` adapter carries
      // its floor with it, so this cannot silently fall back to a module constant.
      floorMin: watched.stream.reminder.frontierFloorMin,
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
