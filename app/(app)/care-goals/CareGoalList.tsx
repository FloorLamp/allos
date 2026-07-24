"use client";

import CareGoalForm from "./CareGoalForm";
import { updateCareGoal, deleteCareGoal } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import StatusBadge from "@/components/StatusBadge";
import NotesText from "@/components/NotesText";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import type { CareGoal } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

const buildColumns = (fmt: DisplayFormatPrefs): RecordColumn<CareGoal>[] => [
  {
    header: "Goal",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (g) => (
      <>
        {g.description}
        <NotesText
          notes={g.notes}
          className="ml-2 text-xs font-normal text-slate-400"
        />
      </>
    ),
  },
  {
    header: "Target date",
    cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
    cell: (g) => formatRecordDate(g.target_date, "—", fmt),
  },
  {
    header: "Status",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden whitespace-nowrap sm:table-cell",
    cell: (g) => <StatusBadge status={g.status} />,
  },
  {
    header: "Source",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden whitespace-nowrap sm:table-cell",
    cell: (g) => (
      <RecordProvenance source={g.source} documentId={g.document_id} />
    ),
  },
];

// Manage stored care-goal rows: edit in place or delete, on the shared RecordTable.
export default function CareGoalList({
  items,
  multiView,
}: {
  items: Stamped<CareGoal>[];
  multiView?: ListMultiView;
}) {
  return (
    <RecordTable
      items={items}
      columns={buildColumns(useFormatPrefs())}
      emptyMessage="No health goals yet. Add one, or import a MyChart / CCD health record to populate goals set in your records."
      multiView={
        multiView
          ? {
              actingProfileId: multiView.actingProfileId,
              subjectOf: (g) => g.subject,
            }
          : undefined
      }
      renderEditForm={(g, done) => (
        <CareGoalForm
          action={updateCareGoal}
          goal={g}
          profileId={multiView ? g.subject.profileId : undefined}
          onDone={done}
        />
      )}
      confirmDelete={(g) => ({
        title: "Delete health goal",
        message: `Delete “${g.description}”? This can’t be undone.`,
      })}
      onDelete={async (g) => {
        const fd = new FormData();
        fd.set("id", String(g.id));
        if (multiView) fd.set("profile_id", String(g.subject.profileId));
        await deleteCareGoal(fd);
      }}
    />
  );
}
