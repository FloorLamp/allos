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

// Reprocess-with-diff. Instead of silently re-extracting and
// replacing a document's rows, this previews the diff between what's currently
// persisted and what a fresh re-extraction would produce, then commits on a
// separate confirm. "Reprocess…" calls the read-only preview action (no DB
// writes); "Confirm reprocess" calls applyReprocessPreview, which commits EXACTLY
// the previewed extraction (#946) — no second model call — unless the token has
// expired or the document changed, in which case it falls back to a fresh
// re-extraction and we surface that the result may differ from the preview.
export default function ReprocessDiffPanel({
  id,
  filename,
  disabled,
}: {
  id: number;
  filename: string;
  disabled?: boolean;
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
            className="btn-ghost inline-flex items-center gap-1.5 text-sm disabled:opacity-50"
          >
            <IconRefresh className="h-4 w-4" />
            {previewing ? "Preparing preview…" : "Reprocess…"}
          </button>
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
              className="btn inline-flex items-center gap-1.5 text-sm disabled:opacity-50"
            >
              {committing ? "Reprocessing…" : "Reprocess anyway"}
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
          <div>
            <p className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">
              Reprocessing “{filename}” would:
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
            {!result.diff.hasChanges && (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                A fresh re-extraction produces no changes.
              </p>
            )}
          </div>

          {result.diff.entities.map((e) => (
            <EntitySection key={e.entity} diff={e} />
          ))}

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Confirming re-runs extraction and replaces this document’s imported
            rows (any manual edits to them are discarded). A fresh AI
            re-extraction may differ slightly from this preview; deterministic
            health-record imports are exact. Records diff exactly, but body
            metrics, height/head-circumference and medications shown as “added”
            may instead be deferred or skipped on commit when another source
            already covers that date or an existing medication matches — so
            those additions are indicative.
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={commit}
              disabled={busy}
              className="btn inline-flex items-center gap-1.5 text-sm disabled:opacity-50"
            >
              <IconRefresh className="h-4 w-4" />
              {committing ? "Reprocessing…" : "Confirm reprocess"}
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
