"use client";

import ImmunizationForm from "./ImmunizationForm";
import { updateImmunization, deleteImmunization } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import NotesText from "@/components/NotesText";
import { vaccineDisplayName } from "@/lib/immunization-catalog";
import {
  resolveDoseLabelsByVaccine,
  immunizationHasDuplicateVaccineDate,
} from "@/lib/immunization-status";
import { formatRecordDate, sourceLabel } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { Immunization } from "@/lib/types";

// Sortable history table on the shared RecordTable. Click a header to sort
// (toggling asc/desc); each row edits in place (expands the shared form) or
// deletes. Defaults to date-descending; equal keys tie-break on date desc.
export default function ImmunizationHistory({
  items,
  defaultDate,
}: {
  items: Immunization[];
  defaultDate: string;
}) {
  // Auto "Dose N [of M]" labels, numbered within each stored vaccine's own
  // chronological sequence; a user's explicit dose_label wins (pure helper).
  const fmt = useFormatPrefs();
  const doseLabels = resolveDoseLabelsByVaccine(items);
  const doseLabel = (im: Immunization): string => doseLabels.get(im.id) ?? "—";

  const columns: RecordColumn<Immunization>[] = [
    {
      header: "Vaccine",
      cellClassName: "font-medium text-slate-800 dark:text-slate-100",
      sort: { value: (im) => vaccineDisplayName(im.vaccine).toLowerCase() },
      cell: (im) => (
        <>
          {vaccineDisplayName(im.vaccine)}
          <NotesText
            notes={im.notes}
            className="ml-2 text-xs font-normal text-slate-400"
          />
        </>
      ),
    },
    {
      header: "Date",
      cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
      sort: { value: (im) => im.date, initialDir: "desc" },
      cell: (im) => formatRecordDate(im.date, "—", fmt),
    },
    {
      header: "Dose",
      cellClassName: "text-slate-600 dark:text-slate-300",
      sort: { value: (im) => doseLabel(im).toLowerCase() },
      cell: (im) => doseLabel(im),
    },
    {
      header: "Administered by",
      cellClassName: "text-slate-600 dark:text-slate-300",
      sort: { value: (im) => (im.provider_name ?? "").toLowerCase() },
      cell: (im) => im.provider_name ?? "—",
    },
    {
      header: "Source",
      cellClassName: "whitespace-nowrap",
      sort: { value: (im) => sourceLabel(im.source).toLowerCase() },
      cell: (im) => <RecordProvenance source={im.source} />,
    },
  ];

  return (
    <RecordTable
      items={items}
      columns={columns}
      emptyMessage="No immunizations recorded yet. Add one, or import a MyChart export."
      defaultSort={{ index: 1, dir: "desc" }}
      tieBreak={(a, b) => b.date.localeCompare(a.date)}
      renderEditForm={(im, done) => (
        <ImmunizationForm
          action={updateImmunization}
          immunization={im}
          onDone={done}
          defaultDate={defaultDate}
        />
      )}
      confirmDelete={(im) => {
        // "vaccine + date" collides for a duplicate-imported same-vaccine-same-date
        // pair (#534); fold in the distinguishing dose/provider (id as last resort)
        // so the confirm names the row the id-keyed delete actually removes.
        let extra = "";
        if (immunizationHasDuplicateVaccineDate(items, im)) {
          const bits: string[] = [];
          const dose = doseLabel(im);
          if (dose && dose !== "—") bits.push(dose);
          if (im.provider_name) bits.push(im.provider_name);
          if (bits.length === 0) bits.push(`#${im.id}`);
          extra = ` (${bits.join(", ")})`;
        }
        return {
          title: "Delete immunization",
          message: `Delete the ${vaccineDisplayName(im.vaccine)} record from ${im.date}${extra}? This can’t be undone.`,
        };
      }}
      onDelete={async (im) => {
        const fd = new FormData();
        fd.set("id", String(im.id));
        await deleteImmunization(fd);
      }}
    />
  );
}
