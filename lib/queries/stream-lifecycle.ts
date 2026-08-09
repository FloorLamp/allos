// The DB half of the continuous-stream on/offboarding lifecycle (#2162). The decision
// is pure and lives in lib/integrations/stream-lifecycle.ts; nothing here re-derives
// it. This module only (a) walks #2146's registry ENUMERATION, (b) asks the three
// stored questions each stream's state needs, and (c) projects the resulting offer
// into the shape a rendered card takes.
//
// ── Everything here is borrowed on purpose ───────────────────────────────────
//
// There is no new table, no new marker, and no second staleness rule:
//
//   • the enumeration is `allContinuousStreams()` (#2146's declarations);
//   • the active/lapsed boundary is `isStreamActive` (lib/stream-activity.ts) over the
//     stream's own declared `expectedActive` window;
//   • the day readers are the ones the quiet row already uses
//     (`streamDeliveredDays`), so both count the same PROFILE-LOCAL days;
//   • the consent is the #2161 setting, READ — never written — here;
//   • the one-shot side-state is the Upcoming suppression bus, through the same
//     `getFindingSuppressions` map every other dismissible surface reads.
//
// ── Reach: this list is not an attention list ────────────────────────────────
//
// Deliberately its own entry point, for exactly the reason #2146 gave when it kept
// `getQuietStreamAttention` out of `getIntegrationAttention`: THAT list is the
// escalation set, and the morning digest builds a banded section from it. Joining it
// would have turned a rendered offer into a SEND, which is the one thing this feature
// may never be (#2162 constraint 1). Nothing here returns an `AttentionIntegration`,
// so there is no list for it to leak into.

import { today as profileToday } from "@/lib/db";
import { cache } from "@/lib/request-cache";
import { getTimezone } from "@/lib/settings";
import { getProfileWearReminder } from "@/lib/settings/notifications";
import { daysBetweenDateStr } from "@/lib/date";
import { localDayOf } from "@/lib/local-day-window";
import { isStreamActive } from "@/lib/stream-activity";
import { isHiddenUnderPolicy } from "@/lib/lifecycle";
import { integrationDetailHref, type AppRoute } from "@/lib/hrefs";
import type { ContinuousStreamId, IntegrationId } from "@/lib/types";
import {
  allContinuousStreams,
  reminderStream,
} from "@/lib/integrations/continuous-streams";
import {
  streamLifecycleState,
  streamOfferKind,
  streamOffboardBody,
  streamOffboardKey,
  streamOffboardTitle,
  streamOnboardBody,
  streamOnboardKey,
  streamOnboardTitle,
  streamReminderPausedNote,
  type StreamLifecycleState,
  type StreamOfferKind,
} from "@/lib/integrations/stream-lifecycle";
import { getConnection } from "@/lib/integrations/connections";
import {
  earliestStreamInstant,
  latestStreamInstant,
  streamDeliveredDays,
} from "./continuous-streams";
import { getFindingSuppressions } from "./upcoming/suppressions";

/** One declared stream's resolved lifecycle, before any offer question is asked. */
export interface StreamLifecycle {
  provider: IntegrationId;
  providerName: string;
  streamId: ContinuousStreamId;
  streamLabel: string;
  state: StreamLifecycleState;
  /** Does this stream DECLARE a send adapter (#2161's `reminder` facet)? */
  hasReminder: boolean;
  /** Profile-local day of the first / most recent row, or null when there are none. */
  firstDay: string | null;
  lastDay: string | null;
  /** Whole days since the last row, or null when the stream never delivered. */
  quietDays: number | null;
}

/** A live offer, with everything its rendered card needs and nothing more. */
export interface StreamLifecycleOffer {
  kind: StreamOfferKind;
  /** The suppression-bus key. It is BOTH the render key and the action's only token. */
  key: string;
  provider: IntegrationId;
  providerName: string;
  streamId: ContinuousStreamId;
  streamLabel: string;
  title: string;
  body: string;
  /** The provider's own setup page, when it has one. */
  href: AppRoute | null;
}

/**
 * Every declared stream's lifecycle state for this profile.
 *
 * Only CONNECTED providers are walked. A disconnected or needs-reauth provider is not
 * delivering and is not being asked to — its stream has no lifecycle to be in, and
 * "your watch stopped sending" would be a worse name for "the integration is
 * unplugged", which #1685 already owns and already says.
 *
 * Memoized per REQUEST. There is deliberately no `tickCached` twin: nothing in this
 * feature reaches a send, so no tick has a reason to ask.
 */
