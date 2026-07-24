"use client";

import Link from "next/link";
import AllergyForm from "./AllergyForm";
import { updateAllergy, deleteAllergy } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import StatusBadge from "@/components/StatusBadge";
import NotesText from "@/components/NotesText";
import { medicationHref } from "@/lib/hrefs";
import { drugAllergyMatchLabel, type DrugAllergyHit } from "@/lib/drug-allergy";
import type { Allergy } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

function buildColumns(
  contraindications: Record<number, DrugAllergyHit[]>
): RecordColumn<Allergy>[] {
  return [
    {
      header: "Substance",
      cellClassName: "font-medium text-slate-800 dark:text-slate-100",
      cell: (a) => (
        <>
          {a.substance}
          <NotesText
            notes={a.notes}
            className="ml-2 text-xs font-normal text-slate-400"
          />
          {/* Bidirectional safety cross-link (#1354): the active medications this
              allergy contraindicates — the SAME drug-allergy findings the /medications
              safety strip shows, through the SAME dismissal bus. Each med deep-links to
              its detail page. Absent-pillar: a row with no hits renders nothing. */}
          {contraindications[a.id]?.length ? (
            <div
              className="mt-0.5 text-xs font-normal text-rose-700 dark:text-rose-300"
              data-testid="allergy-contraindications"
            >
              Contraindicated with your active meds:{" "}
              {contraindications[a.id].map((hit, i) => (
                <span key={hit.dedupeKey}>
                  {i > 0 ? ", " : ""}
                  <Link
                    href={medicationHref(hit.medId)}
                    className="font-medium underline decoration-rose-400/60 underline-offset-2 hover:decoration-rose-500"
                    title={drugAllergyMatchLabel(hit)}
                    data-testid={`allergy-contra-${hit.dedupeKey}`}
                  >
                    {hit.medName}
                  </Link>
                </span>
              ))}
            </div>
          ) : null}
        </>
      ),
    },
    {
      header: "Reaction",
      cellClassName: "text-slate-600 dark:text-slate-300",
      cell: (a) => a.reaction ?? "—",
    },
    {
      header: "Severity",
      cellClassName: "text-slate-600 dark:text-slate-300",
      cell: (a) => a.severity ?? "—",
    },
    {
      header: "Status",
      cell: (a) => <StatusBadge status={a.status} />,
    },
    {
      header: "Source",
      headerClassName: "hidden sm:table-cell",
      cellClassName: "hidden whitespace-nowrap sm:table-cell",
      cell: (a) => (
        <RecordProvenance source={a.source} documentId={a.document_id} />
      ),
    },
  ];
}

// Manage stored allergy rows: edit in place or delete, on the shared RecordTable.
// (The merged known-allergies view — documented + lab-derived — is rendered
// read-only above by the page.) `contraindications` maps an allergy id → the active
// medications it contraindicates (#1354), rendered as a rose sub-line; empty/absent for
// allergies with no active contraindicated med.
export default function AllergyList({
  items,
  contraindications = {},
  multiView,
}: {
  items: Stamped<Allergy>[];
  contraindications?: Record<number, DrugAllergyHit[]>;
  multiView?: ListMultiView;
}) {
  return (
    <RecordTable
      items={items}
      columns={buildColumns(contraindications)}
      emptyMessage="No allergies recorded. Add one, or import a MyChart export."
      multiView={
        multiView
          ? {
              actingProfileId: multiView.actingProfileId,
              subjectOf: (a) => a.subject,
            }
          : undefined
      }
      renderEditForm={(a, done) => (
        <AllergyForm
          action={updateAllergy}
          allergy={a}
          profileId={multiView ? a.subject.profileId : undefined}
          onDone={done}
        />
      )}
      confirmDelete={(a) => ({
        title: "Delete allergy",
        message: `Delete the ${a.substance} allergy? This can’t be undone.`,
      })}
      onDelete={async (a) => {
        const fd = new FormData();
        fd.set("id", String(a.id));
        if (multiView) fd.set("profile_id", String(a.subject.profileId));
        await deleteAllergy(fd);
      }}
    />
  );
}
