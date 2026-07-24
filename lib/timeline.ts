import { activityComponentSportNames } from "./activity-icon";
import { shiftDateStr } from "./date";
import { db, today } from "./db";
import type { MemberTimeline } from "./timeline-multi";
import { encounterTypeDisplay } from "./encounter-kind";
import { vaccineDisplayName } from "./immunization-catalog";
import { medicationCourseEvents } from "./medication-history";
import { ENCOUNTER_REPRESENTATIVE_IDS } from "./queries/medical";
import {
  CONDITION_REPRESENTATIVE_IDS,
  ALLERGY_REPRESENTATIVE_IDS,
} from "./queries/clinical";
import { restrictedActivityTypeClause, isTrainingRestricted } from "./age-gate";
import type { MedStopReason } from "./types";
import { summarizeExercise, type SetRow } from "./journal-format";
import { getTimezone, type UnitPrefs } from "./settings";
import {
  compactList,
  countTone,
  dateFromCreatedAt,
  journalActivityHref,
  medicalRecordHref,
  parseDetailItems,
  protocolTimelineEvents,
  sortTimelineEvents,
  timeFromCreatedAt,
  visitLinkedRefs,
  type TimelineEvent,
  type VisitLinkedRow,
} from "./timeline-format";
import { fmtDistance, fmtTemp, fmtWeight } from "./units";
import {
  studyDisplayLabel,
  modalityLabel,
  lateralityLabel,
} from "./imaging-study";
import type { ImagingModality, ImagingLaterality } from "./types/medical";

export { TIMELINE_CATEGORIES, timelineCategoryLabel } from "./timeline-format";
export type {
  TimelineCategory,
  TimelineDay,
  TimelineEvent,
} from "./timeline-format";
import {
  encounterHref,
  immunizationHref,
  importHref,
  intakeHref,
  timelineDayHref,
} from "./hrefs";
import { symptomLabel, severityLabel } from "./symptoms";
import {
  allEpisodesForProfile,
  assembleIllnessEpisode,
} from "./illness-episode";
import { episodeHeadline } from "./illness-episode-format";
import { episodeHref } from "./hrefs";

export interface TimelineOptions {
  category?: TimelineEvent["category"];
  startDate?: string;
  endDate?: string;
  limit?: number;
  units?: UnitPrefs;
  includeTrainingEvents?: boolean;
  // Age-restricted profile (#489/#618): the FULL training domain (strength
  // activities + goals) is hidden, but the age-neutral duration activities
  // (sport/cardio) that /training's RestrictedActivityView still shows remain
  // visible — the type-aware successor to the old all-or-nothing
  // includeTrainingEvents=false. Ignored when includeTrainingEvents is false.
  restricted?: boolean;
  // Multi-view Timeline (#1329): the profile whose day a per-day deep-link
  // (`timelineDayHref` on symptom/practice events) should land on. Set ONLY by the
  // cross-profile gather (getMultiProfileTimeline) to the member being gathered, so a
  // day link carries whose day it is and the single-day view lands on the SUBJECT's
  // day context — never a mixed-subject edit surface. Undefined (every single-view
  // caller) leaves the link byte-identical.
  dayLinkProfileId?: number;
}

export interface TimelinePage {
  events: TimelineEvent[];
  hasMore: boolean;
}

// Clamp the caller-supplied page size into a sane window.
function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 250, 25), 1000);
}

// Build a bindable `AND <col> >= ? [AND <col> <= ?]` fragment for the requested
// date window, pushing the range into SQL so a bounded query returns the correct
// rows regardless of history length (the dates are bound as params, never
// concatenated). An open bound (undefined) is omitted, so the default/"All time"
// view leaves the upper bound open and future-dated rows are returned. `col` is a
// trusted, code-defined column/expression — never user input.
function dateBounds(
  col: string,
  startDate: string | undefined,
  endDate: string | undefined
): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (startDate) {
    parts.push(`${col} >= ?`);
    params.push(startDate);
  }
  if (endDate) {
    parts.push(`${col} <= ?`);
    params.push(endDate);
  }
  return { clause: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}

function pushLimited(
  events: TimelineEvent[],
  event: TimelineEvent,
  options: TimelineOptions
) {
  if (options.category && event.category !== options.category) return;
  if (options.startDate && event.date < options.startDate) return;
  if (options.endDate && event.date > options.endDate) return;
  events.push(event);
}