export const getStreamLifecycles = cache(function getStreamLifecycles(
  profileId: number
): StreamLifecycle[] {
  const streams = allContinuousStreams();
  if (streams.length === 0) return [];
  const tz = getTimezone(profileId);
  const todayStr = profileToday(profileId);

  const out: StreamLifecycle[] = [];
  for (const { provider, providerName, stream } of streams) {
    if (getConnection(profileId, provider)?.status !== "connected") continue;

    const firstAt = earliestStreamInstant(profileId, stream.table, provider);
    const lastAt = latestStreamInstant(profileId, stream.table, provider);
    // The stored instants projected to the PROFILE's own days (#94). A day is never a
    // substring of a UTC instant, so both go through localDayOf rather than a slice.
    const firstDay = firstAt ? localDayOf(tz, firstAt) : null;
    const lastDay = lastAt ? localDayOf(tz, lastAt) : null;

    // The shared gate is only consulted when there is history to consult it about —
    // the per-day EXISTS queries are the only per-stream cost in this gather, and a
    // profile that has never delivered a row pays none of them.
    const expectedActive =
      lastDay == null
        ? false
        : isStreamActive(
            streamDeliveredDays(
              profileId,
              stream.table,
              provider,
              tz,
              todayStr,
              stream.expectedActive.windowDays
            ),
            todayStr,
            stream.expectedActive.windowDays,
            stream.expectedActive.minDays
          );

    out.push({
      provider,
      providerName,
      streamId: stream.id,
      streamLabel: stream.label,
      state: streamLifecycleState({
        firstDay,
        lastDay,
        expectedActive,
        today: todayStr,
      }),
      hasReminder: stream.reminder != null,
      firstDay,
      lastDay,
      quietDays: lastDay == null ? null : daysBetweenDateStr(lastDay, todayStr),
    });
  }
  return out;
});

/**
 * The live on/offboarding offers for this profile — usually none, which is the normal
 * state and what every surface renders as nothing at all.
 *
 * The OFFBOARDING offer is additionally restricted to the stream the reminder adapter
 * actually watches (`reminderStream`). The prompt claims those sends have paused;
 * offering it for a second declared stream the sender does not read would be
 * explaining a pause that never happened.
 */
export const getStreamLifecycleOffers = cache(function getStreamLifecycleOffers(
  profileId: number
): StreamLifecycleOffer[] {
  const lifecycles = getStreamLifecycles(profileId);
  if (lifecycles.length === 0) return [];

  // The user-owned consent, READ. Nothing in this module writes it — the feature's
  // only writes are the two taps in app/(app)/stream-lifecycle-actions.ts.
  const reminderEnabled = getProfileWearReminder(profileId);
  const watched = reminderStream("bedtime-wear");
  const todayStr = profileToday(profileId);
  const suppressions = getFindingSuppressions(profileId);
  const hidden = (key: string): boolean =>
    isHiddenUnderPolicy("normal", suppressions.get(key), todayStr);

  const offers: StreamLifecycleOffer[] = [];
  for (const life of lifecycles) {
    const onboardKey = streamOnboardKey(life.provider, life.streamId);
    const offboardKey =
      life.lastDay == null
        ? null
        : streamOffboardKey(life.provider, life.streamId, life.lastDay);

    const kind = streamOfferKind({
      state: life.state,
      hasReminder: life.hasReminder,
      reminderEnabled,
      onboardDismissed: hidden(onboardKey),
      offboardDismissed: offboardKey == null || hidden(offboardKey),
    });
    if (kind == null) continue;
    if (
      kind === "offboard" &&
      (watched?.provider !== life.provider ||
        watched.stream.id !== life.streamId)
    )
      continue;

    const shared = {
      provider: life.provider,
      providerName: life.providerName,
      streamId: life.streamId,
      streamLabel: life.streamLabel,
      href: integrationDetailHref(life.provider),
    };
    if (kind === "onboard") {
      offers.push({
        ...shared,
        kind,
        key: onboardKey,
        title: streamOnboardTitle(life.providerName, life.streamLabel),
        body: streamOnboardBody(life.streamLabel),
      });
    } else if (offboardKey != null && life.quietDays != null) {
      offers.push({
        ...shared,
        kind,
        key: offboardKey,
        title: streamOffboardTitle(),
        body: streamOffboardBody(
          life.providerName,
          life.streamLabel,
          life.quietDays
        ),
      });
    }
  }
  return offers;
});

/**
 * Settings → Notifications honesty (#2162 constraint 5): the paused-by-gate note for
 * the bedtime reminder row, or null when there is nothing to disclose.
 *
 * Null covers the honest silences equally — the setting is off, the stream is
 * delivering, or the profile has no connected stream at all — because a note about a
 * pause that is not happening is worse than no note. The toggle itself is untouched:
 * the pause is DERIVED state being presented, never a stored flag, which is the shape
 * #1668 shipped for the mood check-in.
 */
export function wearReminderPausedNote(profileId: number): string | null {
  if (!getProfileWearReminder(profileId)) return null;
  const watched = reminderStream("bedtime-wear");
  if (!watched) return null;
  const life = getStreamLifecycles(profileId).find(
    (l) => l.provider === watched.provider && l.streamId === watched.stream.id
  );
  if (!life || life.quietDays == null) return null;
  if (life.state !== "lapsed" && life.state !== "ended") return null;
  return streamReminderPausedNote(
    life.providerName,
    life.streamLabel,
    life.quietDays
  );
}
