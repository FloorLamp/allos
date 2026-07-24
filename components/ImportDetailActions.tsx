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
import type { ImportActionExplainers } from "@/lib/import-actions-copy";

// The re-run + delete actions on the import-detail page (#1071). Re-extraction
// is preview-first ONLY (ReprocessDiffPanel: "Preview changes" → "Save changes")
// — there is no immediate fire-and-replace control anymore; "Re-apply saved
// extraction" replays the cached extraction with no AI call; "Delete document &
// its records" confirms (it also removes the imported results) and navigates back
// to the import log, since the detail page's own document is gone afterward.
//
// `hasRaw` — whether this document has a SAVED AI extraction to re-apply from
// (#903). Health records (CCD/XDM/SHC/FHIR) import deterministically and have
// none, so the re-import affordance is hidden for them rather than offered and
// then refused.
export default function ImportDetailActions({
  id,
  filename,
  hasRaw = false,
  explainers,
}: {
  id: number;
  filename: string;
  hasRaw?: boolean;
  // Per-control explainer copy, selected upstream by the deterministic-vs-AI ×
  // hasRaw matrix (lib/import-actions-copy.ts, #1340). Each rendered button carries
  // its own subtext; the orphan paragraph that narrated all three verbs — including
  // a re-apply that often wasn't rendered — is gone.
  explainers: ImportActionExplainers;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [deleting, startDelete] = useTransition();
  const [reimporting, startReimport] = useTransition();
  const [rawResult, setRawResult] = useState<ReprocessFromRawResult | null>(
    null
  );

  // Re-apply the extraction already saved on this document: re-runs only the
  // parsing/import half, so it makes NO AI call and costs no daily quota. The right
  // action when the saved extraction was fine but the app imported it wrong.
  async function onReimportFromRaw() {
    const ok = await confirm({
      title: "Re-apply saved extraction",
      message: (
        <div className="space-y-2">
          <p>
            Re-applies the AI extraction already saved with “{filename}” —{" "}
            <strong>no AI call, and no daily extraction quota used</strong>.
          </p>
          <p>
            This document&apos;s imported records are replaced and any manual
            edits to them are discarded — records you added by hand are
            untouched. Use “Preview changes” above instead if the extraction
            itself was wrong and needs a fresh AI re-run.
          </p>
        </div>
      ),
      confirmLabel: "Re-apply",
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
          message: "Couldn't re-import. Try again.",
        });
      }
    });
  }

  async function onDelete() {
    const ok = await confirm({
      title: "Delete document & its records",
      message: `Delete “${filename}” and every record it imported? This can’t be undone.`,
      confirmLabel: "Delete document & its records",
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
        subtext={explainers.preview}
      />
      {hasRaw && explainers.reapply && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onReimportFromRaw}
              disabled={deleting || reimporting}
              data-testid="reimport-from-raw"
              className="btn-ghost inline-flex items-center gap-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <IconRefresh className="h-4 w-4" />
              {reimporting ? "Re-applying…" : "Re-apply saved extraction"}
            </button>
            {rawResult && (
              <span className={`text-sm ${rawTone}`}>{rawResult.message}</span>
            )}
          </div>
          <p
            data-testid="reapply-subtext"
            className="text-xs text-slate-500 dark:text-slate-400"
          >
            {explainers.reapply}
          </p>
        </div>
      )}
      <div className="space-y-1">
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting || reimporting}
          data-testid="delete-document"
          className="btn-ghost inline-flex items-center gap-1.5 text-sm text-rose-600 hover:text-rose-700 disabled:opacity-50 dark:text-rose-400"
        >
          <IconTrash className="h-4 w-4" />
          {deleting ? "Deleting…" : "Delete"}
        </button>
        <p
          data-testid="delete-subtext"
          className="text-xs text-slate-500 dark:text-slate-400"
        >
          {explainers.delete}
        </p>
      </div>
    </div>
  );
}
