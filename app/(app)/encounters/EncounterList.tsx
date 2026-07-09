"use client";

import { IconBuildingHospital } from "@tabler/icons-react";
import EncounterForm from "./EncounterForm";
import { updateEncounter, deleteEncounter } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import ProviderName from "@/components/ProviderName";
import { formatRecordDate } from "@/lib/record-format";
import type { Encounter } from "@/lib/types";

// The visit date, showing a range when the encounter spans multiple days.
function dateLabel(e: Encounter): string {
  const start = formatRecordDate(e.date, "");
  if (e.end_date && e.end_date !== e.date)
    return `${start} – ${formatRecordDate(e.end_date, "")}`;
  return start;
}

// Split the "; "-joined diagnoses summary into individual chips. Split on the
// delimiter with any surrounding whitespace so it matches the "; " join exactly.
function diagnosisList(diagnoses: string | null): string[] {
  if (!diagnoses) return [];
  return diagnoses
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const COLUMNS: RecordColumn<Encounter>[] = [
  {
    header: "Date",
    cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
    cell: (e) => dateLabel(e),
  },
  {
    header: "Visit",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (e) => (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <span>{e.type || "Visit"}</span>
          {e.class_code ? (
            <span className="badge bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
              {e.class_code}
            </span>
          ) : null}
        </div>
        {e.reason ? (
          <span className="text-xs font-normal text-slate-400">{e.reason}</span>
        ) : null}
      </>
    ),
  },
  {
    header: "Diagnoses",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden sm:table-cell",
    cell: (e) => {
      const diagnoses = diagnosisList(e.diagnoses);
      return diagnoses.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {diagnoses.map((d, i) => (
            <span
              key={i}
              className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
            >
              {d}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-slate-400">—</span>
      );
    },
  },
  {
    header: "Provider",
    headerClassName: "hidden md:table-cell",
    cellClassName: "hidden whitespace-nowrap md:table-cell",
    cell: (e) =>
      e.provider_name || e.location_name ? (
        <div className="flex flex-col gap-1 text-slate-500 dark:text-slate-400">
          {e.provider_name ? (
            <ProviderName name={e.provider_name} className="" />
          ) : null}
          {e.location_name ? (
            <span className="inline-flex items-center gap-1.5">
              <IconBuildingHospital
                className="h-4 w-4 shrink-0"
                stroke={1.75}
              />
              {e.location_name}
            </span>
          ) : null}
        </div>
      ) : (
        <span className="text-slate-400">—</span>
      ),
  },
  {
    header: "Source",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden whitespace-nowrap sm:table-cell",
    cell: (e) => <RecordProvenance source={e.source} />,
  },
];

// Visit history on the shared RecordTable, newest first (query order). Each row
// edits in place (the shared EncounterForm) or deletes; the diagnosis chips +
// attending-provider/facility display are preserved from the old card layout.
export default function EncounterList({
  items,
  defaultDate,
}: {
  items: Encounter[];
  defaultDate: string;
}) {
  return (
    <RecordTable
      items={items}
      columns={COLUMNS}
      emptyMessage="No visits yet. Add one, or import a MyChart / CCD health record to populate your visit history."
      renderEditForm={(e, done) => (
        <EncounterForm
          action={updateEncounter}
          encounter={e}
          onDone={done}
          defaultDate={defaultDate}
        />
      )}
      confirmDelete={(e) => ({
        title: "Delete visit",
        message: `Delete the ${dateLabel(e)} visit? This can’t be undone.`,
      })}
      onDelete={async (e) => {
        const fd = new FormData();
        fd.set("id", String(e.id));
        await deleteEncounter(fd);
      }}
    />
  );
}
