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
import {
  getTimezone,
  getProfileWearReminder,
  getProfileSetting,
  setProfileSetting,
} from "../settings";
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
  bedtimeWearCorrectedBody,
  bedtimeWearVerdict,
  wearReminderFalsified,
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
): {
  verdict: BedtimeWearVerdict;
  lastSeenLocalHhmm: string | null;
  lastSeenAt: string | null;
} {
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
        // first. There is no floor and no evidence bar to state because there is no
        // stream to state them for — both declarations live on the stream, and this
        // path has none. `frozenSyncs` is stated as Infinity rather than 0 so that if
        // this branch ever WERE reached, the unreachable answer is silence.
        floorMin: 0,
        frozenSyncs: Number.POSITIVE_INFINITY,
      }),
      lastSeenLocalHhmm: null,
      lastSeenAt: null,
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
      // DECLARED on the stream too, since #2560 — how many quiet pushes this source's
      // delivery chain takes before a frozen frontier means the wrist and not the
      // watch's own Bluetooth batch.
      frozenSyncs: watched.stream.frozenEvidence.syncs,
    }),
    // The stored instant PROJECTED to the profile's own wall clock — "since 21:05"
    // must be the hour the user saw, not the UTC one.
    lastSeenLocalHhmm: latestUtc ? zonedDateParts(tz, latestUtc).hhmm : null,
    // The SAME instant, canonical — the message's factual clause as an instant rather
    // than as a wall clock, which is what the reconciler compares the frontier against
    // (#3027). Recorded ON DELIVERY and never re-derived: by the time the sweep runs the
    // frontier has moved, and the instant the message NAMED is no longer readable from
    // the stream.
    lastSeenAt: latestUtc ? latestUtc.toISOString() : null,
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

/**
 * Tonight's reminder together with the instant its factual clause names (#3027) — what
 * the tick sends, and what it records on delivery so the sweep can tell later whether the
 * message is still true. `buildWearReminder` above is this without the claim, kept
 * because every other caller only wants the message.
 */
export function wearReminderSend(
  profileId: number
): { message: NotificationMessage; claimedAt: string } | null {
  const { verdict, lastSeenLocalHhmm, lastSeenAt } =
    bedtimeWearReminderState(profileId);
  if (!verdict.send || lastSeenLocalHhmm == null || lastSeenAt == null)
    return null;
  return {
    message: {
      title: BEDTIME_WEAR_TITLE,
      body: bedtimeWearBody(lastSeenLocalHhmm),
      kind: "wear-reminder",
    },
    claimedAt: lastSeenAt,
  };
}

// ---- The claim, and the sweep's answer to it (issue #3027) -----------------
//
// ONE PROFILE SETTING, `<profile-local date>|<ISO instant>`: the night the message was
// sent for, and the frontier instant its sentence named. It exists because that instant
// is UNRECOVERABLE afterwards — the falsifying event is data ARRIVING with timestamps
// EARLIER than now, so re-reading the stream at sweep time gives the frontier as it is,
// never as it was. The parse posture is #947's: a value this module cannot read is
// treated as absent, which leaves the message exactly as delivered.
const CLAIM_KEY = "notify_wear_reminder_claim";

export function recordWearReminderClaim(
  profileId: number,
  date: string,
  claimedAt: string
): void {
  setProfileSetting(profileId, CLAIM_KEY, `${date}|${claimedAt}`);
}

export function readWearReminderClaim(
  profileId: number
): { date: string; claimedAt: string } | null {
  const raw = getProfileSetting(profileId, CLAIM_KEY);
  if (!raw) return null;
  const cut = raw.indexOf("|");
  if (cut <= 0) return null;
  const date = raw.slice(0, cut);
  const claimedAt = raw.slice(cut + 1);
  if (!date || !claimedAt || Number.isNaN(new Date(claimedAt).getTime()))
    return null;
  return { date, claimedAt };
}

/**
 * The prose reconciler's rebuild for a delivered wear reminder (#3027): the corrected
 * message when the stream has since falsified it, or NULL to leave the chat alone.
 *
 * NULL IS THE COMMON ANSWER AND IT COSTS TWO READS. The issue's "cheap dependency
 * pre-check" is not a separate stamp here the way the digest's is — the whole decision IS
 * the comparison (the recorded claim against the stream's frontier and the clock), so
 * paying for it and paying for the "rebuild" are the same thing, and no Telegram call is
 * made unless it says the message is false. See the `wear-reminder` entry in
 * ./reconcile.ts.
 *
 * WHAT `pointerDate` ACTUALLY GUARDS, stated honestly because a previous draft called it
 * redundant with the day boundary and it is not. The claim key holds ONE value per
 * profile and is never cleared, while the pointer is per-night — so the two can name
 * different nights whenever the delivery straddles local midnight: the tick captured
 * `date` at the top of its run, and the send chokepoint stamps the pointer with
 * `today(profileId)` re-read after the Telegram round-trip. A 23:59 Bedtime slot whose
 * send lands at 00:00 records a claim for one day and a pointer for the next, and without
 * this comparison last night's claimed instant would be measured against tonight's
 * message. It is asserted directly (lib/__db_tests__/wear-reminder.test.ts) rather than
 * left to the rollover.
 */
export function rebuildWearReminder(
  profileId: number,
  pointerDate: string
): NotificationMessage | null {
  const claim = readWearReminderClaim(profileId);
  if (!claim || claim.date !== pointerDate) return null;
  const watched = watchedStream();
  if (!watched) return null;
  const latest = latestStreamInstant(
    profileId,
    watched.stream.table,
    watched.sourceId
  );
  const frontier = latest ? parseUtcSql(latest) : null;
  const claimedAt = new Date(claim.claimedAt);
  const verdict = wearReminderFalsified(
    claimedAt.getTime(),
    frontier?.getTime() ?? null,
    now().getTime(),
    // The stream's OWN declared tolerance, the same value the send predicate reads for
    // its floor — never a constant here (#2341 item 2).
    watched.stream.reminder.frontierFloorMin
  );
  if (!verdict.falsified) return null;
  const tz = getTimezone(profileId);
  return {
    title: BEDTIME_WEAR_TITLE,
    // Only the CLAIMED instant, which is fixed at delivery — so this body is identical on
    // every later tick and the sweep's idempotence pin corrects the message once.
    body: bedtimeWearCorrectedBody(zonedDateParts(tz, claimedAt).hhmm),
    kind: "wear-reminder",
  };
}
