"use client";

import { useMemo, useState, type ReactNode } from "react";
import ImagingStudyForm from "./ImagingStudyForm";
import TrackFollowUpControl from "./TrackFollowUpControl";
import { updateImagingStudy, deleteImagingStudy } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import RecordEncounterLink from "@/components/RecordEncounterLink";
import ProviderName from "@/components/ProviderName";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import {
  studyDisplayLabel,
  modalityLabel,
  impressionDisplayText,
  studyFindingText,
  IMAGING_MODALITIES,
} from "@/lib/imaging-study";
import {
  estimateStudyDose,
  doseChipLabel,
  doseSourceNote,
} from "@/lib/radiation-dose";
import type { ImagingFollowUpSummary, LinkedEncounterRef } from "@/lib/queries";
import type { ImagingStudy, ImagingModality } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";
import { dataSectionHref } from "@/lib/hrefs";

// Follow-ups are an acting-profile-derived feature (#1328 scope-limit): the followUps
// map + trackImagingFollowUp both target the acting profile, so a non-acting member's
// row shows no track control to avoid a wrong-profile follow-up write. Single view /
// acting rows keep the control. Named once so the cell and its emptiness verdict
// cannot disagree.
function tracksFollowUp(
  study: ImagingStudy,
  multiView?: ListMultiView
): boolean {
  const pid = (study as { profileId?: number }).profileId;
  return !(multiView && pid != null && pid !== multiView.actingProfileId);
}

