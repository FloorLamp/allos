// The finding follow-up BUILDER (issue #700) — the DB gather that feeds the
// domain-agnostic chain core (lib/followup.ts) and each domain adapter (imaging:
// lib/followup-imaging.ts; flagged labs: lib/followup-labs.ts), per the #448
// findings-builder discipline: it GATHERS profile-scoped DB state (linked, open
// follow-up care_plan_items + the domain records that are their sources and their
// resolving candidates) and maps each into the shared UpcomingItem every surface
// renders. It owns no state/interval logic — the state machine + persistence contract
// are the pure core — and reads through the profile-scoped query layer, so the
// profile-scoping guard is unaffected.
//
// Care tier, deliberately (#449): a possibly-missed nodule re-scan or an un-rechecked
// flagged lab is the highest-harm failure the loop exists to prevent, so these items
// band to the act-now slice (an overdue one lands on the non-hideable Needs-attention
// hero), carry the #656 reason ("for the 6 mm RLL nodule (2026-03)" / "for the flagged
// 8.2% (2026-05)"), and — once OVERDUE — are care-persistent: they resist an indefinite
// dismiss (isItemHiddenBySuppression) the way a dose escalation resists the bus. The
// dedupeKey prefix (FOLLOWUP_PREFIX) is registered in RULE_FINDING_PREFIXES so the
// reflection guard proves the keys are guardable.
//
// Resolution is confirm-first (#560): when a matching later record has landed the item
// switches to a resolvable OFFER carrying the resolve payload — the app never
// auto-resolves; the user records resolved/stable/changed against the later record.
//
// One care-tier follow-up builder, many adapters: the DOMAIN-SPECIFIC glue (which
// care_plan_items are linked, how to load the domain records, the source FK column,
// where the item links) is a small FollowUpDomain descriptor; the surface copy + the
// state machine + the care-tier banding are shared across every domain.

import {
  getCarePlanItems,
  getImagingStudies,
  getLabFollowUpRecords,
  getIopFollowUpRecords,
  getDentalProcedures,
  getSkinLesions,
} from "./queries/clinical";
import { isCarePlanItemOpen } from "./care-plan-upcoming";
import {
  followUpState,
  FOLLOWUP_PREFIX,
  type FollowUpItemLike,
  type FollowUpAdapter,
} from "./followup";
import {
  imagingFollowUpAdapter,
  IMAGING_FOLLOWUP_KIND,
} from "./followup-imaging";
import {
  labsFollowUpAdapter,
  LABS_FOLLOWUP_KIND,
  type LabFollowUpRecord,
} from "./followup-labs";
import {
  iopFollowUpAdapter,
  IOP_FOLLOWUP_KIND,
  type IopFollowUpRecord,
} from "./followup-iop";
import { dentalFollowUpAdapter, DENTAL_FOLLOWUP_KIND } from "./followup-dental";
import { skinFollowUpAdapter, SKIN_FOLLOWUP_KIND } from "./followup-skin";
import { followUpSourceReason } from "./reasons";
import { biomarkerViewHref } from "./hrefs";
import type { UpcomingItem } from "./upcoming";
import type {
  CarePlanItem,
  ImagingStudy,
  DentalProcedure,
  SkinLesion,
} from "./types";
import type { AppRoute } from "./hrefs";

// The per-domain glue the shared builder needs: the adapter (the pure domain
// questions), how to gather the domain's records for a profile, the record's id, the
// care_plan_items FK column that carries the source link, and where a follow-up item
// deep-links. Everything else (state, copy, banding, key) is shared below.
interface FollowUpDomain<S> {
  kind: string;
  adapter: FollowUpAdapter<S, S>;
  loadRecords: (profileId: number) => S[];
  recordId: (record: S) => number;
  sourceIdOf: (item: CarePlanItem) => number | null;
  hrefFor: (source: S) => AppRoute;
}

// Imaging: the follow-up + its serial view live on /imaging; the inline resolve
// controls act on the study row there.
const IMAGING_DOMAIN: FollowUpDomain<ImagingStudy> = {
  kind: IMAGING_FOLLOWUP_KIND,
  adapter: imagingFollowUpAdapter,
  loadRecords: getImagingStudies,
  recordId: (s) => s.id,
  sourceIdOf: (c) => c.source_imaging_study_id,
  hrefFor: () => "/imaging",
};

// Flagged labs: the follow-up's source flagged reading + its serial trend live on the
// biomarker detail page, keyed by the reading's canonical name (#482); the biomarkerViewHref
// rule gates on canonicalization and falls back to the biomarkers list otherwise.
const LABS_DOMAIN: FollowUpDomain<LabFollowUpRecord> = {
  kind: LABS_FOLLOWUP_KIND,
  adapter: labsFollowUpAdapter,
  loadRecords: getLabFollowUpRecords,
  recordId: (r) => r.id,
  sourceIdOf: (c) => c.source_medical_record_id,
  hrefFor: (r) => biomarkerViewHref(r.canonical_name, r.name),
};

