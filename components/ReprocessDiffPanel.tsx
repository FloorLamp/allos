"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconRefresh } from "@tabler/icons-react";
import {
  previewReprocess,
  applyReprocessPreview,
} from "@/app/(app)/medical/document-actions";
import type { PreviewReprocessResult } from "@/lib/medical-pipeline";
import type { EntityDiff } from "@/lib/import-diff";
import { reprocessPreviewView } from "@/lib/reprocess-preview-view";

// Preview-first re-extraction — the SOLE per-document reprocess control (#1071).
// Instead of silently re-extracting and replacing a document's rows, this previews
// the diff between what's currently persisted and what a fresh re-extraction would
// produce, then commits on a separate confirm. The verbs say what differs (#1071):
// "Preview changes" calls the read-only preview action (no DB writes) — it never
// writes, so it can't be mistaken for the commit; "Save changes" calls
// applyReprocessPreview, which commits EXACTLY the previewed extraction (#946) — no
// second model call — unless the token has expired or the document changed, in
// which case it falls back to a fresh re-extraction and we surface that the result
// may differ from the preview. When the preview shows no changes the commit is
// disabled (nothing to save); the content-hash "skipped" short-circuit is a
// different case and keeps its "Re-extract anyway" override.
export default function ReprocessDiffPanel({
  id,
  filename,
  disabled,
  subtext,
}: {
  id: number;
  filename: string;
  disabled?: boolean;
  // Per-control explainer under "Preview changes" (#1340). Deterministic imports
  // say the re-run is free and exact; AI documents carry the daily-extraction cost
  // note. Selected upstream (lib/import-actions-copy.ts) so the copy can't drift
  // from what renders.
  subtext?: string;
}) {
  const router = useRouter();
  const [previewing, startPreview] = useTransition();
  const [committing, startCommit] = useTransition();
  const [result, setResult] = useState<PreviewReprocessResult | null>(null);
  // Set when the apply fell back to a fresh re-extraction instead of committing
  // the previewed input, so the user knows the result may differ from the diff.
  const [fallbackNote, setFallbackNote] = useState(false);

  function preview() {
    setResult(null);
    setFallbackNote(false);
    startPreview(async () => {
      const fd = new FormData();
      fd.set("id", String(id));
      setResult(await previewReprocess(fd));
    });
  }

  function commit() {
    // Carry the preview token (when we have one) so the apply commits exactly the
    // previewed input; without it the apply always re-extracts.
    const token = result?.status === "ok" ? result.previewToken : undefined;
    startCommit(async () => {
      const fd = new FormData();
      fd.set("id", String(id));
      if (token) fd.set("previewToken", token);
      const outcome = await applyReprocessPreview(fd);
      setResult(null);
      // Only note the divergence when we actually HAD a preview to commit but the
      // apply had to re-extract anyway (expired/stale/superseded token).
      setFallbackNote(!!token && outcome.mode === "re-extracted");
      router.refresh();
    });
  }

  function cancel() {
    setResult(null);
    setFallbackNote(false);
  }

  const busy = previewing || committing || !!disabled;

  return (
    <div>
      {result == null && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={preview}
            disabled={busy}
            data-testid="reprocess-preview"
            className="btn-ghost inline-flex items-center gap-1.5 text-sm disabled:opacity-50"
          >
            <IconRefresh className="h-4 w-4" />
            {previewing ? "Preparing preview…" : "Preview changes"}
          </button>
          {subtext && (
            <p
              data-testid="preview-subtext"
              className="text-xs text-slate-500 dark:text-slate-400"
            >
              {subtext}
            </p>
          )}
          {fallbackNote && (
            <p
              data-testid="reprocess-fallback-note"
              className="text-sm text-amber-700 dark:text-amber-400"
            >
              Re-extracted — the preview had expired or the document changed, so
              the results may differ from the preview you saw.
            </p>
          )}
        </div>
      )}

      {result?.status === "skipped" && (
        <div className="space-y-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {result.message}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={commit}
              disabled={busy}
              data-testid="reprocess-anyway"
              className="btn inline-flex items-center gap-1.5 text-sm disabled:opacity-50"
            >
              {committing ? "Re-extracting…" : "Re-extract anyway"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="btn-ghost text-sm disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result?.status === "ok" && (
        <div className="space-y-4">
          {result.diff.hasChanges ? (
            <div>
              <p className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">
                Re-extracting “{filename}” would:
              </p>
              <div className="flex flex-wrap gap-2 text-sm">
                <DiffCount
                  n={result.diff.totals.added}
                  label="added"
                  tone="emerald"
                />
                <DiffCount
                  n={result.diff.totals.removed}
                  label="removed"
                  tone="rose"
                />
                <DiffCount
                  n={result.diff.totals.changed}
                  label="changed"
                  tone="amber"
                />
                <DiffCount
                  n={result.diff.totals.unchanged}
                  label="unchanged"
                  tone="slate"
                />
              </div>
            </div>
          ) : (
            // No-change is the HEADLINE, not a footnote (#1071): one clear
            // statement with the unchanged count as detail, and the Save button
            // disabled below so it can't commit a pointless full row-replacement
            // of identical content.
            <div data-testid="reprocess-no-change">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                Re-extraction produced identical results — nothing to save.
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {result.diff.totals.unchanged} record
                {result.diff.totals.unchanged === 1 ? "" : "s"} unchanged.
              </p>
            </div>
          )}

          {result.diff.entities.map((e) => (
            <EntitySection key={e.entity} diff={e} />
          ))}

          {result.diff.hasChanges && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Saving re-runs extraction and replaces this document’s imported
              rows (any manual edits to them are discarded). A fresh AI
              re-extraction may differ slightly from this preview; deterministic
              health-record imports are exact. Records diff exactly, but body
              metrics, height/head-circumference and medications shown as
              “added” may instead be deferred or skipped on commit when another
              source already covers that date or an existing medication matches
              — so those additions are indicative.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={commit}
              disabled={
                busy || reprocessPreviewView(result.diff).commitDisabled
              }
              data-testid="reprocess-commit"
              className="btn inline-flex items-center gap-1.5 text-sm disabled:opacity-50"
            >
              <IconRefresh className="h-4 w-4" />
              {committing ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="btn-ghost text-sm disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const TONE: Record<string, string> = {
  emerald:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  rose: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  slate: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
};

function DiffCount({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone: string;
}) {
  return (
    <span
      className={`badge inline-flex items-center gap-1 ${TONE[tone]} ${
        n === 0 ? "opacity-50" : ""
      }`}
    >
      <span className="tabular-nums font-semibold">{n}</span> {label}
    </span>
  );
}

// One entity's itemized changes. Unchanged rows are summarized as a count only, so
// the list surfaces what actually moves.
function EntitySection({ diff }: { diff: EntityDiff }) {
  const { added, removed, changed } = diff;
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return null;
  }
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
          {diff.label}
        </span>
        <span className="badge bg-slate-100 tabular-nums text-slate-500 dark:bg-ink-800 dark:text-slate-400">
          +{added.length} −{removed.length} ~{changed.length}
        </span>
      </div>
      <ul className="space-y-0.5 text-sm">
        {added.map((r, i) => (
          <li
            key={`a-${r.key}-${i}`}
            className="flex items-baseline gap-2 text-emerald-700 dark:text-emerald-400"
          >
            <span className="font-mono text-xs">+</span>
            <span>{r.label}</span>
            {r.detail && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {r.detail}
              </span>
            )}
          </li>
        ))}
        {removed.map((r, i) => (
          <li
            key={`r-${r.key}-${i}`}
            className="flex items-baseline gap-2 text-rose-700 dark:text-rose-400"
          >
            <span className="font-mono text-xs">−</span>
            <span>{r.label}</span>
            {r.detail && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {r.detail}
              </span>
            )}
          </li>
        ))}
        {changed.map((c, i) => (
          <li
            key={`c-${c.after.key}-${i}`}
            className="flex flex-wrap items-baseline gap-2 text-amber-700 dark:text-amber-400"
          >
            <span className="font-mono text-xs">~</span>
            <span className="line-through opacity-70">{c.before.label}</span>
            <span aria-hidden>→</span>
            <span>{c.after.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
