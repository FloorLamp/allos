"use client";

import { useTransition } from "react";
import { IconX } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";

// Delete button for an uploaded medical document. Confirms first, since deleting
// also removes the records it imported.
export default function DeleteDocumentButton({
  id,
  filename,
  action,
}: {
  id: number;
  filename: string;
  action: (formData: FormData) => void;
}) {
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();

  async function onClick() {
    const ok = await confirm({
      title: "Delete document",
      message: `Delete “${filename}” and the results it imported? This can’t be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("id", String(id));
    startTransition(() => action(fd));
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="text-slate-300 hover:text-rose-500 disabled:opacity-50 dark:text-slate-600"
      aria-label="Delete document"
    >
      <IconX className="h-4 w-4" />
    </button>
  );
}
