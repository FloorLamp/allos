"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconTrash, IconRefresh } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import ReprocessDiffPanel from "@/components/ReprocessDiffPanel";
import {
  deleteMedicalDocument,
  reprocessDocumentFromRaw,
} from "@/app/(app)/medical/document-actions";
import type { ReprocessFromRawResult } from "@/lib/medical-pipeline";

// The reprocess + delete actions on the import-detail page. Reprocess
// is now preview-first (ReprocessDiffPanel: preview the diff, then confirm the
// commit); delete confirms (it also removes the imported results) and navigates
// back to the import log, since the detail page's own document is gone afterward.
//
// `hasRaw` — whether this document has a SAVED AI extraction to re-import from
// (#903). Health records (CCD/XDM/SHC/FHIR) import deterministically and have
// none, so the re-import affordance is hidden for them rather than offered and
// then refused.
export default function ImportDetailActions({
  id,
  filename,
  hasRaw = false,
}: {
  id: number;
  filename: string;
  hasRaw?: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [deleting, startDelete] = useTransition();
  const [reimporting, startReimport] = useTransition();
  const [rawResult, setRawResult] = useState<ReprocessFromRawResult | null>(
    null
  );

  // Re-import from the extraction already saved on this document: re-runs only the
  // parsing/import half, so it makes NO AI call and costs no daily quota. The right
  // action when the saved extraction was fine but the app imported it wrong.
  async function onReimportFromRaw() {
    const ok = await confirm({
      title: "Re-import from saved extraction",
      message: (
        <div className="space-y-2">
          <p>
            Re-imports “{filename}” from the AI extraction already saved with it
            — <strong>no AI call, and no daily extraction quota used</strong>.
          </p>
          <p>
            This document&apos;s imported records are replaced and any manual
            edits to them are discarded — records you added by hand are
            untouched. Use “Re-extract” instead if the extraction itself was
            wrong.
          </p>
        </div>
      ),
      confirmLabel: "Re-import",
    });
    if (!ok) return;
    setRawResult(null);
    const fd = new FormData();
    fd.set("id", String(id));
    startReimport(async () => {
      try {
        setRawResult(await reprocessDocumentFromRaw(fd));
        router.refresh();
      } catch {
        // Keep a throw on this row instead of escalating to the route error
        // boundary (issue #477).
        setRawResult({
          status: "failed",
          message: "Re-import failed. Please try again.",
        });
      }
    });
  }

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

  const rawTone =
    rawResult?.status === "done"
      ? "text-slate-500 dark:text-slate-400"
      : "text-amber-600 dark:text-amber-400";

  return (
    <div className="space-y-4">
      <ReprocessDiffPanel
        id={id}
        filename={filename}
        disabled={deleting || reimporting}
      />
      {hasRaw && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onReimportFromRaw}
            disabled={deleting || reimporting}
            data-testid="reimport-from-raw"
            className="btn-ghost inline-flex items-center gap-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <IconRefresh className="h-4 w-4" />
            {reimporting ? "Re-importing…" : "Re-import from saved extraction"}
          </button>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            No AI call — re-reads the extraction saved with this document.
          </span>
          {rawResult && (
            <span className={`text-sm ${rawTone}`}>{rawResult.message}</span>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting || reimporting}
        className="btn-ghost inline-flex items-center gap-1.5 text-sm text-rose-600 hover:text-rose-700 disabled:opacity-50 dark:text-rose-400"
      >
        <IconTrash className="h-4 w-4" />
        {deleting ? "Deleting…" : "Delete"}
      </button>
    </div>
  );
}
