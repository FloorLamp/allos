"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconArrowsExchange } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { reassignDocument } from "@/app/(app)/medical/actions";

// "Move to profile…" control (issue #208, Phase 3). Shown only when the acting
// login can reach ≥2 profiles. Picks a destination among the login's OTHER
// accessible profiles, confirms, then moves the document + everything it imported
// + its file to that profile via the reassignDocument server action.
export default function ReassignDocument({
  id,
  filename,
  destinations,
}: {
  id: number;
  filename: string;
  // The login's accessible profiles OTHER than the document's current one.
  destinations: { id: number; name: string }[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [dest, setDest] = useState<number>(destinations[0]?.id ?? 0);
  const [error, setError] = useState<string | null>(null);

  if (destinations.length === 0) return null;

  async function onMove() {
    const target = destinations.find((d) => d.id === dest);
    if (!target) return;
    const ok = await confirm({
      title: "Move document",
      message: `Move “${filename}” and everything it imported to ${target.name}? This re-files the document and its records under that profile.`,
      confirmLabel: "Move",
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
          className="rounded-lg border border-black/10 bg-white px-2 py-1.5 text-sm text-slate-800 disabled:opacity-50 dark:border-white/10 dark:bg-ink-850 dark:text-slate-100"
        >
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
