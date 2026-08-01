"use client";

import ConditionForm from "./ConditionForm";
import { updateCondition, deleteCondition } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import SourceDocumentLink from "@/components/SourceDocumentLink";
import StatusBadge from "@/components/StatusBadge";
import NotesText from "@/components/NotesText";
import RecordEncounterLink from "@/components/RecordEncounterLink";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import type { LinkedEncounterRef } from "@/lib/queries";
import type { Condition } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

function buildColumns(
  fmt: DisplayFormatPrefs,
  treatedWith: Record<number, string[]>,
  diagnosedAt: Record<number, LinkedEncounterRef>
): RecordColumn<Condition>[] {
  return [
    {
      header: "Condition",
      cellClassName: "font-medium text-slate-800 dark:text-slate-100",
      cell: (c) => (
        <>
          <SourceDocumentLink documentId={c.document_id} source={c.source}>
            {c.name}
          </SourceDocumentLink>
          <NotesText
            notes={c.notes}
            className="ml-2 text-xs font-normal text-slate-400"
          />
          {/* "Diagnosed at: <visit>" (#1355) — the linked encounter, absent-pillar. */}
          {diagnosedAt[c.id] ? (
            <RecordEncounterLink
              label="Diagnosed at"
              encounter={diagnosedAt[c.id]}
              testid={`condition-diagnosed-at-${c.id}`}
            />
          ) : null}
          {/* Med → indication inverse view (#1052): the medications recorded as
              treating this condition. A formatter over the ONE link, no inference. */}
          {treatedWith[c.id]?.length ? (
            <div
              className="mt-0.5 text-xs font-normal text-slate-500 dark:text-slate-400"
              data-testid="condition-treated-with"
            >
              Treated with: {treatedWith[c.id].join(", ")}
            </div>
          ) : null}
        </>
      ),
    },
    {
      header: "Code",
      headerClassName: "hidden sm:table-cell",
      cellClassName:
        "hidden whitespace-nowrap text-slate-500 sm:table-cell dark:text-slate-400",
      cell: (c) =>
        c.code ? (
          <>
            {c.code}
            {c.code_system ? (
              <span className="ml-1 text-xs text-slate-400">
                {c.code_system}
              </span>
            ) : null}
          </>
        ) : (
          "—"
        ),
    },
    {
      header: "Status",
      cell: (c) => <StatusBadge status={c.status} />,
    },
    {
      header: "Onset",
      headerClassName: "hidden md:table-cell",
      cellClassName:
        "hidden whitespace-nowrap text-slate-600 md:table-cell dark:text-slate-300",
      cell: (c) => formatRecordDate(c.onset_date, "—", fmt),
    },
    {
      header: "Source",
      headerClassName: "hidden sm:table-cell",
      cellClassName: "hidden whitespace-nowrap sm:table-cell",
      cell: (c) => (
        <RecordProvenance source={c.source} documentId={c.document_id} />
      ),
    },
  ];
}

// Manage stored condition rows: edit in place or delete, on the shared RecordTable.
// `treatedWith` maps a condition id → the medications treating it (#1052), rendered as
// a "Treated with:" sub-line; empty/absent for conditions with no linked med.
export default function ConditionList({
  items,
  treatedWith = {},
  diagnosedAt = {},
  multiView,
}: {
  items: Stamped<Condition>[];
  treatedWith?: Record<number, string[]>;
  diagnosedAt?: Record<number, LinkedEncounterRef>;
  multiView?: ListMultiView;
}) {
  const columns = buildColumns(useFormatPrefs(), treatedWith, diagnosedAt);
  return (
    <RecordTable
      items={items}
      columns={columns}
      emptyMessage="No conditions match this filter."
      multiView={
        multiView
          ? {
              actingProfileId: multiView.actingProfileId,
              subjectOf: (c) => c.subject,
            }
          : undefined
      }
      renderEditForm={(c, done) => (
        <ConditionForm
          action={updateCondition}
          condition={c}
          profileId={multiView ? c.subject.profileId : undefined}
          onDone={done}
        />
      )}
      confirmDelete={(c) => ({
        title: "Delete condition",
        message: `Delete “${c.name}”? This can’t be undone.`,
      })}
      onDelete={async (c) => {
        const fd = new FormData();
        fd.set("id", String(c.id));
        if (multiView) fd.set("profile_id", String(c.subject.profileId));
        await deleteCondition(fd);
      }}
    />
  );
}
