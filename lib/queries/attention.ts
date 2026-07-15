// The unified attention gather (issues #171, #524). One profile-scoped entry point,
// collectAttentionModel(), fans out across the EXISTING attention signals — the
// Upcoming findings engine, the digest's newly-flagged-biomarker read (over the
// hero's own stable window — issue #283), the failing-integration events, and the
// review-inbox pair count — and hands them to the pure buildAttentionModel
// (lib/attention.ts). This ONE model is rendered by BOTH surfaces: the dashboard
// card (the act-now subset) and the Upcoming page (the full, time-ordered set), so
// the two can never disagree on what an item means (issue #524).
//
// No new table reads: every row-returning read here delegates to a function that
// already filters profile_id (enforced by lib/__tests__/profile-scoping.test.ts),
// so this adds no new scoping surface.

import { db } from "../db";
import {
  buildAttentionModel,
  buildFlaggedItem,
  attentionCardItems,
  type AttentionIntegration,
} from "../attention";
import { getNewlyFlaggedBiomarkers } from "../notifications/digest-data";
import { getIntegration } from "../integrations/registry";
import { biomarkerFlagDismissalKey } from "../dismissal-keys";
import { isSuppressed } from "../upcoming-suppress";
import type { IntegrationId } from "../types";
import type { UpcomingItem } from "../upcoming";
import {
  collectUpcoming,
  collectSuppressedUpcoming,
  getFindingSuppressions,
  type SuppressedUpcoming,
} from "./upcoming";
import { getImportIssues, getReviewPairCount } from "./integrations";

// The failing/needs-reauth providers reduced to what the model renders (one entry
// per currently-broken provider).
function integrationAttention(profileId: number): AttentionIntegration[] {
  return getImportIssues(profileId).map((ev) => {
    const integration = getIntegration(ev.provider as IntegrationId);
    return {
      id: integration?.id ?? null,
      provider: integration?.name ?? ev.provider,
      detail: ev.error ?? "Reconnect to resume syncing.",
    };
  });
}

// The stable flagged-biomarker window (issue #283): a result flagged in the last N
// days needs attention, regardless of whether/when a Telegram digest went out. The
// digest keeps its own send-cursor window (digestSince) — the read is shared, the
// window is per-surface.
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

// The newly-flagged biomarkers for the hero's stable window, still LIVE (not
// snooze/dismiss-filtered). The caller decides whether to keep or drop the
// suppressed ones — the live model drops them, the restore gather keeps only them.
function flaggedInWindow(profileId: number) {
  return getNewlyFlaggedBiomarkers(profileId, flaggedAttentionSince());
}

// The full, unified attention model for one profile (issue #524). Reuses
// collectUpcoming (already snooze/dismiss-filtered), the SAME newly-flagged read
// the Telegram digest uses (over the stable window), the failing-integration
// events, and the review-pair count. Flagged items go through the shared findings
// bus too (issue #283): a `biomarker-flag:<name>` dismissal/snooze filters them
// here, same store as every other finding. This is the item set BOTH surfaces
// render — the dashboard card via attentionCardItems/groupAttentionForCard, the
// Upcoming page via groupAttentionForPage.
export function collectAttentionModel(
  profileId: number,
  today: string
): UpcomingItem[] {
  const suppressions = getFindingSuppressions(profileId);
  const flaggedBiomarkers = flaggedInWindow(profileId).filter((b) => {
    const rec = suppressions.get(biomarkerFlagDismissalKey(b.name));
    return rec == null || !isSuppressed(rec, today);
  });
  return buildAttentionModel({
    upcoming: collectUpcoming(profileId, today),
    flaggedBiomarkers,
    integrations: integrationAttention(profileId),
    reviewCount: getReviewPairCount(profileId),
    today,
  });
}

// The dashboard-card ATTENTION COUNT for one profile — the number behind the hero's
// badge and a household-strip chip. It's the CARD subset (the act-now slice), so a
// chip's badge, the profile's own hero badge, and the "N shown" the card renders can
// never disagree — and it excludes the far-future scheduled items the card hides
// (issue #524), which is what a triage count should mean. Bounded work (a household
// is a handful of profiles), every underlying read profile-scoped.
export function attentionCountForProfile(
  profileId: number,
  today: string
): number {
  return attentionCardItems(collectAttentionModel(profileId, today), today)
    .length;
}

// The items currently snoozed/dismissed for this profile — powers the Upcoming
// page's "Snoozed & dismissed" restore section. It's the complement of the live
// model: the suppressed date-scheduled due-signals (collectSuppressedUpcoming) PLUS
// any suppressed biomarker flags (issue #524 — a flag dismissed on either surface
// stays restorable, same `biomarker-flag:<name>` store). Structural signals
// (review/integration) aren't suppressible, so they never appear here.
export function collectSuppressedAttention(
  profileId: number,
  today: string
): SuppressedUpcoming[] {
  const out = collectSuppressedUpcoming(profileId, today);
  const suppressions = getFindingSuppressions(profileId);
  for (const b of flaggedInWindow(profileId)) {
    const key = biomarkerFlagDismissalKey(b.name);
    const rec = suppressions.get(key);
    if (rec && isSuppressed(rec, today)) {
      out.push({
        item: buildFlaggedItem(b),
        signalKey: key,
        snoozeUntil: rec.snooze_until,
        dismissedAt: rec.dismissed_at,
      });
    }
  }
  return out;
}
