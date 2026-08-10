// PURE registry readers for the CONTINUOUS STREAM facet (#2146) — the sibling of
// staleness.ts / pull-cadence.ts / auth-failure.ts, and the same rule as those: the
// registry field is touched HERE and nowhere else, so "which streams does this
// provider deliver continuously" has one answer for the detector, the reminder, and
// whatever asks next.
//
// Why the facet exists at all. `silenceToleranceMinutes` asks about the CONNECTION —
// has any successful run landed lately. A provider can pass that while one of its
// streams has gone silent, because the two are delivered by different things: the
// phone exporter keeps pushing daily aggregates whether or not the watch feeding
// heart rate is on a wrist. Nothing in the app could see that gap, so nothing did.
//
// A provider that declares no stream is EXEMPT BY CONSTRUCTION. There is no exemption
// list here to keep in sync — weather, the outbound calendar feed, attended portals
// and the Fitbit Takeout archive simply have nothing continuous to be silent, and the
// registry says so by omission (each with a comment stating why).

import type {
  ContinuousStreamDef,
  ContinuousStreamId,
  ContinuousStreamReminderFacet,
  ContinuousStreamReminderId,
  IntegrationDef,
  IntegrationId,
} from "../types";
import { INTEGRATIONS, getIntegration } from "./registry";

// A stream together with the provider that delivers it. Every reader below returns
// this rather than a bare stream, because a stream id is only unique WITHIN a
// provider and every consumer needs both halves anyway.
export interface ProviderStream {
  provider: IntegrationId;
  // The provider's display name, so a caller building copy needs no second lookup.
  providerName: string;
  stream: ContinuousStreamDef;
}

const EMPTY: readonly ContinuousStreamDef[] = [];

/** The provider's declared continuous streams — empty for one that declares none. */
export function continuousStreamsFor(
  def: IntegrationDef | undefined
): readonly ContinuousStreamDef[] {
  return def?.continuousStreams ?? EMPTY;
}

/**
 * THE enumeration (#2162): every declared continuous stream across the registry,
 * paired with its provider, in registry order.
 *
 * This is the list a lifecycle feature walks — "which streams could this profile be
 * onboarded onto", "which of them carry a reminder adapter" — which is why the
 * declaration is shaped as named streams with optional facets rather than as a bare
 * tolerance number. A new facet is a new optional key on the entry; nothing here has
 * to widen to accommodate it.
 */
export function allContinuousStreams(): ProviderStream[] {
  return INTEGRATIONS.flatMap((def) =>
    continuousStreamsFor(def).map((stream) => ({
      provider: def.id,
      providerName: def.name,
      stream,
    }))
  );
}

/** One provider's stream by id, or null. */
export function continuousStream(
  provider: IntegrationId,
  streamId: ContinuousStreamId
): ProviderStream | null {
  const def = getIntegration(provider);
  const stream = continuousStreamsFor(def).find((s) => s.id === streamId);
  return def && stream
    ? { provider: def.id, providerName: def.name, stream }
    : null;
}

/**
 * Every stream watched by a named send adapter (#2161). The wear reminder resolves
 * its provider and stream through this instead of naming `health-connect` and
 * `hr_minutes` itself, so the declaration in the registry is the single place a
 * second wearable is added.
 */
export function streamsWithReminder(
  reminder: ContinuousStreamReminderId
): ProviderStreamWithReminder[] {
  // The narrowing is the point (#2341): what comes back CARRIES its reminder facet,
  // so the send adapter reads its declared floor off the stream rather than falling
  // back to a number of its own when the facet is optional-shaped.
  return allContinuousStreams().filter(
    (s): s is ProviderStreamWithReminder => s.stream.reminder?.id === reminder
  );
}

/** A stream known to carry a reminder facet — see `streamsWithReminder`. */
export interface ProviderStreamWithReminder extends ProviderStream {
  stream: ContinuousStreamDef & { reminder: ContinuousStreamReminderFacet };
}

/**
 * THE one stream a named send adapter actually watches, or null.
 *
 * Exactly one entry declares `bedtime-wear` today. A second would need a per-profile
 * choice of which device to remind about — a product question neither #2161 nor #2162
 * answers — so the first is taken and the rest deliberately ignored until it is
 * decided. Resolved HERE rather than in either caller because two callers now need the
 * same answer for the same reason: #2161's gather sends about this stream, and #2162's
 * offboarding prompt claims that those sends have paused. If the two picked
 * differently, the prompt would be explaining a pause that never happened.
 */
export function reminderStream(
  reminder: ContinuousStreamReminderId
): ProviderStreamWithReminder | null {
  return streamsWithReminder(reminder)[0] ?? null;
}

/** Every stream that declares the #2146 quiet facet, i.e. is reportable as quiet. */
export function quietReportableStreams(): ProviderStream[] {
  return allContinuousStreams().filter((s) => s.stream.quiet != null);
}
