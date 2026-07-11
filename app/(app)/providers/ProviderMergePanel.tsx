"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconGitMerge } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { mergeProviderAction } from "./actions";

interface Candidate {
  id: number;
  name: string;
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
  survivor: { id: number; name: string };
  candidates: Candidate[];
}) {
  const [duplicateId, setDuplicateId] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();
  const router = useRouter();

  if (candidates.length === 0) return null;

  const chosen = candidates.find((c) => c.id === duplicateId) ?? null;

  async function handleMerge() {
    if (!chosen) return;
    setError(null);
    const detail = chosen.impact
      ? `This moves ${chosen.impact} onto ${survivor.name}, then deletes “${chosen.name}”. This can’t be undone.`
      : `“${chosen.name}” has no linked records. It will be deleted and merged into ${survivor.name}. This can’t be undone.`;
    const ok = await confirm({
      title: `Merge into ${survivor.name}?`,
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
    router.refresh();
  }

  return (
    <div className="mt-6 card" data-testid="provider-merge">
      <h2 className="mb-1 flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-100">
        <IconGitMerge className="h-4 w-4" stroke={1.75} />
        Merge a duplicate
      </h2>
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
              {c.name}
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
        <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>
      ) : null}
    </div>
  );
}
