// PURE registry readers for the ARCHIVE REFRESH facet (#2164) — the sibling of
// staleness.ts / pull-cadence.ts / continuous-streams.ts, and the same rule as those:
// the registry field is touched HERE and nowhere else, so "which of this provider's
// streams only the archive can deliver, and how long may they age" has one answer for
// the Upcoming generator, the tests, and whatever asks next.
//
// Why the facet exists at all. `silenceToleranceMinutes` asks about the CONNECTION, and
// an archive provider answers it `null` — correctly, because a one-off import has no
// cadence to be late against. `continuousStreams` asks whether rows are EXPECTED to
// keep arriving minute after minute, and an archive answers "none", also correctly.
// Both answers are about delivery mechanics, and both leave a real question unanswered:
// the DATA that reaches allos through this archive and through nothing else is exactly
// as fresh as the last manual download, and no detector in the app could see it.
//
// A provider that declares no facet is EXEMPT BY CONSTRUCTION. There is no exemption
// list to keep in sync here — the push, poll, feed, attended-portal and planned entries
// have nothing that only an archive can deliver, and the registry says so by omission.

import type {
  ArchiveExclusiveStreamDef,
  IntegrationArchiveRefreshFacet,
  IntegrationDef,
  IntegrationId,
} from "../types";
import { INTEGRATIONS, getIntegration } from "./registry";

/** A provider together with its declared archive-refresh facet. */
export interface ArchiveRefreshProvider {
  provider: IntegrationId;
  /** The provider's display name, so a caller building copy needs no second lookup. */
  providerName: string;
  facet: IntegrationArchiveRefreshFacet;
}

/** The provider's archive-refresh facet, or null when it declares none. */
export function archiveRefreshFacet(
  def: IntegrationDef | undefined
): IntegrationArchiveRefreshFacet | null {
  return def?.archiveRefresh ?? null;
}

/**
 * THE enumeration: every provider that declares archive-exclusive streams, in registry
 * order. The Upcoming generator walks this rather than naming `fitbit-takeout`, so a
 * second archive provider is a registry entry and nothing else.
 *
 * `status: "available"` is required — a `planned` entry's card is real, its import path
 * is not, so nothing could ever have delivered the streams it declares.
 */
export function archiveRefreshProviders(): ArchiveRefreshProvider[] {
  return INTEGRATIONS.flatMap((def) => {
    const facet = archiveRefreshFacet(def);
    return facet && def.status === "available"
      ? [{ provider: def.id, providerName: def.name, facet }]
      : [];
  });
}

/** One provider's facet by id, or null. */
export function archiveRefreshFor(
  provider: IntegrationId
): ArchiveRefreshProvider | null {
  const def = getIntegration(provider);
  const facet = archiveRefreshFacet(def);
  return def && facet
    ? { provider: def.id, providerName: def.name, facet }
    : null;
}

/** The declared streams for a provider — empty for one that declares no facet. */
export function archiveExclusiveStreams(
  provider: IntegrationId
): readonly ArchiveExclusiveStreamDef[] {
  return archiveRefreshFor(provider)?.facet.streams ?? [];
}
