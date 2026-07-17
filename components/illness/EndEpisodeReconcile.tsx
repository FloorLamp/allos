"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import ModalShell from "@/components/ModalShell";
import type { EpisodeMedSuggestion } from "@/lib/episode-med-reconcile";
import { endEpisodeWithMedsAction } from "@/app/(app)/medical/episodes/actions";

// End-episode medication reconciliation (issue #880). The shared trigger for EVERY
// end-episode surface — the episode page's "Feeling better", the hero cockpit, and the
// stale-nudge's backdated end — so the checklist logic lives in ONE place. When the
// episode has associated meds, ending opens a checklist: OTC/PRN meds used during the
// illness are pre-checked ("Also stop?"), an Rx course started mid-illness is listed
// UNCHECKED ("Course finished?"). Confirm ends the episode AND closes the selected
// courses in one writeTx. When there are NO associated meds, the trigger ends directly
// (no empty step). SUGGEST-ONLY (#560): skipping nags nothing; the app never silently
// stops therapy — the server also intersects the selection with the derived set.
//
// `lastActiveDay` routes the backdated stale-nudge end (#859); absent → the feeling-better
// end. `profileId` is the cross-profile target (#858/#879) — set on a household member's
// cockpit/page so the action gates on THAT profile.
export default function EndEpisodeReconcile({
  episodeId,
  profileId,
  meds,
  lastActiveDay = null,
  triggerLabel,
  pendingLabel = "Ending…",
  triggerClassName,
  triggerTestId,
  icon,
  successMessage = "Marked feeling better.",
}: {
  episodeId: number;
  profileId?: number;
  meds: EpisodeMedSuggestion[];
  lastActiveDay?: string | null;
  triggerLabel: string;
  pendingLabel?: string;
  triggerClassName: string;
  triggerTestId: string;
  icon?: React.ReactNode;
  successMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(meds.filter((m) => m.defaultChecked).map((m) => m.itemId))
  );
  const router = useRouter();
  const toast = useToast();

  function submit(medItemIds: number[]) {
    start(async () => {
      const fd = new FormData();
      fd.set("episodeId", String(episodeId));
      if (profileId != null) fd.set("profileId", String(profileId));
      if (lastActiveDay) fd.set("lastActiveDay", lastActiveDay);
      if (medItemIds.length) fd.set("medItemIds", medItemIds.join(","));
      const res = await endEpisodeWithMedsAction(fd);
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      const n = medItemIds.length;
      toast(
        n > 0
          ? `${successMessage} Closed ${n} medication${n === 1 ? "" : "s"}.`
          : successMessage
      );
      setOpen(false);
      router.refresh();
    });
  }

  function onTrigger() {
    // Nothing to reconcile — end directly (no empty checklist step).
    if (meds.length === 0) {
      submit([]);
      return;
    }
    // Re-seed the default selection each open (a prior cancel may have edited it).
    setSelected(
      new Set(meds.filter((m) => m.defaultChecked).map((m) => m.itemId))
    );
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
        onClick={onTrigger}
        className={triggerClassName}
      >
        {icon}
        {pending ? pendingLabel : triggerLabel}
      </button>

      {open && (
        <ModalShell
          title="Ending this illness — also close these meds?"
          onClose={() => {
            if (!pending) setOpen(false);
          }}
          className="w-full max-w-lg rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900"
        >
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Meds you started or used during this illness. Closing one moves it
            to Past — you can restart it any time. Nothing is closed unless you
            confirm.
          </p>
          <ul
            className="mt-4 flex flex-col gap-2"
            data-testid="episode-med-reconcile-list"
          >
            {meds.map((m) => (
              <li key={m.itemId}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    data-testid={`episode-med-reconcile-${m.itemId}`}
                    checked={selected.has(m.itemId)}
                    onChange={(e) => toggle(m.itemId, e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      {m.name}
                    </span>
                    <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                      {m.klass === "otc-prn"
                        ? "Also stop?"
                        : "Course finished?"}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="episode-med-reconcile-confirm"
              disabled={pending}
              onClick={() => submit([...selected])}
              className="btn disabled:opacity-50"
            >
              {pending ? "Ending…" : "End illness"}
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
