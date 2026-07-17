// The finding follow-up BUILDER (issue #700) — the DB gather that feeds the
// domain-agnostic chain core (lib/followup.ts) and the imaging adapter
// (lib/followup-imaging.ts), per the #448 findings-builder discipline: it GATHERS
// profile-scoped DB state (linked, open follow-up care_plan_items + the imaging
// studies that are their sources and their resolving candidates) and maps each into
// the shared UpcomingItem every surface renders. It owns no state/interval logic —
// the state machine + persistence contract are the pure core — and reads through the
// profile-scoped query layer, so the profile-scoping guard is unaffected.
//
// Care tier, deliberately (#449): a possibly-missed nodule re-scan is the highest-harm
// failure the loop exists to prevent, so these items band to the act-now slice (an
// overdue one lands on the non-hideable Needs-attention hero), carry the #656 reason
// ("for the 6 mm RLL nodule (2026-03)"), and — once OVERDUE — are care-persistent:
// they resist an indefinite dismiss (isItemHiddenBySuppression) the way a dose
// escalation resists the bus. The dedupeKey prefix (FOLLOWUP_PREFIX) is registered in
// RULE_FINDING_PREFIXES so the reflection guard proves the keys are guardable.
//
// Resolution is confirm-first (#560): when a matching later study has landed the item
// switches to a resolvable OFFER carrying the resolve payload — the app never
// auto-resolves; the user records resolved/stable/changed against the later study.

import { getCarePlanItems, getImagingStudies } from "./queries/clinical";
import { isCarePlanItemOpen } from "./care-plan-upcoming";
import {
  followUpState,
  followUpSuppressionPolicy,
  FOLLOWUP_PREFIX,
  type FollowUpItemLike,
} from "./followup";
import {
  imagingFollowUpAdapter,
  IMAGING_FOLLOWUP_KIND,
} from "./followup-imaging";
import { followUpSourceReason } from "./reasons";
import type { UpcomingItem } from "./upcoming";
import type { ImagingStudy } from "./types";
import type { AppRoute } from "./hrefs";

// The follow-up's source + resolutions live on the Imaging page, where the study and
// its serial view are shown; the inline resolve controls act on the row itself.
const FOLLOWUP_HREF: AppRoute = "/imaging";

// The imaging follow-up items for the Upcoming/hero surface. Reads every OPEN, linked
// (source_kind='imaging'), UNRESOLVED follow-up, resolves its source study + a
// possible resolving study through the imaging adapter, and emits one care-tier
// UpcomingItem per follow-up in its current state (resolvable > overdue > upcoming).
// Not suppression-filtered here — the shared filter (collectUpcoming) applies the
// care-tier persistence policy via the item's carePersistent flag.
export function followUpItems(
  profileId: number,
  today: string
): UpcomingItem[] {
  const carePlan = getCarePlanItems(profileId);
  const linked = carePlan.filter(
    (c) =>
      c.source_kind === IMAGING_FOLLOWUP_KIND &&
      c.source_imaging_study_id != null &&
      c.resolution == null &&
      isCarePlanItemOpen(c.status)
  );
  if (linked.length === 0) return [];

  const studies = getImagingStudies(profileId);
  const byId = new Map<number, ImagingStudy>(studies.map((s) => [s.id, s]));

  const items: UpcomingItem[] = [];
  for (const c of linked) {
    const source = byId.get(c.source_imaging_study_id!);
    // Defensive: a follow-up whose source study is gone was de-linked (source_kind
    // nulled) at the delete seam, so this shouldn't hit — skip if it somehow does.
    if (!source) continue;

    const followUp: FollowUpItemLike = {
      id: c.id,
      title: c.description,
      plannedDate: c.planned_date,
      recommendedIntervalDays: c.recommended_interval_days,
      source: { kind: IMAGING_FOLLOWUP_KIND, recordId: source.id },
      resolution: null,
    };

    const resolving = imagingFollowUpAdapter.findResolvingRecord(
      source,
      followUp,
      studies
    );
    const state = followUpState(c.planned_date, today, resolving != null);
    const policy = followUpSuppressionPolicy(state);
    const sourceLabel = imagingFollowUpAdapter.describeSource(source);
    const baseTitle = imagingFollowUpAdapter.followUpTitle(source);

    if (state === "resolvable" && resolving) {
      const resolvingLabel =
        imagingFollowUpAdapter.describeResolvingRecord(resolving);
      items.push({
        key: `${FOLLOWUP_PREFIX}${c.id}`,
        domain: "followup",
        title: `${baseTitle} — record the outcome?`,
        detail:
          `A later ${resolvingLabel} is on file for the ${sourceLabel}. ` +
          `Mark this finding resolved, stable, or changed against it.`,
        reasons: [followUpSourceReason(sourceLabel)],
        href: FOLLOWUP_HREF,
        dueDate: c.planned_date,
        band: "today",
        dueText: "Review",
        followUpResolve: {
          carePlanItemId: c.id,
          resolvingRecordId: resolving.id,
        },
      });
      continue;
    }

    // Upcoming or overdue: the "do this follow-up" nag. An overdue one is
    // care-persistent (resists an indefinite dismiss) and its detail states lateness.
    const overdue = state === "overdue";
    items.push({
      key: `${FOLLOWUP_PREFIX}${c.id}`,
      domain: "followup",
      title: baseTitle,
      detail: overdue
        ? `Overdue follow-up for the ${sourceLabel} — book it or record the result.`
        : `Tracked follow-up for the ${sourceLabel}.`,
      reasons: [followUpSourceReason(sourceLabel)],
      href: FOLLOWUP_HREF,
      dueDate: c.planned_date,
      carePersistent: overdue ? true : undefined,
    });
  }
  return items;
}
