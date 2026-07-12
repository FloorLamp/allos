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
      await setEquipmentRetiredAction(id, next);
      toast(next ? `Retired ${name}` : `Restored ${name}`);
      router.refresh();
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
      await deleteEquipmentAction(id);
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
        className="btn-ghost inline-flex items-center gap-1.5 disabled:opacity-50"
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
        className="btn-ghost inline-flex items-center gap-1.5 text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-950"
      >
        <IconTrash className="h-4 w-4" /> Delete
      </button>
    </div>
  );
}