// IOP glaucoma follow-up (#698 §6): an elevated intraocular pressure awaiting a
// glaucoma workup. Same medical_records FK column as labs (an IOP reading IS a
// biomarker), but its OWN adapter (glaucoma-workup copy, bilateral "one question")
// and source_kind='iop'. The follow-up + its serial pressures live on the biomarker
// detail page; the loadRecords pool is IOP-only, so any later reading is a repeat.
const IOP_DOMAIN: FollowUpDomain<IopFollowUpRecord> = {
  kind: IOP_FOLLOWUP_KIND,
  adapter: iopFollowUpAdapter,
  loadRecords: getIopFollowUpRecords,
  recordId: (r) => r.id,
  sourceIdOf: (c) => c.source_medical_record_id,
  hrefFor: (r) => biomarkerViewHref(r.canonical_name, r.name),
};

// Dental follow-up (#705 ask 5): a "watch #14, recheck in 6 months" caries watch or a
// "periodontal re-eval in 3 months" plan on a dental_procedures row. Its own adapter
// (tooth-anchored recheck copy) and source_kind='dental'; the follow-up + the dental
// record it hangs off live on /dental; a LATER record on the same tooth resolves it.
const DENTAL_DOMAIN: FollowUpDomain<DentalProcedure> = {
  kind: DENTAL_FOLLOWUP_KIND,
  adapter: dentalFollowUpAdapter,
  loadRecords: getDentalProcedures,
  recordId: (p) => p.id,
  sourceIdOf: (c) => c.source_dental_procedure_id,
  hrefFor: () => "/dental",
};

// Skin follow-up (#715 ask 3): a "watch this mole, recheck in 3 months" record on a
// skin_lesions row. Its own adapter (lesion-anchored recheck copy) and
// source_kind='skin'; the follow-up + the lesion it hangs off live on /skin; a LATER
// record of the SAME lesion resolves it.
const SKIN_DOMAIN: FollowUpDomain<SkinLesion> = {
  kind: SKIN_FOLLOWUP_KIND,
  adapter: skinFollowUpAdapter,
  loadRecords: getSkinLesions,
  recordId: (l) => l.id,
  sourceIdOf: (c) => c.source_skin_lesion_id,
  hrefFor: () => "/skin",
};

// The follow-up items for ONE domain: every OPEN, linked (source_kind = domain.kind),
// UNRESOLVED follow-up, resolving its source record + a possible resolving record
// through the domain adapter, emitted as one care-tier UpcomingItem in its current
// state (resolvable > overdue > upcoming). Not suppression-filtered here — the shared
// filter (collectUpcoming) applies the care-tier persistence policy via carePersistent.
function domainFollowUpItems<S>(
  profileId: number,
  today: string,
  carePlan: CarePlanItem[],
  domain: FollowUpDomain<S>
): UpcomingItem[] {
  const linked = carePlan.filter(
    (c) =>
      c.source_kind === domain.kind &&
      domain.sourceIdOf(c) != null &&
      c.resolution == null &&
      isCarePlanItemOpen(c.status)
  );
  if (linked.length === 0) return [];

  const records = domain.loadRecords(profileId);
  const byId = new Map<number, S>(records.map((r) => [domain.recordId(r), r]));

  const items: UpcomingItem[] = [];
  for (const c of linked) {
    const source = byId.get(domain.sourceIdOf(c)!);
    // Defensive: a follow-up whose source record is gone was de-linked (source_kind
    // nulled) at the delete seam, so this shouldn't hit — skip if it somehow does.
    if (!source) continue;

    const followUp: FollowUpItemLike = {
      id: c.id,
      title: c.description,
      plannedDate: c.planned_date,
      recommendedIntervalDays: c.recommended_interval_days,
      source: { kind: domain.kind, recordId: domain.recordId(source) },
      resolution: null,
    };

    const resolving = domain.adapter.findResolvingRecord(
      source,
      followUp,
      records
    );
    const state = followUpState(c.planned_date, today, resolving != null);
    const sourceLabel = domain.adapter.describeSource(source);
    const baseTitle = domain.adapter.followUpTitle(source);
    const href = domain.hrefFor(source);

    if (state === "resolvable" && resolving) {
      const resolvingLabel = domain.adapter.describeResolvingRecord(resolving);
      items.push({
        key: `${FOLLOWUP_PREFIX}${c.id}`,
        domain: "followup",
        title: `${baseTitle} — record the outcome?`,
        detail:
          `A later ${resolvingLabel} is on file for the ${sourceLabel}. ` +
          `Mark this finding resolved, stable, or changed against it.`,
        reasons: [followUpSourceReason(sourceLabel)],
        href,
        dueDate: c.planned_date,
        band: "today",
        dueText: "Review",
        followUpResolve: {
          carePlanItemId: c.id,
          resolvingRecordId: domain.recordId(resolving),
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
      href,
      dueDate: c.planned_date,
      carePersistent: overdue ? true : undefined,
    });
  }
  return items;
}

// The finding follow-up items for the Upcoming/hero surface, across every domain
// adapter (imaging + flagged labs). Reads the profile's care_plan_items once and fans
// each domain over it.
export function followUpItems(
  profileId: number,
  today: string
): UpcomingItem[] {
  const carePlan = getCarePlanItems(profileId);
  return [
    ...domainFollowUpItems(profileId, today, carePlan, IMAGING_DOMAIN),
    ...domainFollowUpItems(profileId, today, carePlan, LABS_DOMAIN),
    ...domainFollowUpItems(profileId, today, carePlan, IOP_DOMAIN),
    ...domainFollowUpItems(profileId, today, carePlan, DENTAL_DOMAIN),
    ...domainFollowUpItems(profileId, today, carePlan, SKIN_DOMAIN),
  ];
}