function activitySetSummaries(
  profileId: number,
  activityIds: number[],
  units: UnitPrefs
): Map<number, { label: string; value: string }[]> {
  if (activityIds.length === 0) return new Map();

  const placeholders = activityIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.activity_id, s.exercise, s.set_number, s.weight_kg, s.reps,
              s.weight_kg_right, s.reps_right, s.duration_sec,
              s.duration_sec_right, s.target_reps, s.to_failure
         FROM exercise_sets s
         JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ? AND s.activity_id IN (${placeholders})
        ORDER BY s.activity_id, lower(s.exercise), s.set_number`
    )
    .all(profileId, ...activityIds) as (SetRow & {
    activity_id: number;
    exercise: string;
  })[];

  const byActivity = new Map<number, Map<string, SetRow[]>>();
  const labels = new Map<string, string>();
  for (const row of rows) {
    let exercises = byActivity.get(row.activity_id);
    if (!exercises) {
      exercises = new Map();
      byActivity.set(row.activity_id, exercises);
    }
    const key = row.exercise.trim().toLowerCase();
    labels.set(`${row.activity_id}:${key}`, row.exercise);
    const sets = exercises.get(key) ?? [];
    sets.push(row);
    exercises.set(key, sets);
  }

  const out = new Map<number, { label: string; value: string }[]>();
  for (const [activityId, exercises] of byActivity.entries()) {
    out.set(
      activityId,
      Array.from(exercises.entries()).map(([key, sets]) => ({
        label: labels.get(`${activityId}:${key}`) ?? key,
        value: summarizeExercise(sets, units.weightUnit).text,
      }))
    );
  }
  return out;
}

// Sibling records a single import document produced alongside a visit (#662): the
// care-plan items, procedures, and medications sharing the visit's document_id.
// Each SELECT is a LITERAL, profile-scoped string (never runtime-built), so the
// source-scanning scoping guard can verify profile_id is present; the medication
// gather also pins source='extracted' (a MANUAL med with a NULL document_id can't
// leak in, and only imported meds carry a document_id anyway). Capped small — a
// visit's linked-context list is a reference, not an exhaustive dump.
const LINEAGE_CAP = 8;
function visitLineageRows(
  profileId: number,
  documentId: number
): VisitLinkedRow[] {
  const procedures = db
    .prepare(
      `SELECT name FROM procedures
        WHERE profile_id = ? AND document_id = ? AND TRIM(COALESCE(name,'')) != ''
        ORDER BY date DESC, id DESC LIMIT ?`
    )
    .all(profileId, documentId, LINEAGE_CAP) as { name: string }[];
  const carePlan = db
    .prepare(
      `SELECT description FROM care_plan_items
        WHERE profile_id = ? AND document_id = ?
          AND TRIM(COALESCE(description,'')) != ''
        ORDER BY COALESCE(planned_date, created_at) DESC, id DESC LIMIT ?`
    )
    .all(profileId, documentId, LINEAGE_CAP) as { description: string }[];
  const medications = db
    .prepare(
      `SELECT name FROM intake_items
        WHERE profile_id = ? AND document_id = ? AND source = 'extracted'
          AND TRIM(COALESCE(name,'')) != ''
        ORDER BY id DESC LIMIT ?`
    )
    .all(profileId, documentId, LINEAGE_CAP) as { name: string }[];
  return [
    ...procedures.map((r) => ({ kind: "procedure" as const, label: r.name })),
    ...carePlan.map((r) => ({
      kind: "care-plan" as const,
      label: r.description,
    })),
    ...medications.map((r) => ({
      kind: "medication" as const,
      label: r.name,
    })),
  ];
}

// Collect + merge + sort every category's events for the profile. Each per-table
// query pushes the requested date window into SQL AND caps at `perTableLimit`
// most-recent in-range rows. Because the global top-N of the merge is a subset of
// each table's own top-N, fetching perTableLimit per table and sorting the union
// renders the top-N page correctly. Returns the FULL sorted union (unsliced) so a
// caller can both slice a page and detect whether more history exists.
function collectEvents(
  profileId: number,
  options: TimelineOptions,
  perTableLimit: number
): TimelineEvent[] {
  const units = options.units ?? {
    weightUnit: "kg",
    distanceUnit: "km",
    temperatureUnit: "F",
  };
  const includeTrainingEvents = options.includeTrainingEvents ?? true;
  const restricted = options.restricted ?? false;
  const tz = getTimezone(profileId);
  const events: TimelineEvent[] = [];

  // Exact bounds for tables whose event date IS a stored calendar column.
  const exact = (col: string) =>
    dateBounds(col, options.startDate, options.endDate);
  // Loose (±1 day) bounds for created-at-fallback tables: the event date is
  // derived in the profile timezone (see dateFromCreatedAt), which can differ by a
  // day from the raw UTC date the SQL compares — so widen the SQL window by a day
  // and let pushLimited apply the precise, tz-correct final filter. Explicit
  // user-supplied windows still resolve exactly at the JS boundary.
  const looseStart = options.startDate
    ? shiftDateStr(options.startDate, -1)
    : undefined;
  const looseEnd = options.endDate
    ? shiftDateStr(options.endDate, 1)
    : undefined;
  const loose = (col: string) => dateBounds(col, looseStart, looseEnd);

  if (includeTrainingEvents) {
    const activityBounds = exact("date");
    const activities = db
      .prepare(
        `SELECT id, date, type, title, duration_min, distance_km, intensity, start_time, notes, source, components
           FROM activities
          WHERE profile_id = ?${restrictedActivityTypeClause(
            restricted
          )}${activityBounds.clause}
          ORDER BY date DESC, id DESC
          LIMIT ?`
      )
      .all(profileId, ...activityBounds.params, perTableLimit) as {
      id: number;
      date: string;
      type: string;
      title: string;
      duration_min: number | null;
      distance_km: number | null;
      intensity: string | null;
      start_time: string | null;
      notes: string | null;
      source: string | null;
      components: string | null;
    }[];
    const setSummaries = activitySetSummaries(
      profileId,
      activities.map((a) => a.id),
      units
    );
    for (const a of activities) {
      const meta = [
        a.type,
        a.duration_min != null ? `${a.duration_min} min` : null,
        a.distance_km != null
          ? fmtDistance(a.distance_km, units.distanceUnit)
          : null,
        a.intensity,
      ].filter((x): x is string => !!x);
      pushLimited(
        events,
        {
          id: `activity:${a.id}`,
          date: a.date,
          category: "activity",
          title: a.title,
          subtitle: compactList(meta, 4),
          detail: a.notes,
          href: journalActivityHref(a.id),
          sortTime: a.start_time,
          meta: a.source ? [a.source] : undefined,
          detailItems: setSummaries.get(a.id),
          iconType: a.type,
          iconTitle: a.title,
          iconSportNames: activityComponentSportNames(a.components),
        },
        options
      );
    }
  }

  const bodyBounds = exact("date");
  const bodyRows = db
    .prepare(
      `SELECT id, date, weight_kg, body_fat_pct, resting_hr, notes, source
         FROM body_metrics
        WHERE profile_id = ?${bodyBounds.clause}
        ORDER BY date DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, ...bodyBounds.params, perTableLimit) as {
    id: number;
    date: string;
    weight_kg: number | null;
    body_fat_pct: number | null;
    resting_hr: number | null;
    notes: string | null;
    source: string | null;
  }[];
  for (const b of bodyRows) {
    const meta = [
      b.weight_kg != null ? fmtWeight(b.weight_kg, units.weightUnit) : null,
      b.body_fat_pct != null ? `${b.body_fat_pct}% body fat` : null,
      b.resting_hr != null ? `${b.resting_hr} bpm resting` : null,
    ].filter((x): x is string => !!x);
    pushLimited(
      events,
      {
        id: `body:${b.id}`,
        date: b.date,
        category: "body",
        title: "Body metrics logged",
        subtitle: compactList(meta, 3),
        detail: b.notes,
        href: "/trends?tab=body",
        meta: b.source && b.source !== "manual" ? [b.source] : undefined,
      },
      options
    );
  }

  const medicalBounds = exact("date");
  const medicalGroups = db
    .prepare(
      `SELECT date, COALESCE(NULLIF(TRIM(panel), ''), category) AS panel,
              COUNT(*) AS count,
              SUM(CASE WHEN flag IN ('high','low','abnormal') THEN 1 ELSE 0 END) AS abnormal_count,
              SUM(CASE WHEN flag LIKE 'non-optimal%' THEN 1 ELSE 0 END) AS nonoptimal_count,
              GROUP_CONCAT(COALESCE(NULLIF(TRIM(canonical_name), ''), name), '||') AS names,
              GROUP_CONCAT(
                COALESCE(NULLIF(TRIM(canonical_name), ''), name) || '::' ||
                TRIM(
                  COALESCE(NULLIF(TRIM(value), ''), CAST(value_num AS TEXT), '')
                ) || '::' ||
                COALESCE(NULLIF(TRIM(unit), ''), '') || '::' ||
                COALESCE(NULLIF(TRIM(flag), ''), ''),
                '||'
              ) AS result_details,
              MAX(COALESCE(NULLIF(TRIM(canonical_name), ''), name)) AS first_name,
              MAX(document_id) AS document_id,
              MAX(source) AS source
         FROM medical_records
        WHERE profile_id = ?${medicalBounds.clause}
        GROUP BY date, COALESCE(NULLIF(TRIM(panel), ''), category), document_id
        ORDER BY date DESC
        LIMIT ?`
    )
    .all(profileId, ...medicalBounds.params, perTableLimit) as {
    date: string;
    panel: string;
    count: number;
    abnormal_count: number;
    nonoptimal_count: number;
    names: string | null;
    result_details: string | null;
    first_name: string | null;
    document_id: number | null;
    source: string | null;
  }[];
  for (const m of medicalGroups) {
    const abnormal = m.abnormal_count || 0;
    const nonoptimal = m.nonoptimal_count || 0;
    const names = (m.names ?? "").split("||").filter(Boolean);
    pushLimited(
      events,
      {
        id: `medical:${m.date}:${m.panel}:${m.document_id ?? "manual"}`,
        date: m.date,
        category: "medical",
        title: `${m.panel} results`,
        subtitle: `${m.count} result${m.count === 1 ? "" : "s"}${abnormal ? `, ${abnormal} out of range` : nonoptimal ? `, ${nonoptimal} non-optimal` : ""}`,
        detail: compactList(names, 5),
        href: medicalRecordHref(m.document_id, names, m.first_name),
        tone: countTone(abnormal, nonoptimal),
        detailItems: parseDetailItems(m.result_details),
        meta: m.document_id
          ? [`Document #${m.document_id}`]
          : m.source && m.source !== "manual"
            ? [m.source]
            : undefined,
      },
      options
    );
  }

  const docBounds = loose(
    "COALESCE(document_date, substr(uploaded_at, 1, 10))"
  );
  const docs = db
    .prepare(
      `SELECT id, filename, doc_type, source, document_date, extraction_status, extracted_count, uploaded_at
         FROM medical_documents
        WHERE profile_id = ?${docBounds.clause}
        ORDER BY COALESCE(document_date, substr(uploaded_at, 1, 10)) DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, ...docBounds.params, perTableLimit) as {
    id: number;
    filename: string;
    doc_type: string | null;
    source: string | null;
    document_date: string | null;
    extraction_status: string;
    extracted_count: number;
    uploaded_at: string;
  }[];
  for (const d of docs) {
    pushLimited(
      events,
      {
        id: `document:${d.id}`,
        date: d.document_date ?? dateFromCreatedAt(d.uploaded_at, tz) ?? "",
        category: "document",
        title: d.filename,
        subtitle: compactList(
          [
            d.doc_type ?? "document",
            d.source ?? null,
            d.extracted_count
              ? `${d.extracted_count} extracted`
              : d.extraction_status,
          ].filter((x): x is string => !!x),
          3
        ),
        href: importHref(d.id),
        sortTime: timeFromCreatedAt(d.uploaded_at, tz),
        tone: d.extraction_status === "failed" ? "bad" : "default",
        meta: [
          ...(d.source ? [d.source] : []),
          `Uploaded: ${dateFromCreatedAt(d.uploaded_at, tz) ?? d.uploaded_at}`,
        ],
      },
      options
    );
  }

  const intakeBounds = exact("l.date");
  const intakeLogs = db
    .prepare(
      `SELECT l.date AS date, ii.kind AS kind, COUNT(*) AS count,
              GROUP_CONCAT(DISTINCT ii.name) AS names,
              GROUP_CONCAT(
                ii.name || '::' || COALESCE(NULLIF(TRIM(l.amount), ''),
                                            NULLIF(TRIM(d.amount), ''),
                                            'Dose confirmed') ||
                CASE WHEN ii.kind = 'medication'
                           AND COALESCE(NULLIF(TRIM(l.product), ''),
                                        NULLIF(TRIM(ii.product), '')) IS NOT NULL
                     THEN ' · ' || COALESCE(NULLIF(TRIM(l.product), ''),
                                             TRIM(ii.product)) ELSE '' END,
                '||'
              ) AS dose_details
         FROM intake_item_logs l
         JOIN intake_items ii ON ii.id = l.item_id
         LEFT JOIN intake_item_doses d ON d.id = l.dose_id
        WHERE ii.profile_id = ?${intakeBounds.clause}
        GROUP BY l.date, ii.kind
        ORDER BY l.date DESC
        LIMIT ?`
    )
    .all(profileId, ...intakeBounds.params, perTableLimit) as {
    date: string;
    kind: "supplement" | "medication";
    count: number;
    names: string | null;
    dose_details: string | null;
  }[];
  for (const l of intakeLogs) {
    pushLimited(
      events,
      {
        id: `intake:${l.kind}:${l.date}`,
        date: l.date,
        category: "medication",
        title:
          l.kind === "medication"
            ? "Medication doses confirmed"
            : "Supplement doses confirmed",
        subtitle: `${l.count} dose${l.count === 1 ? "" : "s"}`,
        detail: compactList((l.names ?? "").split(","), 5),
        href: intakeHref(l.kind),
        tone: "good",
        detailItems: parseDetailItems(l.dose_details),
      },
      options
    );
  }

  // Medication course start/stop events. A child of intake_items, so
  // scoped through the parent's profile_id. Each course yields up to two events
  // (a "Started" on started_on and, when closed, a "Stopped" on stopped_on with
  // its reason + any linked side effects); pushLimited applies the exact per-event
  // date window. Ordered by most-recent activity so the per-table cap keeps the
  // freshest courses. The pure shaping lives in medicationCourseEvents.
  const courseRows = db
    .prepare(
      `SELECT c.id AS course_id, ii.name AS med_name,
              c.started_on, c.stopped_on, c.stop_reason, c.notes,
              (SELECT GROUP_CONCAT(se.effect, ', ')
                 FROM intake_item_side_effects se
                WHERE se.course_id = c.id) AS side_effects
         FROM medication_courses c
         JOIN intake_items ii ON ii.id = c.item_id
        WHERE ii.profile_id = ?
        ORDER BY COALESCE(c.stopped_on, c.started_on) DESC, c.id DESC
        LIMIT ?`
    )
    .all(profileId, perTableLimit) as {
    course_id: number;
    med_name: string;
    started_on: string | null;
    stopped_on: string | null;
    stop_reason: string | null;
    notes: string | null;
    side_effects: string | null;
  }[];
  for (const event of medicationCourseEvents(
    courseRows.map((r) => ({
      courseId: r.course_id,
      medName: r.med_name,
      startedOn: r.started_on,
      stoppedOn: r.stopped_on,
      stopReason: r.stop_reason as MedStopReason | null,
      notes: r.notes,
      sideEffectSummary: r.side_effects,
    }))
  )) {
    pushLimited(events, event, options);
  }

  // Protocols (issue #161): a Started event on start_date and, when ended, an
  // Ended event on end_date. Two-sided like medication courses, so no date-bound
  // clause here — the pure shaper emits both dates and pushLimited filters each
  // against the window. Ordered by the freshest boundary.
  const protocolRows = db
    .prepare(
      `SELECT id, name, start_date, end_date
         FROM protocols
        WHERE profile_id = ?
        ORDER BY COALESCE(end_date, start_date) DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, perTableLimit) as {
    id: number;
    name: string;
    start_date: string;
    end_date: string | null;
  }[];
  for (const event of protocolTimelineEvents(protocolRows)) {
    pushLimited(events, event, options);
  }

  const immunizationBounds = exact("date");
  const immunizations = db
    .prepare(
      `SELECT id, date, vaccine, dose_label, notes
         FROM immunizations
        WHERE profile_id = ?${immunizationBounds.clause}
        ORDER BY date DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, ...immunizationBounds.params, perTableLimit) as {
    id: number;
    date: string;
    vaccine: string;
    dose_label: string | null;
    notes: string | null;
  }[];
  for (const i of immunizations) {
    pushLimited(
      events,
      {
        id: `immunization:${i.id}`,
        date: i.date,
        category: "immunization",
        title: vaccineDisplayName(i.vaccine),
        subtitle: i.dose_label,
        detail: i.notes,
        href: immunizationHref(i.vaccine),
        tone: "good",
      },
      options
    );
  }

  const conditionBounds = loose(
    "COALESCE(resolved_date, onset_date, substr(created_at, 1, 10))"
  );
  // De-duplicated across documents (#134) via CONDITION_REPRESENTATIVE_IDS so two
  // overlapping CCDs show one event per condition — its profile_id bind comes right
  // after the main WHERE's, before the date-bounds params.
  const conditions = db
    .prepare(
      `SELECT id, name, status, onset_date, resolved_date, notes, created_at
         FROM conditions
        WHERE profile_id = ?
          AND id IN (${CONDITION_REPRESENTATIVE_IDS})${conditionBounds.clause}
        ORDER BY COALESCE(resolved_date, onset_date, substr(created_at, 1, 10)) DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, profileId, ...conditionBounds.params, perTableLimit) as {
    id: number;
    name: string;
    status: string;
    onset_date: string | null;
    resolved_date: string | null;
    notes: string | null;
    created_at: string;
  }[];
  for (const c of conditions) {
    const resolved = c.resolved_date != null;
    pushLimited(
      events,
      {
        id: `condition:${c.id}`,
        date:
          c.resolved_date ??
          c.onset_date ??
          dateFromCreatedAt(c.created_at, tz) ??
          "",
        category: "condition",
        title: c.name,
        subtitle: resolved ? "Resolved condition" : `${c.status} condition`,
        detail: c.notes,
        href: "/records/problems",
        sortTime: timeFromCreatedAt(c.created_at, tz),
        tone: resolved ? "good" : "default",
      },
      options
    );
  }

  const allergyBounds = loose(
    "COALESCE(onset_date, substr(created_at, 1, 10))"
  );
  // De-duplicated across documents (#134/#384/#617) via ALLERGY_REPRESENTATIVE_IDS
  // so two overlapping CCDs each carrying "Penicillin — hives" show one event, the
  // same collapse the /allergies page and Search apply — its profile_id bind comes
  // right after the main WHERE's, before the date-bounds params.
  const allergies = db
    .prepare(
      `SELECT id, substance, reaction, severity, status, onset_date, notes, created_at
         FROM allergies
        WHERE profile_id = ?
          AND id IN (${ALLERGY_REPRESENTATIVE_IDS})${allergyBounds.clause}
        ORDER BY COALESCE(onset_date, substr(created_at, 1, 10)) DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, profileId, ...allergyBounds.params, perTableLimit) as {
    id: number;
    substance: string;
    reaction: string | null;
    severity: string | null;
    status: string;
    onset_date: string | null;
    notes: string | null;
    created_at: string;
  }[];
  for (const a of allergies) {
    pushLimited(
      events,
      {
        id: `allergy:${a.id}`,
        date: a.onset_date ?? dateFromCreatedAt(a.created_at, tz) ?? "",
        category: "allergy",
        title: a.substance,
        subtitle: compactList(
          [a.status, a.severity, a.reaction].filter((x): x is string => !!x),
          3
        ),
        detail: a.notes,
        href: "/records/problems",
        sortTime: timeFromCreatedAt(a.created_at, tz),
        tone: a.status === "active" ? "warn" : "default",
      },
      options
    );
  }

  const encounterBounds = exact("e.date");
  // De-duplicate the per-document encounter rows two overlapping CCDs produce so the
  // timeline shows each visit ONCE — the same collapse the Visits list applies, via
  // the shared representative-id subquery (the profile_id bind for it comes first).
  const encounters = db
    .prepare(
      `SELECT e.id, e.date, e.type, e.class_code, e.reason, e.diagnoses, e.notes,
              e.document_id,
              p.name AS provider_name, loc.name AS location_name
         FROM encounters e
         LEFT JOIN providers p ON p.id = e.provider_id
         LEFT JOIN providers loc ON loc.id = e.location_provider_id
        WHERE e.profile_id = ?
          AND e.id IN (${ENCOUNTER_REPRESENTATIVE_IDS})${encounterBounds.clause}
        ORDER BY e.date DESC, e.id DESC
        LIMIT ?`
    )
    .all(profileId, profileId, ...encounterBounds.params, perTableLimit) as {
    id: number;
    date: string;
    type: string | null;
    class_code: string | null;
    reason: string | null;
    diagnoses: string | null;
    notes: string | null;
    document_id: number | null;
    provider_name: string | null;
    location_name: string | null;
  }[];
  for (const e of encounters) {
    // Linked context (#662): an imported visit deep-links the OTHER records its
    // source document produced — the care-plan items / procedures / medications
    // sharing this visit's document_id (import lineage the writer already stamped).
    // Informational reference, never a causal claim; manual visits (no document)
    // carry none. Cheap: only imported visits run the gather, all profile-scoped.
    const linkedRefs =
      e.document_id != null
        ? visitLinkedRefs(visitLineageRows(profileId, e.document_id))
        : [];
    pushLimited(
      events,
      {
        id: `visit:${e.id}`,
        date: e.date,
        category: "visit",
        title: encounterTypeDisplay(e.type, e.class_code),
        subtitle: compactList(
          [e.provider_name, e.location_name, e.reason].filter(
            (x): x is string => !!x
          ),
          3
        ),
        detail: e.diagnoses ?? e.notes,
        href: encounterHref(e.id),
        ...(linkedRefs.length > 0 ? { linkedRefs } : {}),
      },
      options
    );
  }

  // Imaging studies (#702) — one first-class event per study on its study_date.
  // Study rows carry a document_id but are a distinct entity from the uploaded
  // document event; the impression is the detail. Loose-bounded on study_date with a
  // created_at fallback so an undated study still lands somewhere sensible.
  const imagingBounds = loose(
    "COALESCE(study_date, substr(created_at, 1, 10))"
  );
  const imagingStudies = db
    .prepare(
      `SELECT id, modality, body_region, laterality, contrast, study_date,
              impression, indication, created_at
         FROM imaging_studies
        WHERE profile_id = ?${imagingBounds.clause}
        ORDER BY COALESCE(study_date, substr(created_at, 1, 10)) DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, ...imagingBounds.params, perTableLimit) as {
    id: number;
    modality: ImagingModality;
    body_region: string | null;
    laterality: ImagingLaterality | null;
    contrast: number;
    study_date: string | null;
    impression: string | null;
    indication: string | null;
    created_at: string;
  }[];
  for (const s of imagingStudies) {
    const meta = [
      modalityLabel(s.modality),
      s.laterality ? lateralityLabel(s.laterality) : null,
      s.contrast ? "with contrast" : null,
      s.indication,
    ].filter((x): x is string => !!x);
    pushLimited(
      events,
      {
        id: `imaging:${s.id}`,
        date: s.study_date ?? dateFromCreatedAt(s.created_at, tz) ?? "",
        category: "imaging",
        title: studyDisplayLabel(s),
        subtitle: compactList(meta, 4),
        detail: s.impression,
        href: "/results/imaging",
        sortTime: timeFromCreatedAt(s.created_at, tz),
      },
      options
    );
  }

  if (includeTrainingEvents && !restricted) {
    const goalBounds = loose(
      "COALESCE(target_date, substr(created_at, 1, 10))"
    );
    const goals = db
      .prepare(
        `SELECT id, title, status, target_date, created_at
           FROM goals
          WHERE profile_id = ?${goalBounds.clause}
          ORDER BY COALESCE(target_date, substr(created_at, 1, 10)) DESC, id DESC
          LIMIT ?`
      )
      .all(profileId, ...goalBounds.params, perTableLimit) as {
      id: number;
      title: string;
      status: string;
      target_date: string | null;
      created_at: string;
    }[];
    for (const g of goals) {
      pushLimited(
        events,
        {
          id: `goal:${g.id}`,
          date: g.target_date ?? dateFromCreatedAt(g.created_at, tz) ?? "",
          category: "goal",
          title: g.title,
          subtitle: g.target_date
            ? `Target date, ${g.status}`
            : `Created, ${g.status}`,
          href: "/training?tab=goals",
          sortTime: timeFromCreatedAt(g.created_at, tz),
          tone: g.status === "achieved" ? "good" : "default",
        },
        options
      );
    }
  }

  const insightBounds = exact("date");
  const insights = db
    .prepare(
      `SELECT id, date, summary, model, created_at
         FROM insights
        WHERE profile_id = ?${insightBounds.clause}
        ORDER BY date DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, ...insightBounds.params, perTableLimit) as {
    id: number;
    date: string;
    summary: string;
    model: string | null;
    created_at: string;
  }[];
  for (const i of insights) {
    pushLimited(
      events,
      {
        id: `insight:${i.id}`,
        date: i.date,
        category: "insight",
        title: "AI insight",
        subtitle: i.model,
        detail: i.summary,
        href: "/trends?tab=insights",
        sortTime: timeFromCreatedAt(i.created_at, tz),
      },
      options
    );
  }

  // Milestone recognitions (#32). One event per fired milestone on its achieved_on
  // date. Not training-gated — adherence/goal milestones are relevant to every
  // profile — so it renders regardless of includeTrainingEvents.
  const milestoneBounds = exact("achieved_on");
  const milestones = db
    .prepare(
      `SELECT id, title, detail, achieved_on, created_at
         FROM milestones
        WHERE profile_id = ?${milestoneBounds.clause}
        ORDER BY achieved_on DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, ...milestoneBounds.params, perTableLimit) as {
    id: number;
    title: string;
    detail: string | null;
    achieved_on: string;
    created_at: string;
  }[];
  for (const m of milestones) {
    pushLimited(
      events,
      {
        id: `milestone:${m.id}`,
        date: m.achieved_on,
        category: "milestone",
        title: m.title,
        detail: m.detail,
        href: "/timeline?category=milestone",
        sortTime: timeFromCreatedAt(m.created_at, tz),
        tone: "good",
      },
      options
    );
  }

  // Injuries (#838): a "logged" event on the since date and, when resolved, a "resolved"
  // event on resolved_date — two-sided like conditions, so the log/resolve both surface on
  // the Timeline (NO notifications — coaching-tier, #449). Gated with the training domain
  // (an injury is a training-context concept). The affected regions ride the subtitle.
  if (includeTrainingEvents) {
    const injuries = db
      .prepare(
        `SELECT id, label, regions, status, since, resolved_date, notes, created_at
           FROM injuries
          WHERE profile_id = ?
          ORDER BY COALESCE(resolved_date, since, substr(created_at, 1, 10)) DESC, id DESC
          LIMIT ?`
      )
      .all(profileId, perTableLimit) as {
      id: number;
      label: string;
      regions: string;
      status: string;
      since: string | null;
      resolved_date: string | null;
      notes: string | null;
      created_at: string;
    }[];
    for (const inj of injuries) {
      let regionList = "";
      try {
        const parsed = JSON.parse(inj.regions);
        if (Array.isArray(parsed))
          regionList = compactList(parsed.map(String), 4);
      } catch {
        // ignore malformed region blob — the label still tells the story
      }
      const loggedDate =
        inj.since ?? dateFromCreatedAt(inj.created_at, tz) ?? "";
      pushLimited(
        events,
        {
          id: `injury:${inj.id}:logged`,
          date: loggedDate,
          category: "injury",
          title: `Injury logged: ${inj.label}`,
          subtitle: compactList(
            [inj.status, regionList].filter((x): x is string => !!x),
            2
          ),
          detail: inj.notes,
          href: "/training",
          sortTime: timeFromCreatedAt(inj.created_at, tz),
          tone: inj.status === "resolved" ? "default" : "warn",
        },
        options
      );
      if (inj.resolved_date) {
        pushLimited(
          events,
          {
            id: `injury:${inj.id}:resolved`,
            date: inj.resolved_date,
            category: "injury",
            title: `Injury resolved: ${inj.label}`,
            subtitle: regionList || null,
            href: "/training",
            tone: "good",
          },
          options
        );
      }
    }
  }

  // Endurance event plans (#839): the EVENT DAY on the calendar/timeline. One event per
  // active/completed plan on its event_date (an abandoned plan's event is dropped). The
  // completion itself is a separate milestone row (recorded by the complete action), so it
  // rides the milestone lane above — this block is the dated event marker only. Gated with
  // the training domain (an event plan is a training-context concept). NO notifications.
  if (includeTrainingEvents) {
    const planBounds = exact("event_date");
    const plans = db
      .prepare(
        `SELECT id, event_name, discipline, event_date, target_distance_km, status, created_at
           FROM endurance_plans
          WHERE profile_id = ? AND status != 'abandoned'${planBounds.clause}
          ORDER BY event_date DESC, id DESC
          LIMIT ?`
      )
      .all(profileId, ...planBounds.params, perTableLimit) as {
      id: number;
      event_name: string | null;
      discipline: string;
      event_date: string;
      target_distance_km: number;
      status: string;
      created_at: string;
    }[];
    for (const p of plans) {
      const disc =
        p.discipline === "run"
          ? "Run"
          : p.discipline === "ride"
            ? "Ride"
            : "Swim";
      const name =
        p.event_name?.trim() ||
        `${Math.round(p.target_distance_km * 10) / 10} km ${disc}`;
      pushLimited(
        events,
        {
          id: `endurance:${p.id}:event`,
          date: p.event_date,
          category: "endurance",
          title: `Event: ${name}`,
          subtitle: `${disc} · ${Math.round(p.target_distance_km * 10) / 10} km`,
          href: "/training",
          sortTime: timeFromCreatedAt(p.created_at, tz),
          tone: p.status === "completed" ? "good" : "default",
        },
        options
      );
    }
  }

  // Symptom log (#799): one event per symptom-DAY (the day's row set), so a run of
  // sick days reads as a compact per-day entry rather than N rows. Worst severity drives
  // the tone; each logged symptom is a detail item (label + severity word). Deep-links
  // back to the day for retro edit.
  const symptomBounds = exact("date");
  const symptomDays = db
    .prepare(
      `SELECT date, COUNT(*) AS count, MAX(severity) AS max_severity,
              GROUP_CONCAT(symptom || '::' || severity, '||') AS items
         FROM symptom_logs
        WHERE profile_id = ?${symptomBounds.clause}
        GROUP BY date
        ORDER BY date DESC
        LIMIT ?`
    )
    .all(profileId, ...symptomBounds.params, perTableLimit) as {
    date: string;
    count: number;
    max_severity: number;
    items: string | null;
  }[];
  for (const s of symptomDays) {
    const parsed = (s.items ?? "")
      .split("||")
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.lastIndexOf("::");
        const key = idx >= 0 ? pair.slice(0, idx) : pair;
        const sev = idx >= 0 ? Number(pair.slice(idx + 2)) : NaN;
        return { key, sev };
      })
      .sort((a, b) => b.sev - a.sev);
    pushLimited(
      events,
      {
        id: `symptom:${s.date}`,
        date: s.date,
        category: "symptom",
        title: `${s.count} symptom${s.count === 1 ? "" : "s"} logged`,
        subtitle: compactList(
          parsed.map((p) => symptomLabel(p.key)),
          5
        ),
        href: timelineDayHref(s.date, options.dayLinkProfileId),
        tone: s.max_severity >= 3 ? "warn" : "default",
        detailItems: parsed.map((p) => ({
          label: symptomLabel(p.key),
          value: Number.isFinite(p.sev) ? severityLabel(p.sev) : "",
        })),
      },
      options
    );
  }

  // Wellness-practice sessions (#1259): one event per practice-DAY (the day's session
  // set), so a run of red-light days reads as a compact per-day entry. The dedicated
  // practice_logs store gets its own timeline entry (the cost of the reuse-a-store
  // exception, #860/#944). Each session's time/duration is a detail item; deep-links back
  // to the day.
  const practiceBounds = exact("date");
  const practiceDays = db
    .prepare(
      `SELECT date, practice, COUNT(*) AS count,
              GROUP_CONCAT(
                COALESCE(time, '') || '::' || COALESCE(duration_min, ''),
                '||'
              ) AS sessions
         FROM practice_logs
        WHERE profile_id = ?${practiceBounds.clause}
        GROUP BY date, practice
        ORDER BY date DESC
        LIMIT ?`
    )
    .all(profileId, ...practiceBounds.params, perTableLimit) as {
    date: string;
    practice: string;
    count: number;
    sessions: string | null;
  }[];
  for (const p of practiceDays) {
    const sessions = (p.sessions ?? "")
      .split("||")
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.lastIndexOf("::");
        const time = idx >= 0 ? pair.slice(0, idx) : "";
        const durRaw = idx >= 0 ? pair.slice(idx + 2) : "";
        const dur = durRaw ? Number(durRaw) : null;
        return { time, dur };
      });
    const detailItems = sessions.map((s, i) => ({
      label: s.time || `Session ${i + 1}`,
      value:
        s.dur != null && Number.isFinite(s.dur) ? `${s.dur} min` : "Logged",
    }));
    pushLimited(
      events,
      {
        id: `practice:${p.date}:${p.practice}`,
        date: p.date,
        category: "practice",
        title: p.practice,
        subtitle: p.count === 1 ? "1 session" : `${p.count} sessions`,
        href: timelineDayHref(p.date, options.dayLinkProfileId),
        detailItems,
      },
      options
    );
  }

  // Illness episodes (#801): one STORY card per derived episode, spanning the range and
  // anchored at its last active day (today for an ongoing one). The headline + details
  // format over the SAME assembly the detail + share pages use — no second engine (#221).
  // The per-day symptom events above stay as the granular detail beneath the card.
  for (const ep of allEpisodesForProfile(profileId)) {
    const assembled = assembleIllnessEpisode(profileId, ep);
    if (
      assembled.distinctSymptomCount === 0 &&
      assembled.temperatures.length === 0 &&
      assembled.totalAdministrations === 0
    )
      continue; // an empty episode has no story to tell
    const anchor = assembled.lastActiveDay;
    if (!anchor) continue;
    if (assembled.id == null) continue; // no stable row → no detail route to link
    const detailItems: NonNullable<TimelineEvent["detailItems"]> = [];
    for (const s of assembled.symptoms.slice(0, 6))
      detailItems.push({ label: s.label, value: severityLabel(s.maxSeverity) });
    if (assembled.maxTempF != null)
      detailItems.push({
        label: "Peak temp",
        value: fmtTemp(assembled.maxTempF, units.temperatureUnit),
      });
    for (const m of assembled.medications.slice(0, 4))
      detailItems.push({ label: m.name, value: `${m.count}×` });
    pushLimited(
      events,
      {
        id: `illness:${ep.situation}:${ep.start ?? "open"}`,
        date: anchor,
        category: "illness",
        title: episodeHeadline(assembled),
        subtitle: assembled.ongoing
          ? "Ongoing illness episode"
          : "Illness episode",
        href: episodeHref(assembled.id),
        tone: assembled.ongoing ? "warn" : "default",
        detailItems,
      },
      options
    );
  }

  return sortTimelineEvents(events);
}

