"use client";

import { useState, useTransition } from "react";
import NotesText from "@/components/NotesText";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { undoDelete } from "@/app/(app)/undo-actions";
import { emptyTrashNow, purgeTrashEntry } from "./trash-actions";
import { trashEntryHeadline, type TrashEntry } from "@/lib/trash";

// Data → Trash, the interactive half (issue #2013).
//
// RESTORE CALLS THE SAME ACTION THE TOAST CALLS. `undoDelete` is the one restore
// boundary over `restoreDeletedRow`, so a row restored from here goes through exactly
// the machinery a 15-second Undo does — new ids, reconciled external FK links, merge
// inversion, re-import tombstone removal. This surface adds no restore logic of its
// own; it just makes the token reachable after the toast is gone.
//
// EVERY OUTCOME IS RENDERED FROM WHAT THE ACTION ACTUALLY DID. A capture can be gone
// by the time a button is tapped — swept by the hourly tick, restored in another tab —
// and "Restored"/"Deleted" would then be a claim about a write that never happened.

function expiryLine(entry: TrashEntry): string {
  if (entry.expiresInDays === 0) return "Expires today";
  if (entry.expiresInDays === 1) return "Expires tomorrow";
  return `Expires in ${entry.expiresInDays} days`;
}

function TrashRow({ entry }: { entry: TrashEntry }) {
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  function onRestore() {
    startTransition(async () => {
      const res = await undoDelete(entry.id);
      if (res.ok) {
        // The action revalidates, so this row LEAVES the list — the entry
        // disappearing is the feedback, and the toast names where it went.
        toast("Restored.");
      } else {
        setOutcome("Couldn’t restore — it may have expired or already be back.");
      }
    });
  }

  async function onPurge() {
    const ok = await confirm({
      title: "Delete permanently?",
      message: `“${trashEntryHeadline(entry)}” and anything captured with it — including any video clips — will be removed now. This cannot be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await purgeTrashEntry(entry.id);
      if (res.ok) toast("Deleted permanently.");
      else setOutcome(res.message);
    });
  }

  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/5 p-3 dark:border-white/5"
      data-testid="trash-row"
    >
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm text-slate-800 dark:text-slate-100"
          data-testid="trash-row-headline"
        >
          {trashEntryHeadline(entry)}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {entry.label}
          {entry.childCount > 0
            ? ` · ${entry.childCount} related ${entry.childCount === 1 ? "row" : "rows"}`
            : ""}{" "}
          · Deleted {entry.deletedAt.slice(0, 10)} · {expiryLine(entry)}
        </p>
        <NotesText
          notes={entry.notes}
          as="p"
          className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400"
        />
        {outcome && (
          <p
            className="mt-1 text-xs text-slate-500 dark:text-slate-400"
            data-testid="trash-row-outcome"
          >
            {outcome}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className="btn-ghost"
          disabled={pending}
          onClick={onRestore}
          data-testid="trash-restore"
        >
          Restore
        </button>
        <button
          type="button"
          className="btn-danger"
          disabled={pending}
          onClick={onPurge}
          data-testid="trash-purge"
        >
          Delete permanently
        </button>
      </div>
    </li>
  );
}

export default function TrashList({ entries }: { entries: TrashEntry[] }) {
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const toast = useToast();

  async function onEmpty() {
    const ok = await confirm({
      title: "Empty the trash?",
      message: `All ${entries.length} deleted ${entries.length === 1 ? "row" : "rows"} — and any video clips captured with them — will be removed now. This cannot be undone.`,
      confirmLabel: "Empty trash",
      danger: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const { purged } = await emptyTrashNow();
      // Report what the write DID: another tab may have emptied it first, and
      // "Emptied" would then describe a purge that removed nothing.
      toast(
        purged === 0
          ? "Nothing left to empty."
          : `Deleted ${purged} ${purged === 1 ? "row" : "rows"} permanently.`
      );
    });
  }

  return (
    <div className="card space-y-3" data-testid="trash-list">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {entries.length} deleted {entries.length === 1 ? "row" : "rows"}
        </p>
        <button
          type="button"
          className="btn-ghost"
          disabled={pending}
          onClick={onEmpty}
          data-testid="trash-empty-all"
        >
          Empty trash
        </button>
      </div>
      <ul className="space-y-2">
        {entries.map((e) => (
          <TrashRow key={e.id} entry={e} />
        ))}
      </ul>
    </div>
  );
}
