"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconArrowsExchange } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { reassignDocument } from "@/app/(app)/medical/document-actions";

// "Move to profile…" control. Shown only when the acting
// login can reach ≥2 profiles. Picks a destination among the login's OTHER
// accessible profiles, confirms, then moves the document + everything it imported
// + its file to that profile via the reassignDocument server action.
export default function ReassignDocument({
  id,
  filename,
  destinations,
  recordCount,
}: {
  id: number;
  filename: string;
  // The login's accessible profiles OTHER than the document's current one.
  destinations: { id: number; name: string }[];
  // How many records this document produced — named in the confirm so the scope of
  // a cross-profile move is explicit (#1340).
  recordCount: number;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  // Start with NO target selected (#1340): a pre-selected profile put an accidental
  // cross-profile move of every imported row one click away. 0 = the "Choose
  // profile…" placeholder; Move stays disabled until a real profile is chosen.
  const [dest, setDest] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  if (destinations.length === 0) return null;

  async function onMove() {
    const target = destinations.find((d) => d.id === dest);
    if (!target) return;
    const records = `${recordCount} record${recordCount === 1 ? "" : "s"}`;
    const ok = await confirm({
      title: "Move document",
      message: `Move “${filename}” and its ${records} to ${target.name}? This re-files the document and its records under that profile.`,
      confirmLabel: `Move to ${target.name}`,
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set("id", String(id));
      fd.set("destProfileId", String(dest));
      const res = await reassignDocument(fd);
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      // The document now lives under another profile — the active-profile-scoped
      // detail page can no longer resolve it, so return to the import log.
      router.push("/data?section=import");
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor="reassign-dest"
          className="text-sm text-slate-500 dark:text-slate-400"
        >
          Move to
        </label>
        <select
          id="reassign-dest"
          value={dest}
          onChange={(e) => setDest(Number(e.target.value))}
          disabled={pending}
          data-testid="reassign-dest"
          className="rounded-lg border border-black/10 bg-white px-2 py-1.5 text-sm text-slate-800 disabled:opacity-50 dark:border-white/10 dark:bg-ink-850 dark:text-slate-100"
        >
          <option value={0}>Choose profile…</option>
          {destinations.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onMove}
          disabled={pending || !dest}
          className="btn-ghost inline-flex items-center gap-1.5 text-sm disabled:opacity-50"
        >
          <IconArrowsExchange className="h-4 w-4" />
          {pending ? "Moving…" : "Move"}
        </button>
      </div>
      {error && (
        <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
      )}
    </div>
  );
}
