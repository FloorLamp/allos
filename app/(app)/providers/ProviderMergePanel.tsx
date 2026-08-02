"use client";

import { useState } from "react";
import { IconChevronDown, IconGitMerge } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { mergeProviderAction } from "./actions";

interface Candidate {
  id: number;
  name: string;
  // Composite disambiguation label (#532): the bare name when unique, else name +
  // the first differing field, so two same-named rows are never picked/deleted
  // blind. Precomputed on the server via providerDisambigLabel.
  label: string;
  type: string;
  // Count-only impact summary ("14 records · 3 visits across 2 profiles"), or null
  // when the candidate has no linked records. Precomputed on the server — GLOBAL
  // counts, never any cross-profile record detail.
  impact: string | null;
}

// Admin-only merge control (issue #275). The current provider is the SURVIVOR; the
// admin picks a duplicate to absorb into it. The confirm dialog shows COUNTS ONLY
// (no cross-profile record listing). On success the duplicate is deleted and the
// action redirects to the survivor, so this component just triggers navigation.
export default function ProviderMergePanel({
  survivor,
  candidates,
}: {
  survivor: { id: number; name: string; label: string };
  candidates: Candidate[];
}) {
  const [duplicateId, setDuplicateId] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();

  if (candidates.length === 0) return null;

  const chosen = candidates.find((c) => c.id === duplicateId) ?? null;

  async function handleMerge() {
    if (!chosen) return;
    setError(null);
    const detail = chosen.impact
      ? `This moves ${chosen.impact} onto ${survivor.label}, then deletes “${chosen.label}”. This can’t be undone.`
      : `“${chosen.label}” has no linked records. It will be deleted and merged into ${survivor.label}. This can’t be undone.`;
    const ok = await confirm({
      title: `Merge into ${survivor.label}?`,
      message: detail,
      confirmLabel: "Merge",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("survivorId", String(survivor.id));
    fd.set("duplicateId", String(chosen.id));
    const res = await mergeProviderAction(fd);
    // A successful merge redirect()s server-side, so we only reach here on error.
    setBusy(false);
    if (res?.error) {
      setError(res.error);
      return;
    }
    toast("Providers merged");
  }

  return (
    <details
      className="group mt-8 border-t border-black/5 pt-4 dark:border-white/5"
      data-testid="provider-merge"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-600 outline-none transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-500/40 [&::-webkit-details-marker]:hidden dark:text-slate-300 dark:hover:bg-ink-800">
        <IconGitMerge className="h-4 w-4 shrink-0" stroke={1.75} />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Merge a duplicate</span>
          <span className="block text-xs font-normal text-slate-400">
            Admin tool
          </span>
        </span>
        <IconChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-3 px-3">
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          Pick a duplicate of {survivor.name} to absorb. Every linked record,
          visit, medication and appointment moves onto {survivor.name}, then the
          duplicate is deleted.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input max-w-xs"
            value={duplicateId}
            onChange={(e) =>
              setDuplicateId(e.target.value ? Number(e.target.value) : "")
            }
            data-testid="provider-merge-select"
          >
            <option value="">Select a duplicate…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {c.impact ? ` (${c.impact})` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-danger"
            disabled={!chosen || busy}
            onClick={handleMerge}
            data-testid="provider-merge-button"
          >
            {busy ? "Merging…" : "Merge"}
          </button>
        </div>
        {error ? (
          <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
