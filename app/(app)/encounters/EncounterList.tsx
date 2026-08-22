"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { IconBuildingHospital } from "@tabler/icons-react";
import EncounterForm from "./EncounterForm";
import { updateEncounter, deleteEncounter } from "./actions";
import RecordTable, { type RecordColumn } from "@/components/RecordTable";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import ProviderName from "@/components/ProviderName";
import DiagnosisChips from "@/components/DiagnosisChips";
import FilterPills from "@/components/FilterPills";
import { diagnosisList } from "@/lib/diagnosis-chips";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import {
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
import { episodeHref } from "@/lib/hrefs";
import type { LinkedEpisodeRef } from "@/lib/queries";

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

const buildColumns = (
  fmt: DisplayFormatPrefs,
  linkedRecordCounts: Record<number, number>,
  episodes: Record<number, LinkedEpisodeRef[]>
): RecordColumn<Encounter>[] => [
  {
    header: "Date",
    cellClassName: "whitespace-nowrap text-slate-600 dark:text-slate-300",
    cell: (e) => dateLabel(e, fmt),
  },
  {
    header: "Visit",
    cellClassName: "font-medium text-slate-800 dark:text-slate-100",
    cell: (e) => (
      <div>
        <Link
          href={`/encounters/${e.id}`}
          className="font-medium text-brand-700 transition hover:underline dark:text-brand-300"
        >
          {encounterTypeDisplay(e.type, e.class_code)}
        </Link>
        {(linkedRecordCounts[e.id] ?? 0) > 0 ? (
          <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">
            {linkedRecordCounts[e.id]} linked record
            {linkedRecordCounts[e.id] === 1 ? "" : "s"}
          </span>
        ) : null}
        {(episodes[e.id] ?? []).map((episode) => (
          <Link
            key={episode.id}
            href={episodeHref(episode.id)}
            className="mr-1 mt-1 inline-flex badge bg-slate-100 text-xs font-normal text-slate-600 hover:text-brand-700 dark:bg-ink-800 dark:text-slate-300"
          >
            {episode.situation}
          </Link>
        ))}
      </div>
    ),
  },
  {
    header: "Chief complaint",
    cellClassName: "text-slate-600 dark:text-slate-300",
    // The three placeholder columns of this table (#2588). On a phone an unfilled
    // one used to read "CHIEF COMPLAINT —"; an Imaging visit with none of the three
    // was a card of nothing but dashes.
    empty: (e) => !e.reason,
    cell: (e) =>
      e.reason ? (
        <span className="wrap-break-word">{e.reason}</span>
      ) : (
        <span className="text-slate-400">—</span>
      ),
  },
  {
    header: "Diagnoses",
    headerClassName: "hidden sm:table-cell",
    cellClassName: "hidden sm:table-cell",
    empty: (e) => diagnosisList(e.diagnoses).length === 0,
    // The desktop grid keeps its "—" so the columns stay aligned; the card drops
    // the line entirely through `empty` above (#2588).
    cell: (e) =>
      diagnosisList(e.diagnoses).length > 0 ? (
        <DiagnosisChips
          diagnoses={e.diagnoses}
          diagnosisRanks={e.diagnosis_ranks}
        />
      ) : (
        <span className="text-slate-400">—</span>
      ),
  },
  {
    header: "Provider",
    headerClassName: "hidden md:table-cell",
    cellClassName: "hidden whitespace-nowrap md:table-cell",
    empty: (e) => !e.provider_name && !e.location_name,
    cell: (e) =>
      e.provider_name || e.location_name ? (
        <div
          className="flex flex-col items-start gap-1 text-slate-500 dark:text-slate-400"
          data-testid="encounter-provider-cell"
        >
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
        </div>
      ) : (
        <span className="text-slate-400">—</span>
      ),
  },
];

// Visit history on the shared RecordTable, newest first (query order). Each row
// edits in place (the shared EncounterForm) or deletes; the diagnosis chips +
// attending-provider/facility display are preserved from the old card layout.
export default function EncounterList({
  items,
  defaultDate,
  multiView,
  linkedRecordCounts = {},
  episodes = {},
}: {
  items: Stamped<Encounter>[];
  defaultDate: string;
  // Multi-view (#1359): present only when several profiles are in view — RecordTable
  // then chips each non-acting row and gates its edit/delete on that member. Omitted
  // in single view → byte-identical.
  multiView?: ListMultiView;
  linkedRecordCounts?: Record<number, number>;
  episodes?: Record<number, LinkedEpisodeRef[]>;
}) {
  const fmt = useFormatPrefs();
  const undoable = useUndoableDelete();
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
      {/* THE FIFTH FILTER SPECIES RETIRES (#3408, items E and G). This row was a
          private `FilterChip` — a fifth shape for the one job
          components/FilterPills.tsx exists to be, and the reason the hub could
          grow an eleventh button species without anyone deciding to. It renders
          the shared control now, in CALLBACK mode (the filter is local state, not
          a query param), keeping its per-kind testids through `optionTestId`.
          Nothing about what it filters or how moved. */}
      {presentKinds.length > 1 ? (
        <div className="mb-3">
          <FilterPills
            options={[
              { value: "all" as const, label: "All" },
              ...presentKinds.map((k) => ({
                value: k,
                label: ENCOUNTER_KIND_LABELS[k],
              })),
            ]}
            value={kind}
            onSelect={setKind}
            label="Filter visits by type"
            testId="encounter-kind-filter"
            optionTestId={(v) => `encounter-kind-${v}`}
          />
        </div>
      ) : null}
      <RecordTable
        items={shown}
        itemName={(e) => `${dateLabel(e, fmt)} visit`}
        columns={buildColumns(fmt, linkedRecordCounts, episodes)}
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
            embedded
          />
        )}
        confirmDelete={(e) => ({
          title: "Delete visit",
          // What the delete actually costs, now that the visit itself comes back
          // (#1847): the detached back-links do NOT. Naming them is the whole point of
          // the confirm — "this can’t be undone" was both frightening and, since the
          // capture landed, untrue.
          message: `Delete the ${dateLabel(e, fmt)} visit? Anything recorded at it keeps its link to the visit cleared.`,
        })}
        onDelete={async (e) => {
          const fd = new FormData();
          fd.set("id", String(e.id));
          if (multiView) fd.set("profile_id", String(e.subject.profileId));
          await undoable(deleteEncounter, fd, {
            deletedMessage: "Visit deleted.",
          });
        }}
      />
    </>
  );
}
