// Dashboard "Needs attention" gather (issue #171). One profile-scoped entry point,
// collectAttention(), fans out across the EXISTING attention signals — the Upcoming
// findings engine, the digest's newly-flagged-biomarker read (over the hero's own
// stable window — issue #283), the failing-integration events, and the review-inbox
// pair count — and hands them to the pure buildAttention (lib/attention.ts) for
// severity ordering. No new table reads: every row-returning read here delegates to
// a function that already filters profile_id (enforced by
// lib/__tests__/profile-scoping.test.ts), so the hero adds no new scoping surface.

import { db } from "../db";
import {
  buildAttention,
  type AttentionItem,
  type AttentionIntegration,
} from "../attention";
import { getNewlyFlaggedBiomarkers } from "../notifications/digest-data";
import { getIntegration } from "../integrations/registry";
import { biomarkerFlagDismissalKey } from "../dismissal-keys";
import { isSuppressed } from "../upcoming-suppress";
import type { IntegrationId } from "../types";
import { collectUpcoming, getFindingSuppressions } from "./upcoming";
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

// The hero's stable flagged-biomarker window (issue #283): a result flagged in
// the last N days needs attention, regardless of whether/when a Telegram digest
// went out. The digest keeps its own send-cursor window (digestSince) — the read
// is shared, the window is per-surface.
export const FLAGGED_ATTENTION_WINDOW_DAYS = 14;

// The window start as a datetime('now')-format UTC string (medical_records
// created_at values compare lexically in that format).
function flaggedAttentionSince(): string {
  return (
    db
      .prepare("SELECT datetime('now', ?) AS since")
      .get(`-${FLAGGED_ATTENTION_WINDOW_DAYS} days`) as { since: string }
  ).since;
}

// The full, severity-ordered attention model for one profile. Reuses collectUpcoming
// (already snooze/dismiss-filtered), the SAME newly-flagged-biomarker read the
// Telegram digest uses (over the hero's stable window), the failing-integration
// events, and the review-pair count. Flagged items go through the shared findings
// bus too (issue #283): a `biomarker-flag:<name>` dismissal/snooze recorded from
// the hero filters them here, same store as every other finding.
export function collectAttention(
  profileId: number,
  today: string
): AttentionItem[] {
  const suppressions = getFindingSuppressions(profileId);
  const flaggedBiomarkers = getNewlyFlaggedBiomarkers(
    profileId,
    flaggedAttentionSince()
  ).filter((b) => {
    const rec = suppressions.get(biomarkerFlagDismissalKey(b.name));
    return rec == null || !isSuppressed(rec, today);
  });
  return buildAttention({
    upcoming: collectUpcoming(profileId, today),
    flaggedBiomarkers,
    integrations: integrationAttention(profileId),
    reviewCount: getReviewPairCount(profileId),
    today,
  });
}

// The attention COUNT for one profile — the number behind a household-strip chip.
// Same computation as collectAttention, so a chip's badge and the profile's own hero
// can never disagree — and like the hero it excludes far-future `later`-band items
// (issue #283: those were inflating every badge with non-urgent counts). Bounded
// work (a household is a handful of profiles), and every underlying read is
// profile-scoped.
export function attentionCountForProfile(
  profileId: number,
  today: string
): number {
  return collectAttention(profileId, today).length;
}
