"use client";

import { useMemo, useState } from "react";
import DentalProcedureForm from "./DentalProcedureForm";
import TrackDentalFollowUpControl from "./TrackDentalFollowUpControl";
import { updateDentalProcedure, deleteDentalProcedure } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import ProviderName from "@/components/ProviderName";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import {
  dentalDisplayLabel,
  dentalStatusLabel,
  toothLabel,
  DENTAL_STATUSES,
} from "@/lib/dental";
import type { DentalFollowUpSummary } from "@/lib/queries";
import type { DentalProcedure, DentalStatus } from "@/lib/types";

// Columns as a factory so the Recheck cell can read the per-record follow-up map
// (issue #700) without a module-level global.
function buildColumns(
  followUps: Map<number, DentalFollowUpSummary>,
  fmt: DisplayFormatPrefs
): RecordColumn<DentalProcedure>[] {
  return [
    ...baseColumns(fmt),
    {
      header: "Recheck",
      headerClassName: "hidden md:table-cell",
      cellClassName: "hidden md:table-cell",
      cell: (d) => (
        <TrackDentalFollowUpControl
          recordId={d.id}
          offer={d.status !== "completed"}
          existing={followUps.get(d.id)}
        />
      ),
    },
  ];
}

const baseColumns = (
  fmt: DisplayFormatPrefs
): RecordColumn<DentalProcedure>[] => [
  {
    header: "Record",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (d) => (
      <>
        {dentalDisplayLabel(d)}
        {d.status !== "completed" ? (
          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            {dentalStatusLabel(d.status).toLowerCase()}
          </span>
        ) : null}
        {d.finding ? (
          <span className="ml-2 line-clamp-1 text-xs font-normal text-slate-400">
            {d.finding}
          </span>
        ) : null}
      </>
    ),
  },
  {
    header: "Tooth",
    headerClassName: "hidden sm:table-cell",
    cellClassName:
      "hidden whitespace-nowrap text-slate-500 sm:table-cell dark:text-slate-400",
    cell: (d) => toothLabel(d) || "—",
  },
  {
    header: "Date",
    cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
    cell: (d) => formatRecordDate(d.procedure_date, "—", fmt),
  },
  {
    header: "Provider",
    headerClassName: "hidden md:table-cell",
    cellClassName: "hidden md:table-cell",
    cell: (d) =>
      d.provider_id ? (
        <ProviderName
          name={d.provider_name ?? "Provider"}
          providerId={d.provider_id}
          size="sm"
        />
      ) : (
        "—"
      ),
  },
  {
    header: "Source",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden whitespace-nowrap sm:table-cell",
    cell: (d) => (
      <RecordProvenance source={d.source} documentId={d.document_id} />
    ),
  },
];

// Manage stored dental records: filter by status / tooth, edit in place, or delete,
// on the shared RecordTable. Filtering is client-side (family-scale data).
// `followUps` (issue #700) carries each record's tracked recheck so the Recheck
// column shows its state (or offers to track one for a watch/planned record).
export default function DentalProcedureList({
  items,
  followUps = [],
}: {
  items: DentalProcedure[];
  followUps?: DentalFollowUpSummary[];
}) {
  const [status, setStatus] = useState<DentalStatus | "">("");
  const [tooth, setTooth] = useState("");

  // First (newest — the query orders id DESC) follow-up per source record wins.
  const followUpByRecord = useMemo(() => {
    const m = new Map<number, DentalFollowUpSummary>();
    for (const f of followUps)
      if (!m.has(f.sourceDentalProcedureId))
        m.set(f.sourceDentalProcedureId, f);
    return m;
  }, [followUps]);
  const fmt = useFormatPrefs();
  const columns = useMemo(
    () => buildColumns(followUpByRecord, fmt),
    [followUpByRecord, fmt]
  );

  const filtered = useMemo(() => {
    const q = tooth.trim().toLowerCase().replace(/^#/, "");
    return items.filter(
      (d) =>
        (!status || d.status === status) &&
        (!q || (d.tooth ?? "").toLowerCase().replace(/^#/, "").includes(q))
    );
  }, [items, status, tooth]);

  return (
    <div data-testid="dental-procedure-list" className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Filter by status"
          className="input w-auto"
          value={status}
          onChange={(e) => setStatus(e.target.value as DentalStatus | "")}
        >
          <option value="">All statuses</option>
          {DENTAL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {dentalStatusLabel(s)}
            </option>
          ))}
        </select>
        <input
          aria-label="Filter by tooth"
          className="input w-auto flex-1"
          placeholder="Filter by tooth…"
          value={tooth}
          onChange={(e) => setTooth(e.target.value)}
        />
      </div>
      <RecordTable
        items={filtered}
        columns={columns}
        emptyMessage="No dental records yet. Add one, or upload a dental exam/treatment record to import it."
        renderEditForm={(d, done) => (
          <DentalProcedureForm
            action={updateDentalProcedure}
            record={d}
            onDone={done}
          />
        )}
        confirmDelete={(d) => ({
          title: "Delete dental record",
          message: `Delete “${dentalDisplayLabel(d)}”? This can’t be undone.`,
        })}
        onDelete={async (d) => {
          const fd = new FormData();
          fd.set("id", String(d.id));
          await deleteDentalProcedure(fd);
        }}
      />
    </div>
  );
}
