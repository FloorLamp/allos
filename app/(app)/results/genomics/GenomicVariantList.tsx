"use client";

import Link from "next/link";
import GenomicVariantForm from "./GenomicVariantForm";
import { updateGenomicVariant, deleteGenomicVariant } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { medicationHref } from "@/lib/hrefs";
import { pgxStatusLabel, type PgxHit } from "@/lib/pgx";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import {
  variantDisplayLabel,
  resultTypeLabel,
  significanceLabel,
} from "@/lib/genomic-variant";
import type { GenomicVariant } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";
import { dataSectionHref } from "@/lib/hrefs";

const buildColumns = (
  fmt: DisplayFormatPrefs,
  affectedMeds: Record<number, PgxHit[]>
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
        {/* Bidirectional safety cross-link (#1354): the active medications this PGx
            variant affects — the SAME pharmacogenomic findings the /medications safety
            strip shows, through the SAME dismissal bus. Stated factually (med + cited
            phenotype consequence), no risk prose. Each med deep-links to its detail.
            Absent-pillar: a variant with no hits renders nothing. */}
        {affectedMeds[v.id]?.length ? (
          <div
            className="mt-0.5 text-xs font-normal text-violet-700 dark:text-violet-300"
            data-testid="pgx-affected-meds"
          >
            Affects:{" "}
            {affectedMeds[v.id].map((hit, i) => (
              <span key={hit.dedupeKey}>
                {i > 0 ? ", " : ""}
                <Link
                  href={medicationHref(hit.medId)}
                  className="font-medium underline decoration-violet-400/60 underline-offset-2 hover:decoration-violet-500"
                  data-testid={`pgx-affects-${hit.dedupeKey}`}
                >
                  {hit.medName}
                </Link>{" "}
                <span className="text-slate-500 dark:text-slate-400">
                  ({hit.gene} {pgxStatusLabel(hit)})
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </>
    ),
  },
  {
    header: "Significance",
    cellClassName: "whitespace-nowrap text-slate-500 dark:text-slate-400",
    cell: (v) =>
      v.significance ? significanceLabel(v.significance) : <span>—</span>,
  },
  {
    header: "Type",
    cellClassName: "whitespace-nowrap text-slate-500 dark:text-slate-400",
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
    cell: (v) => (
      <RecordProvenance source={v.source} documentId={v.document_id} />
    ),
  },
];

// Manage stored genomic-variant rows: edit in place or delete, on the shared
// RecordTable. Predictive variants are shown factually — no risk text here.
export default function GenomicVariantList({
  items,
  affectedMeds = {},
  multiView,
}: {
  items: Stamped<GenomicVariant>[];
  affectedMeds?: Record<number, PgxHit[]>;
  multiView?: ListMultiView;
}) {
  return (
    <div data-testid="genomic-variant-list">
      <RecordTable
        items={items}
        columns={buildColumns(useFormatPrefs(), affectedMeds)}
        emptyMessage="No genomic variants yet. Add one manually or import a clinical genetics or PGx report."
        emptyActions={[
          { href: dataSectionHref("import"), label: "Import records" },
        ]}
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
