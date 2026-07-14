"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconInfoCircle, IconLock } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { clearEditLock } from "@/app/(app)/data/review-actions";

// The tables whose imported rows carry the user-edit lock (#133); the same set the
// clearEditLock server action whitelists.
export type EditLockTable = "activities" | "body_metrics" | "medical_records";

// The consequence hint stated everywhere the lock is surfaced (#659, ask 3): the
// badge tooltip and the resume-confirm both use it, so the copy can't drift.
const CONSEQUENCE = "Hand-edited — imports will no longer update this row.";

// Shared badge + "Resume sync updates" behavior for a hand-edited imported row
// (issue #659). Rendered on the surfaces that show an edit-locked row — the body
// metrics history table, the biomarker record editor, and the activity provenance
// footer — so the lock reads consistently and every one offers the same clear path.
// Clearing warns that the next sync may overwrite the hand-fix (the undo-inverts-
// side-state convention: resuming sync is a deliberate, reversible-by-re-editing act).
export default function EditLockNotice({
  table,
  id,
  showResume = true,
  appearance = "badge",
  consequence = CONSEQUENCE,
  className,
}: {
  table: EditLockTable;
  id: number;
  // Compact feed surfaces can move the action into their overflow menu while
  // retaining this short status marker and its consequence tooltip.
  showResume?: boolean;
  appearance?: "badge" | "icon";
  consequence?: string;
  className?: string;
}) {
  const { busy, resumeSyncUpdates } = useResumeSyncUpdates(table, id);

  return (
    <span
      className={`inline-flex flex-wrap items-center gap-1.5${
        className ? ` ${className}` : ""
      }`}
      data-testid="edit-lock-notice"
    >
      {appearance === "icon" ? (
        <span
          role="img"
          aria-label={consequence}
          title={consequence}
          className="inline-flex"
          data-testid="edit-lock-icon"
        >
          <IconInfoCircle className="h-3.5 w-3.5" stroke={2} aria-hidden />
        </span>
      ) : (
        <span
          className="badge inline-flex items-center gap-1 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
          title={consequence}
          data-testid="edit-lock-badge"
        >
          <IconLock className="h-3 w-3" stroke={2} aria-hidden />
          Sync locked
        </span>
      )}
      {showResume && (
        <button
          type="button"
          onClick={() => void resumeSyncUpdates()}
          disabled={busy}
          className="text-xs font-medium text-brand-600 hover:underline disabled:opacity-50 dark:text-brand-400"
          data-testid="edit-lock-resume"
        >
          Resume sync updates
        </button>
      )}
    </span>
  );
}

// One confirmation/action/outcome path shared by inline notices and overflow-menu
// actions, so moving an affordance never forks the overwrite warning or toast.
export function useResumeSyncUpdates(table: EditLockTable, id: number) {
  const confirm = useConfirm();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function resumeSyncUpdates() {
    const ok = await confirm({
      title: "Resume sync updates",
      message:
        "This row is hand-edited, so imports currently leave it alone. Resume " +
        "sync updates? The next sync may overwrite your edit with the provider's " +
        "value.",
      confirmLabel: "Resume updates",
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("table", table);
    fd.set("id", String(id));
    setBusy(true);
    try {
      const res = await clearEditLock(fd);
      if (res.ok) {
        toast("Sync updates resumed for this row.");
        router.refresh();
      } else {
        toast(res.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return { busy, resumeSyncUpdates };
}
