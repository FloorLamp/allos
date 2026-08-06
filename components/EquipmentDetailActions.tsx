"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconArchive, IconArchiveOff, IconTrash } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  deleteEquipmentAction,
  setEquipmentRetiredAction,
} from "@/app/(app)/equipment/actions";

// The detail-page action row (issue #343): Retire/Restore lives here (the detail
// page is where the #341 lifecycle acts), plus Delete. Delete confirms, then
// navigates back to the index (the row is gone). Retire toggles in place.
export default function EquipmentDetailActions({
  id,
  name,
  retired,
}: {
  id: number;
  name: string;
  retired: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();

  function toggleRetired() {
    const next = !retired;
    startTransition(async () => {
      // Typed outcome rendered (#2138): a stale tab's repeat tap or a since-deleted
      // row reports its refusal in the error tone; the toast never outruns the write.
      const res = await setEquipmentRetiredAction(id, next);
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(next ? `Retired ${name}` : `Restored ${name}`);
    });
  }

  async function remove() {
    const ok = await confirm({
      title: "Delete equipment",
      message: `Delete “${name}”? Logged sessions keep their data but lose the equipment label.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await deleteEquipmentAction(id);
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(`Deleted ${name}`);
      router.push("/equipment");
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={toggleRetired}
        disabled={pending}
        data-testid="equipment-detail-retire"
        className="btn-ghost inline-flex items-center gap-1.5"
      >
        {retired ? (
          <>
            <IconArchiveOff className="h-4 w-4" /> Restore
          </>
        ) : (
          <>
            <IconArchive className="h-4 w-4" /> Retire
          </>
        )}
      </button>
      <button
        type="button"
        onClick={remove}
        disabled={pending}
        data-testid="equipment-detail-delete"
        className="btn-ghost inline-flex items-center gap-1.5 text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950"
      >
        <IconTrash className="h-4 w-4" /> Delete
      </button>
    </div>
  );
}
