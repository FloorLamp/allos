"use client";

import Link from "next/link";
import AllergyForm from "./AllergyForm";
import { updateAllergy, deleteAllergy } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import RecordProvenance from "@/components/RecordProvenance";
import StatusBadge from "@/components/StatusBadge";
import NotesText from "@/components/NotesText";
import RecordEncounterLink from "@/components/RecordEncounterLink";
import { medicationHref } from "@/lib/hrefs";
import { drugAllergyMatchLabel, type DrugAllergyHit } from "@/lib/drug-allergy";
import {
  allergyCriticalityLabel,
  allergyReactionSummary,
  allergyVerificationLabel,
  composeAllergyReactions,
  isAllergyActionable,
  isHighCriticality,
} from "@/lib/allergy-reactions";
import type { LinkedEncounterRef } from "@/lib/queries";
import type { Allergy } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

// Every graded manifestation, through the ONE pure summary the passport and the FHIR
// export also use. Named once so the cell and its #2588 emptiness verdict cannot
// disagree about whether this row has reactions to show.
function reactionSummary(a: Allergy): string {
  return allergyReactionSummary(
    composeAllergyReactions(
      a,
      (a.reactions ?? []).map((r, i) => ({ ...r, position: i }))
    )
  );
}

function buildColumns(
  contraindications: Record<number, DrugAllergyHit[]>,
  recordedAt: Record<number, LinkedEncounterRef>
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
          {/* "Recorded at: <visit>" (#1526) — the visit that documented this allergy,
              deep-linked. An allergy gates drug warnings and prints on the emergency
              card, so its attribution belongs beside it. Absent pillar: a row with no
              linked visit renders nothing. */}
          {recordedAt[a.id] ? (
            <RecordEncounterLink
              label="Recorded at"
              encounter={recordedAt[a.id]}
              testid={`allergy-visit-${a.id}`}
            />
          ) : null}
        </>
      ),
    },
    {
      // Every graded manifestation (#1405), not just the cached first one, through
      // the ONE pure summary the passport and the FHIR export also use.
      header: "Reactions",
      cellClassName: "text-slate-600 dark:text-slate-300",
      empty: (a) => !reactionSummary(a),
      cell: (a) => reactionSummary(a) || "—",
    },
    {
      // Criticality (life-threatening potential on a FUTURE exposure) and
      // verification status (#1405). A refuted row is called out explicitly,
      // because it looks like every other allergy but no longer gates anything.
      header: "Criticality / verification",
      cellClassName: "text-slate-600 dark:text-slate-300",
      empty: (a) =>
        allergyCriticalityLabel(a.criticality) == null &&
        !a.verification_status,
      cell: (a) => (
        <span data-testid={`allergy-safety-${a.id}`}>
          {isHighCriticality(a) ? (
            <span className="rounded-sm bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700 dark:bg-rose-950 dark:text-rose-300">
              {allergyCriticalityLabel(a.criticality)}
            </span>
          ) : (
            (allergyCriticalityLabel(a.criticality) ?? "—")
          )}
          {a.verification_status ? (
            <span className="ml-2 text-xs">
              {allergyVerificationLabel(a.verification_status)}
              {!isAllergyActionable(a) ? " · not screening" : ""}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      header: "Status",
      cell: (a) =>
        !isAllergyActionable(a) && a.verification_status ? (
          <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {allergyVerificationLabel(a.verification_status)}
          </span>
        ) : (
          <StatusBadge status={a.status} />
        ),
    },
    {
      header: "Source",
      cellClassName: "whitespace-nowrap",
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
  recordedAt = {},
  multiView,
}: {
  items: Stamped<Allergy>[];
  contraindications?: Record<number, DrugAllergyHit[]>;
  // Allergy id → the visit it was recorded at (#1526), gathered once by the section.
  recordedAt?: Record<number, LinkedEncounterRef>;
  multiView?: ListMultiView;
}) {
  // Undoable since #1847: the shared toast, because an allergy gates the drug-safety
  // matcher and the emergency card — a mis-tap here used to be unrecoverable.
  const undoable = useUndoableDelete();
  return (
    <RecordTable
      items={items}
      columns={buildColumns(contraindications, recordedAt)}
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
        message: `Delete the ${a.substance} allergy? It stops warning about medications until you undo.`,
      })}
      onDelete={async (a) => {
        const fd = new FormData();
        fd.set("id", String(a.id));
        if (multiView) fd.set("profile_id", String(a.subject.profileId));
        await undoable(deleteAllergy, fd, {
          deletedMessage: "Allergy deleted.",
        });
      }}
    />
  );
}
