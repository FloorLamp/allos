"use client";

import { useMemo, useState } from "react";
import ImagingStudyForm from "./ImagingStudyForm";
import { updateImagingStudy, deleteImagingStudy } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import { formatRecordDate } from "@/lib/record-format";
import {
  studyDisplayLabel,
  modalityLabel,
  IMAGING_MODALITIES,
} from "@/lib/imaging-study";
import type { ImagingStudy, ImagingModality } from "@/lib/types";

const COLUMNS: RecordColumn<ImagingStudy>[] = [
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
    cell: (s) => formatRecordDate(s.study_date),
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
export default function ImagingStudyList({ items }: { items: ImagingStudy[] }) {
  const [modality, setModality] = useState<ImagingModality | "">("");
  const [region, setRegion] = useState("");

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
        columns={COLUMNS}
        emptyMessage="No imaging studies yet. Add one, or upload a radiology report to import it."
        renderEditForm={(s, done) => (
          <ImagingStudyForm
            action={updateImagingStudy}
            study={s}
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
          await deleteImagingStudy(fd);
        }}
      />
    </div>
  );
}
