"use client";

import { useMemo, useState } from "react";
import SkinLesionForm from "./SkinLesionForm";
import TrackSkinFollowUpControl from "./TrackSkinFollowUpControl";
import LesionPhotoStrip from "./LesionPhotoStrip";
import NotesText from "@/components/NotesText";
import RecordProvenance from "@/components/RecordProvenance";
import { useConfirmedAction } from "@/components/useConfirmedAction";
import { formatRecordDate } from "@/lib/record-format";
import { updateSkinLesion, deleteSkinLesion } from "./actions";
import {
  skinLesionDisplayLabel,
  skinLesionStatusLabel,
  skinLesionIdentityKey,
  bodyMapLabel,
  abcdeLetters,
  SKIN_LESION_STATUSES,
  type SkinLesionStatus,
} from "@/lib/skin-lesion";
import type { SkinLesionFollowUpSummary } from "@/lib/queries";
import type { SkinLesion } from "@/lib/types";
import type { LesionPhotoRow } from "@/lib/skin-photo-write";

const STATUS_BADGE: Record<string, string> = {
  watch: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  removed: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  active:
    "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE[status] ?? STATUS_BADGE.active}`}
    >
      {skinLesionStatusLabel(status).toLowerCase()}
    </span>
  );
}

// One observation record row (date, status, ABCDE letters, size, finding) with inline
// edit/delete and the Track-recheck control. Edit toggles the shared form in place.
function LesionRecordRow({
  record,
  followUp,
}: {
  record: SkinLesion;
  followUp?: SkinLesionFollowUpSummary;
}) {
  const [editing, setEditing] = useState(false);
  const { run: runDelete, pending: deleting } = useConfirmedAction(
    {
      title: "Delete lesion record",
      message: "Delete this observation? This can’t be undone.",
      confirmLabel: "Delete",
    },
    async () => {
      const fd = new FormData();
      fd.set("id", String(record.id));
      await deleteSkinLesion(fd);
    }
  );
  const letters = abcdeLetters(record);
  if (editing) {
    return (
      <div className="border-t border-black/5 py-2 dark:border-white/5">
        <SkinLesionForm
          action={updateSkinLesion}
          record={record}
          onDone={() => setEditing(false)}
        />
      </div>
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-black/5 py-2 text-sm dark:border-white/5"
      data-testid={`lesion-record-${record.id}`}
    >
      <span className="whitespace-nowrap font-medium text-slate-700 dark:text-slate-200">
        {formatRecordDate(record.observed_date)}
      </span>
      <StatusBadge status={record.status} />
      {letters && (
        <span
          className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          title="Recorded ABCDE observations"
        >
          ABCDE {letters}
        </span>
      )}
      {record.size_mm != null && (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {record.size_mm} mm
        </span>
      )}
      <NotesText
        as="span"
        notes={record.finding}
        className="min-w-0 flex-1 text-xs text-slate-500 dark:text-slate-400"
      />
      <RecordProvenance source={record.source} />
      <TrackSkinFollowUpControl
        recordId={record.id}
        offer={record.status !== "removed"}
        existing={followUp}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className="text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400"
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <button
          type="button"
          disabled={deleting}
          onClick={() => runDelete()}
          className="text-xs text-slate-400 underline hover:text-rose-600 disabled:opacity-60 dark:hover:text-rose-400"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// Manage stored skin lesions grouped by IDENTITY (#482) — each card is one lesion (its
// serial observations + photo strip), so "is this mole changing?" is answered in one
// place. Filter by status. `followUps` carries each record's tracked recheck; `photos`
// carries the profile's lesion photos, mapped to each lesion by lesion_id.
export default function SkinLesionList({
  items,
  followUps = [],
  photos = [],
}: {
  items: SkinLesion[];
  followUps?: SkinLesionFollowUpSummary[];
  photos?: LesionPhotoRow[];
}) {
  const [status, setStatus] = useState<SkinLesionStatus | "">("");

  const followUpByRecord = useMemo(() => {
    const m = new Map<number, SkinLesionFollowUpSummary>();
    for (const f of followUps)
      if (!m.has(f.sourceSkinLesionId)) m.set(f.sourceSkinLesionId, f);
    return m;
  }, [followUps]);

  const photosByLesion = useMemo(() => {
    const m = new Map<number, LesionPhotoRow[]>();
    for (const p of photos) {
      const arr = m.get(p.lesion_id) ?? [];
      arr.push(p);
      m.set(p.lesion_id, arr);
    }
    return m;
  }, [photos]);

  // Group records by identity; each group's records are newest-first (items already
  // arrive newest-first). Groups sort by their newest record's date.
  const groups = useMemo(() => {
    const filtered = items.filter((l) => !status || l.status === status);
    const byKey = new Map<string, SkinLesion[]>();
    for (const l of filtered) {
      const k = skinLesionIdentityKey(l);
      const arr = byKey.get(k) ?? [];
      arr.push(l);
      byKey.set(k, arr);
    }
    return [...byKey.values()].sort((a, b) =>
      (b[0].observed_date ?? "").localeCompare(a[0].observed_date ?? "")
    );
  }, [items, status]);

  return (
    <div data-testid="skin-lesion-list" className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Filter by status"
          className="input w-auto"
          value={status}
          onChange={(e) => setStatus(e.target.value as SkinLesionStatus | "")}
        >
          <option value="">All statuses</option>
          {SKIN_LESION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {skinLesionStatusLabel(s)}
            </option>
          ))}
        </select>
      </div>

      {groups.length === 0 ? (
        <p className="card text-sm text-slate-500 dark:text-slate-400">
          No skin lesions yet. Add one to start tracking a mole or spot over
          time with dated photos.
        </p>
      ) : (
        groups.map((group) => {
          const head = group[0];
          const groupPhotos = group.flatMap(
            (r) => photosByLesion.get(r.id) ?? []
          );
          const map = bodyMapLabel(head);
          return (
            <div
              key={skinLesionIdentityKey(head)}
              className="card space-y-3"
              data-testid="lesion-card"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                  {skinLesionDisplayLabel(head)}
                </h3>
                {map && (
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {map}
                  </span>
                )}
                <StatusBadge status={head.status} />
              </div>

              <LesionPhotoStrip lesionId={head.id} photos={groupPhotos} />

              <div>
                {group.map((r) => (
                  <LesionRecordRow
                    key={r.id}
                    record={r}
                    followUp={followUpByRecord.get(r.id)}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
