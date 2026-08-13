"use client";

import ProcedureForm from "./ProcedureForm";
import { updateProcedure, deleteProcedure } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import ProviderName from "@/components/ProviderName";
import NotesText from "@/components/NotesText";
import RecordEncounterLink from "@/components/RecordEncounterLink";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import type { LinkedEncounterRef } from "@/lib/queries";
import type { Procedure } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

const buildColumns = (
  fmt: DisplayFormatPrefs,
  performedAt: Record<number, LinkedEncounterRef>
): RecordColumn<Procedure>[] => [
  {
    header: "Procedure",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (p) => (
      <>
        {p.name}
        <NotesText
          notes={p.notes}
          className="ml-2 text-xs font-normal text-slate-400"
        />
        {/* "Performed at: <visit>" (#1355) — the linked encounter, absent-pillar. */}
        {performedAt[p.id] ? (
          <RecordEncounterLink
            label="Performed at"
            encounter={performedAt[p.id]}
            testid={`procedure-performed-at-${p.id}`}
          />
        ) : null}
      </>
    ),
  },
  {
    header: "Code",
    headerClassName: "hidden sm:table-cell",
    cellClassName:
      "hidden whitespace-nowrap text-slate-500 sm:table-cell dark:text-slate-400",
    empty: (p) => !p.code,
    cell: (p) =>
      p.code ? (
        <>
          {p.code}
          {p.code_system ? (
            <span className="ml-1 text-xs text-slate-400">{p.code_system}</span>
          ) : null}
        </>
      ) : (
        "—"
      ),
  },
  {
    header: "Date",
    cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
    empty: (p) => !p.date,
    cell: (p) => formatRecordDate(p.date, "—", fmt),
  },
  {
    header: "Provider",
    headerClassName: "hidden md:table-cell",
    cellClassName: "hidden whitespace-nowrap md:table-cell",
    empty: (p) => !p.provider_name,
    cell: (p) =>
      p.provider_name ? (
        <ProviderName name={p.provider_name} providerId={p.provider_id} />
      ) : (
        <span className="text-slate-400">—</span>
      ),
  },
  {
    header: "Source",
    cellClassName: "whitespace-nowrap",
    cell: (p) => (
      <RecordProvenance source={p.source} documentId={p.document_id} />
    ),
  },
];

// Manage stored procedure rows: edit in place or delete, on the shared RecordTable.
export default function ProcedureList({
  items,
  performedAt = {},
  multiView,
}: {
  items: Stamped<Procedure>[];
  performedAt?: Record<number, LinkedEncounterRef>;
  multiView?: ListMultiView;
}) {
  return (
    <RecordTable
      items={items}
      columns={buildColumns(useFormatPrefs(), performedAt)}
      emptyMessage="No procedures yet. Add one, or import a MyChart / CCD health record to populate your surgical history."
      multiView={
        multiView
          ? {
              actingProfileId: multiView.actingProfileId,
              subjectOf: (p) => p.subject,
            }
          : undefined
      }
      renderEditForm={(p, done) => (
        <ProcedureForm
          action={updateProcedure}
          procedure={p}
          profileId={multiView ? p.subject.profileId : undefined}
          onDone={done}
        />
      )}
      confirmDelete={(p) => ({
        title: "Delete procedure",
        message: `Delete “${p.name}”? This can’t be undone.`,
      })}
      onDelete={async (p) => {
        const fd = new FormData();
        fd.set("id", String(p.id));
        if (multiView) fd.set("profile_id", String(p.subject.profileId));
        await deleteProcedure(fd);
      }}
    />
  );
}
