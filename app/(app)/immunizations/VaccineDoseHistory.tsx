"use client";

import { useState } from "react";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import ImmunizationForm from "./ImmunizationForm";
import { updateImmunization, deleteImmunization } from "./actions";
import { useConfirm } from "@/components/ConfirmDialog";
import NotesText from "@/components/NotesText";
import { vaccineDisplayName } from "@/lib/immunization-catalog";
import {
  resolveDoseLabels,
  seriesLengthForCode,
} from "@/lib/immunization-status";
import type { Immunization } from "@/lib/types";

// Editable dose list for the per-vaccine detail page. Lists every stored dose
// that credits this vaccine (its own code plus any combination shot whose
// components include it) with an auto "Dose N [of M]" label, the read-only "via"
// combo provenance, and inline edit / delete — reusing the shared
// ImmunizationForm and the update/delete server actions (same pattern as the
// master "All recorded doses" table). Editing/deleting a combo dose here affects
// the one physical dose, and therefore every component series it credits.
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
  const [editingId, setEditingId] = useState<number | null>(null);
  const confirm = useConfirm();

  // Numbered within this vaccine's series (direct + combo doses together, by
  // date); a user's explicit dose_label wins. Pure helper shared with the history.
  const labels = resolveDoseLabels(doses, seriesLengthForCode(code));

  // Display order: chronological ascending (dose 1 first), matching the numbering.
  const ordered = [...doses].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id - b.id
  );

  async function onDelete(im: Immunization) {
    const via =
      im.vaccine === code
        ? ""
        : ` (given as ${vaccineDisplayName(im.vaccine)})`;
    const ok = await confirm({
      title: "Delete dose",
      message: `Delete the ${im.date} dose${via}? This removes the one recorded dose${
        im.vaccine === code ? "" : " and its credit to every component"
      }. This can’t be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("id", String(im.id));
    await deleteImmunization(fd);
  }

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-black/5 dark:border-white/10">
            <th className="th">Date</th>
            <th className="th">Dose</th>
            <th className="th">Via</th>
            <th className="th">Administered by</th>
            <th className="th" />
          </tr>
        </thead>
        <tbody>
          {ordered.map((im) =>
            editingId === im.id ? (
              <tr key={im.id}>
                <td colSpan={5} className="p-3">
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
                    onDone={() => setEditingId(null)}
                    defaultDate={defaultDate}
                  />
                </td>
              </tr>
            ) : (
              <tr
                key={im.id}
                className="border-b border-black/5 last:border-0 dark:border-white/10"
              >
                <td className="td whitespace-nowrap text-slate-600 dark:text-slate-300">
                  {im.date}
                </td>
                <td className="td text-slate-600 dark:text-slate-300">
                  {labels.get(im.id) ?? "—"}
                  <NotesText
                    notes={im.notes}
                    className="ml-2 text-xs text-slate-400"
                  />
                </td>
                <td className="td text-slate-500 dark:text-slate-400">
                  {im.vaccine === code
                    ? "Direct"
                    : vaccineDisplayName(im.vaccine)}
                </td>
                <td className="td text-slate-600 dark:text-slate-300">
                  {im.provider_name ?? "—"}
                </td>
                <td className="td">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => setEditingId(im.id)}
                      aria-label="Edit"
                      className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
                    >
                      <IconPencil className="h-4 w-4" stroke={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(im)}
                      aria-label="Delete"
                      className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950 dark:hover:text-rose-400"
                    >
                      <IconTrash className="h-4 w-4" stroke={1.75} />
                    </button>
                  </div>
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}