export function getTimelineEvents(
  profileId: number,
  options: TimelineOptions = {}
): TimelineEvent[] {
  const limit = clampLimit(options.limit);
  return collectEvents(profileId, options, limit).slice(0, limit);
}

// Paginated variant used by the Timeline page: fetches one extra event per table
// so it can report whether history extends beyond the current page (powering the
// "Load more" control) without a second round of queries.
export function getTimelinePage(
  profileId: number,
  options: TimelineOptions = {}
): TimelinePage {
  const limit = clampLimit(options.limit);
  const all = collectEvents(profileId, options, limit + 1);
  return { events: all.slice(0, limit), hasMore: all.length > limit };
}

// Cross-profile Timeline gather (issue #1329) — the list-first, LOOP-composed multi-view
// read. It takes the resolved view-set (`scope.viewIds`, already ∩ accessible), never
// imports lib/auth, and composes the EXISTING per-profile getTimelinePage over each
// member. DELIBERATELY loop-composed, not set-based `profile_id IN` SQL: every member's
// day bucketing is derived from that member's OWN today()/timezone (the per-profile-
// context trap, #1096) and the per-table caps apply PER MEMBER (a chatty member can't
// evict a quiet member's day — #304), which a shared-clock SQL read would violate. So
// there is no new cross-profile SQL module to register — only a merge of per-profile
// results (the pure merge lives in lib/timeline-multi.ts). Each member's per-day
// deep-links carry that member's own profile id so the single-day view lands on the
// SUBJECT's day context. `hasMore` is true when ANY member has more history.
export function getMultiProfileTimeline(
  viewIds: readonly number[],
  options: Omit<TimelineOptions, "restricted" | "dayLinkProfileId"> = {}
): { members: MemberTimeline[]; hasMore: boolean } {
  const members: MemberTimeline[] = [];
  let hasMore = false;
  for (const pid of viewIds) {
    const page = getTimelinePage(pid, {
      ...options,
      restricted: isTrainingRestricted(pid),
      dayLinkProfileId: pid,
    });
    if (page.hasMore) hasMore = true;
    members.push({
      profileId: pid,
      today: today(pid),
      events: page.events.map((e) => ({ ...e, profileId: pid })),
    });
  }
  return { members, hasMore };
}

