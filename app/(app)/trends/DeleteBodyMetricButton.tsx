"use client";

import { useState } from "react";
import { IconX } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import { deleteBodyMetric } from "./body-actions";

// Delete control for a body-metrics history row on the Trends "Body" tab. A plain
// button (not a form action) so confirm() can open a dialog the user must answer
// before the destructive delete runs — the same pattern goals/records use.
export default function DeleteBodyMetricButton({
  id,
  label,
}: {
  id: number;
  label: string;
}) {
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    const ok = await confirm({
      title: "Delete entry",
      message: `Delete the body-metrics entry from ${label}? You can undo this.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("id", String(id));
    setBusy(true);
    try {
      await undoable(deleteBodyMetric, fd, {
        deletedMessage: "Body-metrics entry deleted.",
      });
    } finally {
      setBusy(false);
    }
  }

  // The row's own date is already in hand for the confirm message, so the accessible
  // name says WHICH entry (#2530): a table of N buttons all named "Delete entry"
  // tells a screen-reader user nothing about which record is about to be destroyed,
  // in the one place rows are destroyed.
  const name = `Delete entry from ${label}`;

  return (
    <button
      type="button"
      onClick={onDelete}
      disabled={busy}
      aria-label={name}
      title={name}
      className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-sm text-slate-300 transition hover:bg-slate-100 hover:text-rose-500 disabled:opacity-50 dark:hover:bg-ink-800"
    >
      <IconX className="h-4 w-4" />
    </button>
  );
}
