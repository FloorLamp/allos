"use client";

import ImmunizationForm from "./ImmunizationForm";
import { updateImmunization, deleteImmunization } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import NotesText from "@/components/NotesText";
import { vaccineDisplayName } from "@/lib/immunization-catalog";
import {
  resolveDoseLabels,
  seriesLengthForCode,
} from "@/lib/immunization-status";
import { immunizationAdministrationLine } from "@/lib/record-format";
import type { Immunization } from "@/lib/types";

// Editable dose list for the per-vaccine detail page. Lists every stored dose
// that credits this vaccine (its own code plus any combination shot whose
// components include it) with an auto "Dose N [of M]" label, the read-only "via"
// combo provenance, and inline edit / delete — reusing the shared
// ImmunizationForm and the update/delete server actions (same pattern as the
// master "All recorded doses" table). Editing/deleting a combo dose here affects
// the one physical dose, and therefore every component series it credits.
//
// #1491 item 5: this used to be a hand-cloned copy of RecordTable's shell that
// had drifted (inline pencil/trash instead of the shared overflow menu, no
// empty state). It now IS a RecordTable, so the shell, menu, confirm dialog and
// EmptyState come from the one shared surface.
export default function VaccineDoseHistory({
  code,
  doses,
  defaultDate,
}: {
  // The catalog code of the vaccine being viewed, used for the "of M" series
  // length and to decide which rows are combos ("via").
  code: string;
  // Full stored immunization rows crediting this vaccine (so edit has every field).
  doses: Immunization[];
  defaultDate: string;
}) {
  // Numbered within this vaccine's series (direct + combo doses together, by
  // date); a user's explicit dose_label wins. Pure helper shared with the history.
  const labels = resolveDoseLabels(doses, seriesLengthForCode(code));

  // Display order: chronological ascending (dose 1 first), matching the numbering.
  const ordered = [...doses].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id - b.id
  );

  const columns: RecordColumn<Immunization>[] = [
    {
      header: "Date",
      cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
      cell: (im) => im.date,
    },
    {
      header: "Dose",
      cellClassName: "text-slate-600 dark:text-slate-300",
      cell: (im) => (
        <>
          {labels.get(im.id) ?? "—"}
          <NotesText notes={im.notes} className="ml-2 text-xs text-slate-400" />
          {/* Lot / route / site + any adverse reaction (#1406), through the
              SAME pure line the master history table renders. */}
          {immunizationAdministrationLine(im) ? (
            <span
              className="block text-xs text-slate-400"
              data-testid={`dose-admin-${im.id}`}
            >
              {immunizationAdministrationLine(im)}
            </span>
          ) : null}
          {im.reaction ? (
            <span className="block text-xs text-amber-700 dark:text-amber-300">
              Reaction: {im.reaction}
            </span>
          ) : null}
        </>
      ),
    },
    {
      header: "Via",
      cellClassName: "text-slate-500 dark:text-slate-400",
      cell: (im) =>
        im.vaccine === code ? "Direct" : vaccineDisplayName(im.vaccine),
    },
    {
      header: "Administered by",
      cellClassName: "text-slate-600 dark:text-slate-300",
      cell: (im) => im.provider_name ?? "—",
    },
  ];

  return (
    <div className="mt-3">
      <RecordTable
        items={ordered}
        columns={columns}
        emptyMessage="No doses recorded for this vaccine yet."
        renderEditForm={(im, done) => (
          <>
            {im.vaccine !== code && (
              <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                This dose was given as{" "}
                <span className="font-medium">
                  {vaccineDisplayName(im.vaccine)}
                </span>
                , a combination shot — editing it affects every vaccine it
                credits.
              </p>
            )}
            <ImmunizationForm
              action={updateImmunization}
              immunization={im}
              onDone={done}
              defaultDate={defaultDate}
            />
          </>
        )}
        confirmDelete={(im) => {
          const via =
            im.vaccine === code
              ? ""
              : ` (given as ${vaccineDisplayName(im.vaccine)})`;
          return {
            title: "Delete dose",
            message: `Delete the ${im.date} dose${via}? This removes the one recorded dose${
              im.vaccine === code ? "" : " and its credit to every component"
            }. This can’t be undone.`,
          };
        }}
        onDelete={async (im) => {
          const fd = new FormData();
          fd.set("id", String(im.id));
          await deleteImmunization(fd);
        }}
      />
    </div>
  );
}
