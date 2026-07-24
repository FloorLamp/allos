"use client";

import GenomicVariantForm from "./GenomicVariantForm";
import { updateGenomicVariant, deleteGenomicVariant } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import {
  variantDisplayLabel,
  resultTypeLabel,
  significanceLabel,
} from "@/lib/genomic-variant";
import type { GenomicVariant } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

const buildColumns = (
  fmt: DisplayFormatPrefs
): RecordColumn<GenomicVariant>[] => [
  {
    header: "Variant",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (v) => (
      <>
        {variantDisplayLabel(v)}
        {v.interpretation ? (
          <span className="ml-2 text-xs font-normal text-slate-400">
            {v.interpretation}
          </span>
        ) : null}
      </>
    ),
  },
  {
    header: "Significance",
    headerClassName: "hidden sm:table-cell",
    cellClassName:
      "hidden whitespace-nowrap text-slate-500 sm:table-cell dark:text-slate-400",
    cell: (v) =>
      v.significance ? significanceLabel(v.significance) : <span>—</span>,
  },
  {
    header: "Type",
    headerClassName: "hidden md:table-cell",
    cellClassName:
      "hidden whitespace-nowrap text-slate-500 md:table-cell dark:text-slate-400",
    cell: (v) => resultTypeLabel(v.result_type),
  },
  {
    header: "Reported",
    cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
    cell: (v) => formatRecordDate(v.report_date, "—", fmt),
  },
  {
    header: "Source",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden whitespace-nowrap sm:table-cell",
    cell: (v) => <RecordProvenance source={v.source} />,
  },
];

// Manage stored genomic-variant rows: edit in place or delete, on the shared
// RecordTable. Predictive variants are shown factually — no risk text here.
export default function GenomicVariantList({
  items,
  multiView,
}: {
  items: Stamped<GenomicVariant>[];
  multiView?: ListMultiView;
}) {
  return (
    <div data-testid="genomic-variant-list">
      <RecordTable
        items={items}
        columns={buildColumns(useFormatPrefs())}
        emptyMessage="No genomic variants yet. Add one, or upload a clinical genetics / PGx report to import your results."
        multiView={
          multiView
            ? {
                actingProfileId: multiView.actingProfileId,
                subjectOf: (v) => v.subject,
              }
            : undefined
        }
        renderEditForm={(v, done) => (
          <GenomicVariantForm
            action={updateGenomicVariant}
            variant={v}
            profileId={multiView ? v.subject.profileId : undefined}
            onDone={done}
          />
        )}
        confirmDelete={(v) => ({
          title: "Delete genomic variant",
          message: `Delete “${variantDisplayLabel(v)}”? This can’t be undone.`,
        })}
        onDelete={async (v) => {
          const fd = new FormData();
          fd.set("id", String(v.id));
          if (multiView) fd.set("profile_id", String(v.subject.profileId));
          await deleteGenomicVariant(fd);
        }}
      />
    </div>
  );
}
