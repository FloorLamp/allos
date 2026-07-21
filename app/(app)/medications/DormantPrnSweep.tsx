"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconArchive, IconX, IconArrowBackUp } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { DormantPrnSuggestion } from "@/lib/dormant-prn";
import {
  stopMedication,
  dismissDormantPrn,
  restoreDormantPrn,
} from "./actions";

// Dormant-PRN sweep card (issue #880 item 3), the RecordsBridge pattern applied to the
// existing backlog: active PRN meds with no dose in 90+ days — the 2am ibuprofen still
// "Current" months later. Suggest-only (#560): "Move to past" closes the course (a plain
// stop with reason 'completed_course'; restartable any time), and each row is dismissible
// per med with a #203 id-keyed dedupe so a waved-off suggestion stays quiet. Renders
// nothing when there's nothing dormant. Mirrors the bridge's recoverable "dismissed (N)"
// disclosure.
export default function DormantPrnSweep({
  suggestions,
  dismissed = [],
}: {
  suggestions: DormantPrnSuggestion[];
  dismissed?: DormantPrnSuggestion[];
}) {
  const formatPrefs = useFormatPrefs();
  const [busyId, setBusyId] = useState<number | null>(null);
  const router = useRouter();
  const toast = useToast();

  if (suggestions.length === 0 && dismissed.length === 0) return null;

  async function moveToPast(s: DormantPrnSuggestion) {
    if (busyId != null) return;
    setBusyId(s.itemId);
    const fd = new FormData();
    fd.set("id", String(s.itemId));
    fd.set("stop_reason", "completed_course");
    try {
      const res = await stopMedication(fd);
      if (res.ok) {
        toast(`Moved ${s.name} to Past.`);
        router.refresh();
      } else {
        toast(res.error, { tone: "error" });
      }
    } catch {
      toast("Couldn't move that medication. Try again.", {
        tone: "error",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(s: DormantPrnSuggestion) {
    if (busyId != null) return;
    setBusyId(s.itemId);
    const fd = new FormData();
    fd.set("dedupe_key", s.dedupeKey);
    try {
      await dismissDormantPrn(fd);
      router.refresh();
    } catch {
      toast("Couldn't dismiss that suggestion. Try again.", {
        tone: "error",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function restore(s: DormantPrnSuggestion) {
    if (busyId != null) return;
    setBusyId(s.itemId);
    const fd = new FormData();
    fd.set("dedupe_key", s.dedupeKey);
    try {
      const res = await restoreDormantPrn(fd);
      if (res.ok) router.refresh();
      else toast(res.error, { tone: "error" });
    } catch {
      toast("Couldn't restore that suggestion. Try again.", {
        tone: "error",
      });
    } finally {
      setBusyId(null);
    }
  }

  const dormantLine = (s: DormantPrnSuggestion) =>
    s.lastUsed
      ? `No doses since ${formatLongDate(s.lastUsed, formatPrefs)} (${s.daysSince} days)`
      : `No doses in ${s.daysSince} days`;

  return (
    <section data-testid="dormant-prn-sweep">
      {suggestions.length > 0 && (
        <>
          <h3 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
            May be out of date
          </h3>
          <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
            No doses have been logged for these as-needed medications in 90+
            days. Move unused items to Past to keep safety checks accurate.
          </p>
          <div className="space-y-2">
            {suggestions.map((s) => (
              <div
                key={s.itemId}
                data-testid="dormant-prn-item"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-black/15 px-3 py-2 dark:border-white/15"
              >
                <div className="min-w-0">
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {s.name}
                  </span>
                  <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                    {dormantLine(s)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => moveToPast(s)}
                    disabled={busyId != null}
                    className="btn-ghost btn-sm"
                    data-testid="dormant-prn-move"
                  >
                    <IconArchive className="h-3.5 w-3.5" stroke={2} />
                    <span>Move to past</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => dismiss(s)}
                    disabled={busyId != null}
                    aria-label={`Dismiss ${s.name}`}
                    title="Dismiss"
                    data-testid="dormant-prn-dismiss"
                    className="tap-target flex h-8 w-8 items-center justify-center rounded text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-ink-750 dark:hover:text-slate-200"
                  >
                    <IconX className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {dismissed.length > 0 && (
        <details className="mt-2" data-testid="dormant-prn-dismissed">
          <summary className="cursor-pointer section-label hover:underline">
            Dismissed ({dismissed.length})
          </summary>
          <div className="mt-2 space-y-2">
            {dismissed.map((s) => (
              <div
                key={s.itemId}
                data-testid="dormant-prn-dismissed-item"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-black/10 px-3 py-2 opacity-70 dark:border-white/10"
              >
                <div className="min-w-0">
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {s.name}
                  </span>
                  <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                    {dormantLine(s)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => restore(s)}
                  disabled={busyId != null}
                  data-testid="dormant-prn-restore"
                  className="btn-ghost btn-sm"
                >
                  <IconArrowBackUp className="h-3.5 w-3.5" stroke={2} />
                  <span>Restore</span>
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