// Columns as a factory so the Follow-up cell can read the per-study follow-up map
// (issue #700) without a module-level global.
function buildColumns(
  followUps: Map<number, ImagingFollowUpSummary>,
  encounters: Record<number, LinkedEncounterRef>,
  fmt: DisplayFormatPrefs,
  multiView?: ListMultiView
): RecordColumn<ImagingStudy>[] {
  return [
    ...baseColumns(fmt, encounters),
    {
      header: "Follow-up",
      // The non-acting placeholder is a "—" like any other (#2588): on a card it
      // claimed a "FOLLOW-UP —" line that said nothing about the study.
      empty: (s) => !tracksFollowUp(s, multiView),
      cell: (s) =>
        tracksFollowUp(s, multiView) ? (
          <TrackFollowUpControl studyId={s.id} existing={followUps.get(s.id)} />
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
  ];
}

// The row's effective-dose chip. It reads the SAME estimateStudyDose the cumulative
// card and its breakdown read (#2970), so a row and the breakdown line for the same
// study can never disagree — and an estimate is marked as one at the figure, never
// merged into an unlabelled number (#703's central rule). Before this the chip was
// recorded-only, so a record with no reported doses — the common case — showed dose
// figures on the card and none on any row.
function DoseChip({ study }: { study: ImagingStudy }) {
  const dose = estimateStudyDose(study);
  const chip = doseChipLabel(dose);
  if (!chip) return null;
  return (
    <span className="ml-2 inline-flex items-center rounded-sm bg-slate-100 pl-1.5 text-xs font-normal text-slate-600 dark:bg-slate-800 dark:text-slate-300">
      <span className="py-0.5">{chip}</span>
      <InfoTooltipIcon label={doseSourceNote(dose)} />
    </span>
  );
}

const baseColumns = (
  fmt: DisplayFormatPrefs,
  encounters: Record<number, LinkedEncounterRef>
): RecordColumn<ImagingStudy>[] => [
  {
    header: "Study",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (s) => (
      <>
        {studyDisplayLabel(s)}
        {s.contrast ? (
          <span className="ml-2 rounded-sm bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            contrast
          </span>
        ) : null}
        <DoseChip study={s} />
        {/* THE FINDING, NOT ITS HEADING, AND NOT ONE LINE OF IT (#3498 item 3).
            `line-clamp-1` cut "OVERALL IMPRESSION: Findings suggestive of a left
            breast…" exactly where the clinical payload starts — the heading spent
            the whole line and the label row above already says what this field is.
            The label strips at the display boundary (the stored value is untouched
            and the study form still edits it as imported), and a phone gets three
            lines. Desktop keeps its one-line subtitle: a table row there has a
            column grid to hold, and the full text is one tap away in the form. */}
        {impressionDisplayText(studyFindingText(s)) ? (
          <span className="ml-2 line-clamp-3 text-xs font-normal text-slate-400 sm:line-clamp-1">
            {impressionDisplayText(studyFindingText(s))}
          </span>
        ) : null}
        {encounters[s.id] ? (
          <RecordEncounterLink
            label="Performed at"
            encounter={encounters[s.id]}
            testid={`imaging-encounter-${s.id}`}
          />
        ) : null}
      </>
    ),
  },
  {
    header: "Modality",
    headerClassName: "hidden sm:table-cell",
    cellClassName:
      "hidden whitespace-nowrap text-slate-500 sm:table-cell dark:text-slate-400",
    cell: (s) => modalityLabel(s.modality),
  },
  {
    header: "Date",
    cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
    empty: (s) => !s.study_date,
    cell: (s) => formatRecordDate(s.study_date, "—", fmt),
  },
  {
    header: "Provider",
    headerClassName: "hidden md:table-cell",
    empty: (s) =>
      !s.ordering_provider_id &&
      !(
        s.reading_provider_id &&
        s.reading_provider_id !== s.ordering_provider_id
      ),
    cellClassName: "hidden md:table-cell text-xs",
    cell: (s) => {
      const parts: ReactNode[] = [];
      if (s.ordering_provider_id)
        parts.push(
          <ProviderName
            key="ord"
            name={s.ordering_provider_name ?? "Ordering"}
            providerId={s.ordering_provider_id}
            size="sm"
          />
        );
      if (
        s.reading_provider_id &&
        s.reading_provider_id !== s.ordering_provider_id
      )
        parts.push(
          <ProviderName
            key="read"
            name={s.reading_provider_name ?? "Reading"}
            providerId={s.reading_provider_id}
            size="sm"
          />
        );
      return parts.length ? (
        <span className="flex flex-col gap-0.5">{parts}</span>
      ) : (
        "—"
      );
    },
  },
  {
    header: "Source",
    cellClassName: "whitespace-nowrap",
    cell: (s) => (
      <RecordProvenance source={s.source} documentId={s.document_id} />
    ),
  },
];

// Manage stored imaging-study rows: filter by modality / region, edit in place, or
// delete, on the shared RecordTable. Filtering is client-side (family-scale data).
// `followUps` (issue #700) carries each study's tracked follow-up so the Follow-up
// column shows its state (or offers to track one).
export default function ImagingStudyList({
  items,
  followUps = [],
  encounters = {},
  multiView,
  action,
}: {
  items: Stamped<ImagingStudy>[];
  followUps?: ImagingFollowUpSummary[];
  encounters?: Record<number, LinkedEncounterRef>;
  multiView?: ListMultiView;
  // The tab's create affordance (#3486's grammar, #3498 item 4). It renders INSIDE
  // this filter toolbar rather than on a row of its own above the tab, so the tab
  // opens with the dose card and the controls that act on the list live together.
  // Passed in rather than mounted here: the form and its Server Action belong to
  // the section, and this component stays a list.
  action?: ReactNode;
}) {
  const [modality, setModality] = useState<ImagingModality | "">("");
  const [region, setRegion] = useState("");

  // First (newest — the query orders id DESC) follow-up per source study wins.
  const followUpByStudy = useMemo(() => {
    const m = new Map<number, ImagingFollowUpSummary>();
    for (const f of followUps)
      if (!m.has(f.sourceImagingStudyId)) m.set(f.sourceImagingStudyId, f);
    return m;
  }, [followUps]);
  const fmt = useFormatPrefs();
  const columns = useMemo(
    () => buildColumns(followUpByStudy, encounters, fmt, multiView),
    [followUpByStudy, encounters, fmt, multiView]
  );

  const filtered = useMemo(() => {
    const q = region.trim().toLowerCase();
    return items.filter(
      (s) =>
        (!modality || s.modality === modality) &&
        (!q || (s.body_region ?? "").toLowerCase().includes(q))
    );
  }, [items, modality, region]);

  return (
    <div data-testid="imaging-study-list" className="space-y-3">
      <div
        data-testid="imaging-filter-toolbar"
        className="flex flex-wrap items-center gap-2"
      >
        <select
          aria-label="Filter by modality"
          className="input w-auto"
          value={modality}
          onChange={(e) => setModality(e.target.value as ImagingModality | "")}
        >
          <option value="">All modalities</option>
          {IMAGING_MODALITIES.map((m) => (
            <option key={m} value={m}>
              {modalityLabel(m)}
            </option>
          ))}
        </select>
        <input
          aria-label="Filter by body region"
          className="input w-auto flex-1"
          placeholder="Filter by region…"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
        />
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <RecordTable
        items={filtered}
        columns={columns}
        itemName={(s) => studyDisplayLabel(s)}
        emptyMessage={
          items.length
            ? "No imaging studies match these filters."
            : "No imaging studies yet. Add one manually or import a radiology report."
        }
        emptyActions={
          items.length
            ? undefined
            : [
                {
                  href: dataSectionHref("import"),
                  label: "Import records",
                },
              ]
        }
        multiView={
          multiView
            ? {
                actingProfileId: multiView.actingProfileId,
                subjectOf: (s) => s.subject,
              }
            : undefined
        }
        renderEditForm={(s, done) => (
          <ImagingStudyForm
            action={updateImagingStudy}
            study={s}
            profileId={multiView ? s.subject.profileId : undefined}
            onDone={done}
          />
        )}
        confirmDelete={(s) => ({
          title: "Delete imaging study",
          message: `Delete “${studyDisplayLabel(s)}”? This can’t be undone.`,
        })}
        onDelete={async (s) => {
          const fd = new FormData();
          fd.set("id", String(s.id));
          if (multiView) fd.set("profile_id", String(s.subject.profileId));
          await deleteImagingStudy(fd);
        }}
      />
    </div>
  );
}
