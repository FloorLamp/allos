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

import { db, today } from "../db";
import {
  buildAttentionModel,
  buildFlaggedItem,
  attentionCardItems,
  mergeAttentionPageGroups,
  type AttentionIntegration,
  type AttentionPageGroup,
  type MemberAttention,
  type ProfiledUpcomingItem,
} from "../attention";
import { getNewlyFlaggedBiomarkers } from "../notifications/digest-data";
import type { DigestFlaggedBiomarker } from "../notifications/digest";
import { getIntegration } from "../integrations/registry";
import { biomarkerFlagDismissalKey } from "../dismissal-keys";
import { isSuppressed } from "../upcoming-suppress";
import { retestModulationFor } from "../risk-stratification";
import { riskReasonsFrom, type Reason } from "../reasons";
import { getRiskFactors } from "./upcoming/risk";
import type { RiskFactor } from "../risk-stratification";
import type { IntegrationId } from "../types";
import {
  CANONICAL_DISPLAY_UNITS,
  type UpcomingDisplayUnits,
  type UpcomingItem,
} from "../upcoming";
import {
  collectUpcoming,
  collectSuppressedUpcoming,
  getFindingSuppressions,
} from "./upcoming";
import {
  domainForRichKey,
  resolveSuppressedKeyDisplay,
  ORPHAN_SUPPRESSION_LABEL,
  type SuppressionDomain,
} from "../suppression-display";
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

// The risk-layer "why THIS profile" reasons for a flagged analyte (issue #656 item
// 4): the SAME retestModulationFor over the SAME risk factors the retest generator
// uses (biomarkerItems), keyed on the reading's canonical-preferred name — so a
// flagged LDL for a family-cardiac-history profile carries "Family history of heart
// disease" on the flag item, identical to its retest twin. Empty when not elevated.
function flaggedRiskReasons(
  b: DigestFlaggedBiomarker,
  factors: ReadonlySet<RiskFactor>
): Reason[] {
  const name = b.canonicalName?.trim() || b.name;
  return riskReasonsFrom(retestModulationFor(name, factors).sourced);
}

