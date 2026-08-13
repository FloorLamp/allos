"use client";

import FamilyHistoryForm from "./FamilyHistoryForm";
import {
  updateFamilyHistory,
  deleteFamilyHistory,
} from "./family-history-actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import NotesText from "@/components/NotesText";
import { familyDeathLabel, familyRelativeLabel } from "@/lib/family-relation";
import type { FamilyHistory } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

const COLUMNS: RecordColumn<FamilyHistory>[] = [
  {
    header: "Relative",
    cellClassName:
      "whitespace-nowrap font-medium text-slate-800 dark:text-slate-100",
    // Discriminator-aware label (#1407/#531): "Father" and "Father (adopted)" are
    // different clinical claims — one weighs as hereditary risk, the other does not
    // — so they must not render identically. Shared pure builder.
    cell: (f) =>
      f.relation || f.relation_type || f.lineage ? familyRelativeLabel(f) : "—",
  },
  {
    header: "Condition",
    cellClassName: "text-slate-700 dark:text-slate-200",
    cell: (f) => (
      <>
        {f.condition}
        {f.code ? (
          <span className="ml-1.5 text-xs text-slate-400">{f.code}</span>
        ) : null}
        {/* "Died at 52 — Myocardial infarction" (#1407), replacing the bare
            Deceased badge: the age and the cause are the screening-cadence inputs,
            so the surface that records them shows them. */}
        {familyDeathLabel(f) ? (
          <span
            className="ml-2 badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
            data-testid={`family-death-${f.id}`}
          >
            {familyDeathLabel(f)}
          </span>
        ) : null}
        <NotesText
          notes={f.notes}
          className="ml-2 text-xs font-normal text-slate-400"
        />
      </>
    ),
  },
  {
    header: "Onset age",
    headerClassName: "hidden sm:table-cell",
    cellClassName:
      "hidden whitespace-nowrap text-slate-600 sm:table-cell dark:text-slate-300",
    empty: (f) => f.onset_age == null,
    cell: (f) => (f.onset_age != null ? `${f.onset_age} yrs` : "—"),
  },
  {
    header: "Source",
    cellClassName: "whitespace-nowrap",
    cell: (f) => (
      <RecordProvenance source={f.source} documentId={f.document_id} />
    ),
  },
];

// Manage stored family-history rows (one condition per relative): edit in place or
// delete, on the shared RecordTable. Rows arrive grouped by relative (query order).
export default function FamilyHistoryList({
  items,
  multiView,
}: {
  items: Stamped<FamilyHistory>[];
  multiView?: ListMultiView;
}) {
  return (
    <RecordTable
      items={items}
      columns={COLUMNS}
      emptyMessage="No family history yet. Add an entry, or import a MyChart / CCD health record to populate it."
      multiView={
        multiView
          ? {
              actingProfileId: multiView.actingProfileId,
              subjectOf: (f) => f.subject,
            }
          : undefined
      }
      renderEditForm={(f, done) => (
        <FamilyHistoryForm
          action={updateFamilyHistory}
          entry={f}
          profileId={multiView ? f.subject.profileId : undefined}
          onDone={done}
        />
      )}
      confirmDelete={(f) => ({
        title: "Delete family-history entry",
        message: `Delete “${f.condition}”${
          f.relation ? ` (${familyRelativeLabel(f)})` : ""
        }? This can’t be undone.`,
      })}
      onDelete={async (f) => {
        const fd = new FormData();
        fd.set("id", String(f.id));
        if (multiView) fd.set("profile_id", String(f.subject.profileId));
        await deleteFamilyHistory(fd);
      }}
    />
  );
}
