"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconRestore } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import ModalShell from "@/components/ModalShell";
import { reopenEpisodeAction } from "@/app/(app)/medical/episodes/actions";

// Reopen-episode medication RESTORE (issue #1140 Part B) — the symmetric inverse of the
// end-with-meds checklist (EndEpisodeReconcile). When the episode's end stopped meds that
// are still restart-eligible, reopening opens a checklist ("These meds were stopped when
// this illness ended — restart them?"), pre-checked, and confirm reopens the illness AND
// restarts the selected courses in one writeTx. SUGGEST-ONLY (#560): unchecking all (or a
// no-eligible-meds episode) reopens and restarts nothing — the server also intersects the
// selection with the still-eligible persisted set. `profileId` is the cross-profile
// target (#858/#879). Shared so the episode page and any other reopen surface behave
// identically.
export interface ReopenRestoreMed {
  itemId: number;
  name: string;
}

export default function ReopenEpisodeReconcile({
  episodeId,
  profileId,
  meds,
  triggerClassName = "btn-ghost",
  triggerTestId = "episode-reopen-action",
}: {
  episodeId: number;
  profileId?: number;
  meds: ReopenRestoreMed[];
  triggerClassName?: string;
  triggerTestId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(meds.map((m) => m.itemId))
  );
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();

  function submit(medItemIds: number[]) {
    start(async () => {
      const fd = new FormData();
      fd.set("episodeId", String(episodeId));
      if (profileId != null) fd.set("profileId", String(profileId));
      if (medItemIds.length) fd.set("medItemIds", medItemIds.join(","));
      const res = await reopenEpisodeAction(fd);
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      const n = medItemIds.length;
      toast(
        n > 0
          ? `Episode reopened. Restarted ${n} medication${n === 1 ? "" : "s"}.`
          : "Episode reopened."
      );
      setOpen(false);
      router.refresh();
    });
  }

  async function onTrigger() {
    // No stopped meds to restore — the app's standard reopen confirmation (no empty
    // checklist), matching the end-with-meds no-meds path.
    if (meds.length === 0) {
      const ok = await confirm({
        title: "Reopen this episode?",
        message:
          "The illness will be active again, and new symptoms, temperatures, and doses will stay on this timeline.",
        confirmLabel: "Reopen episode",
      });
      if (!ok) return;
      submit([]);
      return;
    }
    setSelected(new Set(meds.map((m) => m.itemId)));
    setOpen(true);
  }

  function toggle(itemId: number, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }

  return (
    <>
      <button
        type="button"
        data-testid={triggerTestId}
        disabled={pending}
        onClick={() => void onTrigger()}
        className={triggerClassName}
      >
        <IconRestore className="h-4 w-4" stroke={1.75} />
        {pending ? "Reopening…" : "Reopen episode"}
      </button>

      {open && (
        <ModalShell
          title="Reopen this episode?"
          onClose={() => {
            if (!pending) setOpen(false);
          }}
          className="w-full max-w-lg rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900"
        >
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            These meds were stopped when this illness ended. Restart the ones
            you’re taking again.
          </p>
          <ul
            className="mt-4 flex flex-col gap-2"
            data-testid="episode-reopen-med-list"
          >
            {meds.map((m) => (
              <li key={m.itemId}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    data-testid={`episode-reopen-med-${m.itemId}`}
                    checked={selected.has(m.itemId)}
                    onChange={(e) => toggle(m.itemId, e.target.checked)}
                  />
                  <span className="min-w-0 font-medium text-slate-800 dark:text-slate-100">
                    {m.name}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Selected meds move back to Current. Leave one unchecked to keep it
            in Past.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="episode-reopen-confirm"
              disabled={pending}
              onClick={() => submit([...selected])}
              className="btn disabled:opacity-50"
            >
              {pending ? "Reopening…" : "Reopen episode"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setOpen(false)}
              className="btn-ghost"
            >
              Cancel
            </button>
          </div>
        </ModalShell>
      )}
    </>
  );
}
