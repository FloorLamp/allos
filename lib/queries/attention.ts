// Dashboard "Needs attention" gather (issue #171). One profile-scoped entry point,
// collectAttention(), fans out across the EXISTING attention signals — the Upcoming
// findings engine, the digest's newly-flagged-biomarker read, the failing-integration
// events, and the review-inbox pair count — and hands them to the pure buildAttention
// (lib/attention.ts) for severity ordering. No new SQL: every read here delegates to
// a function that already filters profile_id (enforced by
// lib/__tests__/profile-scoping.test.ts), so the hero adds no new scoping surface.

import {
  buildAttention,
  type AttentionItem,
  type AttentionIntegration,
} from "../attention";
import {
  digestSince,
  getNewlyFlaggedBiomarkers,
} from "../notifications/digest-data";
import { getIntegration } from "../integrations/registry";
import type { IntegrationId } from "../types";
import { collectUpcoming } from "./upcoming";
import { getImportIssues, getReviewPairCount } from "./integrations";

// A friendly provider label for a failing-integration event, falling back to the
// raw provider id when it isn't in the registry.
function providerLabel(provider: string): string {
  return getIntegration(provider as IntegrationId)?.name ?? provider;
}

// The failing/needs-reauth providers reduced to what the hero renders (one entry per
// currently-broken provider).
function integrationAttention(profileId: number): AttentionIntegration[] {
  return getImportIssues(profileId).map((ev) => ({
    provider: providerLabel(ev.provider),
    detail: ev.error ?? "Reconnect to resume syncing.",
  }));
}

// The full, severity-ordered attention model for one profile. Reuses collectUpcoming
// (already snooze/dismiss-filtered), the SAME newly-flagged-biomarker read the
// Telegram digest uses, the failing-integration events, and the review-pair count.
export function collectAttention(
  profileId: number,
  today: string
): AttentionItem[] {
  return buildAttention({
    upcoming: collectUpcoming(profileId, today),
    flaggedBiomarkers: getNewlyFlaggedBiomarkers(
      profileId,
      digestSince(profileId)
    ),
    integrations: integrationAttention(profileId),
    reviewCount: getReviewPairCount(profileId),
    today,
  });
}

// The attention COUNT for one profile — the number behind a household-strip chip.
// Same computation as collectAttention, so a chip's badge and the profile's own hero
// can never disagree. Bounded work (a household is a handful of profiles), and every
// underlying read is profile-scoped.
export function attentionCountForProfile(
  profileId: number,
  today: string
): number {
  return collectAttention(profileId, today).length;
}