export function getTimelineDates(
  profileId: number,
  options: Pick<TimelineOptions, "includeTrainingEvents" | "restricted"> = {}
): string[] {
  const includeTrainingEvents = options.includeTrainingEvents ?? true;
  const restricted = options.restricted ?? false;
  const tz = getTimezone(profileId);
  const dates = new Set<string>();
  const add = (d: string | null | undefined) => {
    if (d) dates.add(d);
  };

  // Explicit-date tables: the event date IS a stored calendar column, so the raw
  // slice matches where the timeline places the event. Activities are type-aware
  // for a restricted profile (#618, same set RestrictedActivityView shows); goals
  // stay gated. `date`-column selects go straight into this UNION.
  const explicitSelects: string[] = [
    "SELECT date FROM body_metrics WHERE profile_id = @profileId",
    "SELECT date FROM medical_records WHERE profile_id = @profileId",
    `SELECT l.date AS date
       FROM intake_item_logs l
       JOIN intake_items ii ON ii.id = l.item_id
      WHERE ii.profile_id = @profileId`,
    "SELECT date FROM immunizations WHERE profile_id = @profileId",
    "SELECT date FROM encounters WHERE profile_id = @profileId",
    "SELECT date FROM insights WHERE profile_id = @profileId",
    "SELECT achieved_on AS date FROM milestones WHERE profile_id = @profileId",
    "SELECT date FROM symptom_logs WHERE profile_id = @profileId",
    "SELECT date FROM practice_logs WHERE profile_id = @profileId",
    "SELECT start_date AS date FROM protocols WHERE profile_id = @profileId",
    `SELECT end_date AS date FROM protocols
      WHERE profile_id = @profileId AND end_date IS NOT NULL`,
  ];
  if (includeTrainingEvents) {
    explicitSelects.push(
      `SELECT date FROM activities
        WHERE profile_id = @profileId${restrictedActivityTypeClause(restricted)}`,
      "SELECT since AS date FROM injuries WHERE profile_id = @profileId AND since IS NOT NULL",
      `SELECT resolved_date AS date FROM injuries
        WHERE profile_id = @profileId AND resolved_date IS NOT NULL`,
      `SELECT event_date AS date FROM endurance_plans
        WHERE profile_id = @profileId AND status != 'abandoned'`
    );
  }
  for (const r of db
    .prepare(
      `SELECT DISTINCT date FROM (${explicitSelects.join("\nUNION\n")})
        WHERE date IS NOT NULL AND date != ''`
    )
    .all({ profileId }) as { date: string }[]) {
    add(r.date);
  }

  // Created-at-fallback tables: when the explicit calendar column is NULL the
  // event date is derived in the profile timezone (dateFromCreatedAt), which can
  // differ by a day from the raw UTC slice. Return the explicit date + the raw
  // stamp and resolve in JS EXACTLY as collectEvents does, so a highlighted day is
  // the same day the timeline filter will place the event on (#619). Rows with an
  // explicit date are unaffected.
  const resolveFallback = (
    rows: { explicit: string | null; stamp: string | null }[]
  ) => {
    for (const r of rows) add(r.explicit ?? dateFromCreatedAt(r.stamp, tz));
  };
  resolveFallback(
    db
      .prepare(
        `SELECT document_date AS explicit, uploaded_at AS stamp
           FROM medical_documents WHERE profile_id = ?`
      )
      .all(profileId) as { explicit: string | null; stamp: string | null }[]
  );
  resolveFallback(
    db
      .prepare(
        `SELECT COALESCE(resolved_date, onset_date) AS explicit, created_at AS stamp
           FROM conditions WHERE profile_id = ?`
      )
      .all(profileId) as { explicit: string | null; stamp: string | null }[]
  );
  resolveFallback(
    db
      .prepare(
        `SELECT onset_date AS explicit, created_at AS stamp
           FROM allergies WHERE profile_id = ?`
      )
      .all(profileId) as { explicit: string | null; stamp: string | null }[]
  );
  resolveFallback(
    db
      .prepare(
        `SELECT study_date AS explicit, created_at AS stamp
           FROM imaging_studies WHERE profile_id = ?`
      )
      .all(profileId) as { explicit: string | null; stamp: string | null }[]
  );
  if (includeTrainingEvents && !restricted) {
    resolveFallback(
      db
        .prepare(
          `SELECT target_date AS explicit, created_at AS stamp
             FROM goals WHERE profile_id = ?`
        )
        .all(profileId) as { explicit: string | null; stamp: string | null }[]
    );
  }

  return Array.from(dates).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}
