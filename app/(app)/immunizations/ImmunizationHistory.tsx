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
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

// Sortable history table on the shared RecordTable. Click a header to sort
// (toggling asc/desc); each row edits in place (expands the shared form) or
// deletes. Defaults to date-descending; equal keys tie-break on date desc.
export default function ImmunizationHistory({
  items,
  defaultDate,
  multiView,
}: {
  items: Stamped<Immunization>[];
  defaultDate: string;
  // Multi-view (#1359): present only when several profiles are in view — RecordTable
  // chips each non-acting row and gates its edit/delete on that member. Omitted in
  // single view → byte-identical.
  multiView?: ListMultiView;
}) {
  const fmt = useFormatPrefs();
  // Auto "Dose N [of M]" labels, numbered within each stored vaccine's own
  // chronological sequence; a user's explicit dose_label wins (pure helper).
  //
  // The per-profile-context trap (#1096/#1359): dose-sequence numbering is a
  // PER-MEMBER computation — "Dose 2 of 3" counts within one person's own vaccine
  // history. In multi-view the rows span several profiles, so numbering the flat list
  // would commingle two members' sequences (both members' MMR doses numbered as one
  // series). So the labels are resolved PER SUBJECT: partition by the row's profile,
  // number each member's doses in their own context, then merge (ids are globally
  // unique, so the merge is collision-free). Single view partitions to one group and
  // is byte-identical.
  const doseLabels = multiView
    ? (() => {
        const merged = new Map<number, string>();
        const byProfile = new Map<number, Stamped<Immunization>[]>();
        for (const im of items) {
          const pid = im.subject.profileId;
          const list = byProfile.get(pid);
          if (list) list.push(im);
          else byProfile.set(pid, [im]);
        }
        for (const group of byProfile.values())
          for (const [id, label] of resolveDoseLabelsByVaccine(group))
            merged.set(id, label);
        return merged;
      })()
    : resolveDoseLabelsByVaccine(items);
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
      multiView={
        multiView
          ? {
              actingProfileId: multiView.actingProfileId,
              subjectOf: (im) => im.subject,
            }
          : undefined
      }
      renderEditForm={(im, done) => (
        <ImmunizationForm
          action={updateImmunization}
          immunization={im}
          profileId={multiView ? im.subject.profileId : undefined}
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
        if (multiView) fd.set("profile_id", String(im.subject.profileId));
        await deleteImmunization(fd);
      }}
    />
  );
}
