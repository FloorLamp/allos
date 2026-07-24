"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { IconBuildingHospital } from "@tabler/icons-react";
import EncounterForm from "./EncounterForm";
import { updateEncounter, deleteEncounter } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import RecordProvenance from "@/components/RecordProvenance";
import ProviderName from "@/components/ProviderName";
import OpenInMaps from "@/components/OpenInMaps";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import {
  classLabel,
  encounterKind,
  encounterTypeDisplay,
  ENCOUNTER_KIND_LABELS,
  ENCOUNTER_KIND_ORDER,
  type EncounterKind,
} from "@/lib/encounter-kind";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import type { Encounter } from "@/lib/types";
import type { Stamped } from "@/lib/scope";
import type { ListMultiView } from "@/lib/multi-view";

// The canonical kind of one encounter (#1233) — the ONE identity function every
// surface keys on, never a per-surface string match.
function kindOf(e: Encounter): EncounterKind {
  return encounterKind({
    classCode: e.class_code,
    code: e.code,
    codeSystem: e.code_system,
    type: e.type,
  });
}

// The visit date, showing a range when the encounter spans multiple days.
function dateLabel(e: Encounter, fmt: DisplayFormatPrefs): string {
  const start = formatRecordDate(e.date, "", fmt);
  if (e.end_date && e.end_date !== e.date)
    return `${start} – ${formatRecordDate(e.end_date, "", fmt)}`;
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

const buildColumns = (fmt: DisplayFormatPrefs): RecordColumn<Encounter>[] => [
  {
    header: "Date",
    cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
    cell: (e) => dateLabel(e, fmt),
  },
  {
    header: "Visit",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (e) => (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/encounters/${e.id}`}
            className="transition hover:text-brand-700 hover:underline dark:hover:text-brand-300"
          >
            {encounterTypeDisplay(e.type, e.class_code)}
          </Link>
          {e.class_code ? (
            <span className="badge bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
              {classLabel(e.class_code)}
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
            <ProviderName
              name={e.provider_name}
              providerId={e.provider_id}
              className=""
            />
          ) : null}
          {e.location_name ? (
            e.location_provider_id ? (
              <Link
                href={`/providers/${e.location_provider_id}`}
                className="inline-flex items-center gap-1.5 hover:text-brand-700 hover:underline dark:hover:text-brand-300"
              >
                <IconBuildingHospital
                  className="h-4 w-4 shrink-0"
                  stroke={1.75}
                />
                {e.location_name}
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <IconBuildingHospital
                  className="h-4 w-4 shrink-0"
                  stroke={1.75}
                />
                {e.location_name}
              </span>
            )
          ) : null}
          {e.location_address ? (
            <OpenInMaps
              address={e.location_address}
              label="Directions"
              showIcon={false}
              className="text-xs text-brand-700 hover:underline dark:text-brand-300"
            />
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
  multiView,
}: {
  items: Stamped<Encounter>[];
  defaultDate: string;
  // Multi-view (#1359): present only when several profiles are in view — RecordTable
  // then chips each non-acting row and gates its edit/delete on that member. Omitted
  // in single view → byte-identical.
  multiView?: ListMultiView;
}) {
  const fmt = useFormatPrefs();
  // Canonical-kind filter (#1233): "show ED visits" and friends, keyed on the ONE
  // encounterKind() identity function. Only the kinds actually present appear as
  // chips (in the canonical order), so a list with a single kind shows no filter.
  const [kind, setKind] = useState<EncounterKind | "all">("all");
  const presentKinds = useMemo(() => {
    const seen = new Set<EncounterKind>();
    for (const e of items) seen.add(kindOf(e));
    return ENCOUNTER_KIND_ORDER.filter((k) => seen.has(k));
  }, [items]);
  const shown = useMemo(
    () => (kind === "all" ? items : items.filter((e) => kindOf(e) === kind)),
    [items, kind]
  );

  return (
    <>
      {presentKinds.length > 1 ? (
        <div
          className="mb-3 flex flex-wrap gap-1.5"
          data-testid="encounter-kind-filter"
        >
          <FilterChip
            label="All"
            active={kind === "all"}
            onClick={() => setKind("all")}
            testid="encounter-kind-all"
          />
          {presentKinds.map((k) => (
            <FilterChip
              key={k}
              label={ENCOUNTER_KIND_LABELS[k]}
              active={kind === k}
              onClick={() => setKind(k)}
              testid={`encounter-kind-${k}`}
            />
          ))}
        </div>
      ) : null}
      <RecordTable
        items={shown}
        columns={buildColumns(fmt)}
        emptyMessage="No visits yet. Add one, or import a MyChart / CCD health record to populate your visit history."
        multiView={
          multiView
            ? {
                actingProfileId: multiView.actingProfileId,
                subjectOf: (e) => e.subject,
              }
            : undefined
        }
        renderEditForm={(e, done) => (
          <EncounterForm
            action={updateEncounter}
            encounter={e}
            profileId={multiView ? e.subject.profileId : undefined}
            onDone={done}
            defaultDate={defaultDate}
          />
        )}
        confirmDelete={(e) => ({
          title: "Delete visit",
          message: `Delete the ${dateLabel(e, fmt)} visit? This can’t be undone.`,
        })}
        onDelete={async (e) => {
          const fd = new FormData();
          fd.set("id", String(e.id));
          if (multiView) fd.set("profile_id", String(e.subject.profileId));
          await deleteEncounter(fd);
        }}
      />
    </>
  );
}

// A single kind-filter chip. Active chip reads as a solid brand pill; inactive as a
// quiet outline. `data-testid` gives the browser test a stable per-kind hook.
function FilterChip({
  label,
  active,
  onClick,
  testid,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testid}
      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
        active
          ? "bg-brand-600 text-white dark:bg-brand-500"
          : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-700"
      }`}
    >
      {label}
    </button>
  );
}
