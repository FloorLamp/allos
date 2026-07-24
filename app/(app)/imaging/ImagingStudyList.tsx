"use client";

import { useMemo, useState, type ReactNode } from "react";
import ImagingStudyForm from "./ImagingStudyForm";
import TrackFollowUpControl from "./TrackFollowUpControl";
import { updateImagingStudy, deleteImagingStudy } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import ProviderName from "@/components/ProviderName";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import {
  studyDisplayLabel,
  modalityLabel,
  IMAGING_MODALITIES,
} from "@/lib/imaging-study";
import { formatMsv } from "@/lib/radiation-dose";
import type { ImagingFollowUpSummary } from "@/lib/queries";
import type { ImagingStudy, ImagingModality } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

// Columns as a factory so the Follow-up cell can read the per-study follow-up map
// (issue #700) without a module-level global.
function buildColumns(
  followUps: Map<number, ImagingFollowUpSummary>,
  fmt: DisplayFormatPrefs,
  multiView?: ListMultiView
): RecordColumn<ImagingStudy>[] {
  return [
    ...baseColumns(fmt),
    {
      header: "Follow-up",
      headerClassName: "hidden md:table-cell",
      cellClassName: "hidden md:table-cell",
      cell: (s) => {
        // Follow-ups are an acting-profile-derived feature (#1328 scope-limit): the
        // followUps map + trackImagingFollowUp both target the acting profile, so a
        // non-acting member's row shows no track control (a "—") to avoid a wrong-
        // profile follow-up write. Single view / acting rows keep the control.
        const pid = (s as { profileId?: number }).profileId;
        if (multiView && pid != null && pid !== multiView.actingProfileId) {
          return <span className="text-slate-400">—</span>;
        }
        return (
          <TrackFollowUpControl studyId={s.id} existing={followUps.get(s.id)} />
        );
      },
    },
  ];
}

const baseColumns = (fmt: DisplayFormatPrefs): RecordColumn<ImagingStudy>[] => [
  {
    header: "Study",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (s) => (
      <>
        {studyDisplayLabel(s)}
        {s.contrast ? (
          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            contrast
          </span>
        ) : null}
        {s.dose_msv != null ? (
          <span
            className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-normal text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            title="Effective dose recorded from the report"
          >
            {formatMsv(s.dose_msv)}
          </span>
        ) : null}
        {s.impression ? (
          <span className="ml-2 line-clamp-1 text-xs font-normal text-slate-400">
            {s.impression}
          </span>
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
    cell: (s) => formatRecordDate(s.study_date, "—", fmt),
  },
  {
    header: "Provider",
    headerClassName: "hidden md:table-cell",
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
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden whitespace-nowrap sm:table-cell",
    cell: (s) => <RecordProvenance source={s.source} />,
  },
];

// Manage stored imaging-study rows: filter by modality / region, edit in place, or
// delete, on the shared RecordTable. Filtering is client-side (family-scale data).
// `followUps` (issue #700) carries each study's tracked follow-up so the Follow-up
// column shows its state (or offers to track one).
export default function ImagingStudyList({
  items,
  followUps = [],
  multiView,
}: {
  items: Stamped<ImagingStudy>[];
  followUps?: ImagingFollowUpSummary[];
  multiView?: ListMultiView;
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
    () => buildColumns(followUpByStudy, fmt, multiView),
    [followUpByStudy, fmt, multiView]
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
      <div className="flex flex-wrap gap-2">
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
      </div>
      <RecordTable
        items={filtered}
        columns={columns}
        emptyMessage="No imaging studies yet. Add one, or upload a radiology report to import it."
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
