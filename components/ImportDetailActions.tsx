"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconTrash } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import ReprocessDiffPanel from "@/components/ReprocessDiffPanel";
import { deleteMedicalDocument } from "@/app/(app)/medical/document-actions";

// The reprocess + delete actions on the import-detail page. Reprocess
// is now preview-first (ReprocessDiffPanel: preview the diff, then confirm the
// commit); delete confirms (it also removes the imported results) and navigates
// back to the import log, since the detail page's own document is gone afterward.
export default function ImportDetailActions({
  id,
  filename,
}: {
  id: number;
  filename: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [deleting, startDelete] = useTransition();

  async function onDelete() {
    const ok = await confirm({
      title: "Delete document",
      message: `Delete “${filename}” and the results it imported? This can’t be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("id", String(id));
    startDelete(async () => {
      await deleteMedicalDocument(fd);
      router.push("/data?section=import");
    });
  }

  return (
    <div className="space-y-4">
      <ReprocessDiffPanel id={id} filename={filename} disabled={deleting} />
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        className="btn-ghost inline-flex items-center gap-1.5 text-sm text-rose-600 hover:text-rose-700 disabled:opacity-50 dark:text-rose-400"
      >
        <IconTrash className="h-4 w-4" />
        {deleting ? "Deleting…" : "Delete"}
      </button>
    </div>
  );
}