// The full, unified attention model for one profile (issue #524). Reuses
// collectUpcoming (already snooze/dismiss-filtered), the SAME newly-flagged read
// the Telegram digest uses (over the stable window), the failing-integration
// events, and the review-pair count. Flagged items go through the shared findings
// bus too (issue #283): a `biomarker-flag:<name>` dismissal/snooze filters them
// here, same store as every other finding. This is the item set BOTH surfaces
// render — the dashboard card via attentionCardItems/groupAttentionForCard, the
// Upcoming page via groupAttentionForPage.
// `units` (#1019 display-unit policy): the two WEB boundaries (dashboard hero,
// Upcoming page) pass the viewer's login prefs so measurement-carrying item
// strings render in the viewer's unit; count-only callers omit it (canonical).
export function collectAttentionModel(
  profileId: number,
  today: string,
  units: UpcomingDisplayUnits = CANONICAL_DISPLAY_UNITS
): UpcomingItem[] {
  const suppressions = getFindingSuppressions(profileId);
  const factors = getRiskFactors(profileId);
  const flaggedBiomarkers = flaggedInWindow(profileId)
    .filter((b) => {
      const rec = suppressions.get(biomarkerFlagDismissalKey(b.name));
      return rec == null || !isSuppressed(rec, today);
    })
    // Attach the risk-layer reasons (issue #656 item 4) so the flag item explains
    // its elevation — one risk computation, shared with the retest generator.
    .map((b) => ({ ...b, riskReasons: flaggedRiskReasons(b, factors) }));
  return buildAttentionModel({
    upcoming: collectUpcoming(profileId, today, units),
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

// One row of the Upcoming page's "Snoozed & dismissed" section (issue #1151):
// EVERY currently-active suppression on the findings bus, each resolved to a
// domain group + a human label. `item` carries the rich reconstructed
// UpcomingItem when the care tier can still produce one (its icon/title win);
// resolver-labelled rows (coaching findings, suggestions, warnings) carry null.
// `orphan` marks a key whose subject is gone / namespace unknown (#203) — its
// Restore simply clears the dead row.
export interface SuppressedAttentionEntry {
  signalKey: string;
  domain: SuppressionDomain;
  label: string;
  snoozeUntil: string | null;
  dismissedAt: string | null;
  item: UpcomingItem | null;
  orphan: boolean;
}

// Everything currently snoozed/dismissed for this profile — powers the Upcoming
// page's "Snoozed & dismissed" restore section. As of #1151 it aggregates the
// WHOLE suppression bus, not just the care tier:
//   1. the suppressed date-scheduled due-signals (collectSuppressedUpcoming) and
//      suppressed biomarker flags keep their RICH reconstruction (a live item);
//   2. every OTHER active suppression row (coaching/observational findings,
//      per-surface suggestions, intake warnings) resolves through the ONE
//      prefix-keyed resolver (lib/suppression-display.ts, #221) into a domain +
//      label;
//   3. a row that matches nothing — subject deleted, name re-keyed, unknown
//      namespace — renders as the generic clearable orphan row (#203).
// A key whose item is LIVE despite its row (a care-persistent item resisting a
// dismiss, a safety-ungated crisis finding) is skipped — it isn't silenced, so
// listing it as "dismissed" would lie. Structural signals (review/integration)
// aren't suppressible, so they never appear here.
export function collectSuppressedAttention(
  profileId: number,
  today: string,
  units: UpcomingDisplayUnits = CANONICAL_DISPLAY_UNITS
): SuppressedAttentionEntry[] {
  const suppressions = getFindingSuppressions(profileId);
  const factors = getRiskFactors(profileId);

  const out: SuppressedAttentionEntry[] = [];
  const covered = new Set<string>();
  for (const s of collectSuppressedUpcoming(profileId, today, units)) {
    covered.add(s.signalKey);
    out.push({
      signalKey: s.signalKey,
      domain: domainForRichKey(s.signalKey),
      label: s.item.title,
      snoozeUntil: s.snoozeUntil,
      dismissedAt: s.dismissedAt,
      item: s.item,
      orphan: false,
    });
  }
  for (const b of flaggedInWindow(profileId)) {
    const key = biomarkerFlagDismissalKey(b.name);
    const rec = suppressions.get(key);
    if (rec && isSuppressed(rec, today) && !covered.has(key)) {
      covered.add(key);
      const item = buildFlaggedItem(b, flaggedRiskReasons(b, factors));
      out.push({
        signalKey: key,
        domain: domainForRichKey(key),
        label: item.title,
        snoozeUntil: rec.snooze_until,
        dismissedAt: rec.dismissed_at,
        item,
        orphan: false,
      });
    }
  }

  // The rest of the bus (#1151): keys with an ACTIVE suppression that no rich
  // reconstruction covered. Skip keys whose item is currently LIVE (the row has
  // no effect — a resisted dismiss on a care-persistent/safety-ungated item).
  const liveKeys = new Set(
    collectUpcoming(profileId, today, units).map((i) => i.key)
  );
  for (const [key, rec] of suppressions) {
    if (covered.has(key) || liveKeys.has(key)) continue;
    if (!isSuppressed(rec, today)) continue;
    const display = resolveSuppressedKeyDisplay(key);
    out.push({
      signalKey: key,
      domain: display?.domain ?? "Other",
      label: display?.label ?? ORPHAN_SUPPRESSION_LABEL,
      snoozeUntil: rec.snooze_until,
      dismissedAt: rec.dismissed_at,
      item: null,
      orphan: display == null,
    });
  }
  return out;
}

// ── Multi-profile attention (issue #1096) ─────────────────────────────────────
//
// The list-first, LOOP-composed cross-profile gather behind the multi-view Upcoming
// page. It takes the resolved view-set (`scope.viewIds` — already ∩ the caller's
// accessible set), never imports lib/auth, and composes the EXISTING per-profile
// collectAttentionModel over each member. It is DELIBERATELY loop-composed, not
// set-based `profile_id IN` SQL: every member's dueness/banding is derived from that
// member's OWN today() (its timezone), which the per-profile-context trap
// (lib/cross-profile.ts) forbids evaluating in another member's context. So there is
// no new cross-profile SQL module to register — only a merge of per-profile results.

export interface MultiProfileAttention {
  // Per-member models (each carries the member's own `today`), preserved so the
  // pure merge can band each in its own context — the trap.
  members: MemberAttention[];
  // The merged, page-grouped view (items carry `profileId` for subject stamping).
  groups: AttentionPageGroup[];
  // Total item count across the whole view-set (the page's "N total" badge).
  total: number;
}

export function collectMultiProfileAttention(
  viewIds: readonly number[],
  units: UpcomingDisplayUnits = CANONICAL_DISPLAY_UNITS
): MultiProfileAttention {
  const members: MemberAttention[] = [];
  let total = 0;
  for (const pid of viewIds) {
    // Each member's "today" resolved in ITS OWN timezone (the trap): a member's
    // banding must never be computed in another member's context.
    const now = today(pid);
    const items: ProfiledUpcomingItem[] = collectAttentionModel(
      pid,
      now,
      units
    ).map((i) => ({ ...i, profileId: pid }));
    total += items.length;
    members.push({ profileId: pid, today: now, items });
  }
  return { members, groups: mergeAttentionPageGroups(members), total };
}

// A suppressed-attention entry tagged with its owning profile, so the multi-view
// "Snoozed & dismissed" section can stamp its subject and route its Restore write to
// the item's OWN profile (never the acting one — #1096's per-item-profile rule).
export type ProfiledSuppressedEntry = SuppressedAttentionEntry & {
  profileId: number;
};

export function collectMultiProfileSuppressed(
  viewIds: readonly number[],
  units: UpcomingDisplayUnits = CANONICAL_DISPLAY_UNITS
): ProfiledSuppressedEntry[] {
  const out: ProfiledSuppressedEntry[] = [];
  for (const pid of viewIds) {
    const now = today(pid);
    for (const e of collectSuppressedAttention(pid, now, units)) {
      out.push({ ...e, profileId: pid });
    }
  }
  return out;
}
