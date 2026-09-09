"use client";

import { useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { IconTrash } from "@tabler/icons-react";
import Button from "./Button";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import { useConfirm } from "@/components/ConfirmDialog";
import { deleteEquipmentAction } from "@/app/(app)/equipment/actions";

export default function EquipmentDetailActions({
  id,
  name,
  children,
}: {
  id: number;
  name: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const undoable = useUndoableDelete();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();

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
      await undoable(
        async () =>
          res.ok ? { undoId: res.undoId } : { undoId: null, error: res.error },
        new FormData(),
        { deletedMessage: `Deleted ${name}` }
      );
      if (res.ok) router.push("/equipment");
    });
  }

  return (
    <div className="flex flex-wrap gap-3">
      {children}
      <Button
        type="button"
        onClick={remove}
        disabled={pending}
        data-testid="equipment-detail-delete"
        variant="danger"
      >
        <IconTrash className="h-4 w-4" /> Delete
      </Button>
    </div>
  );
}
