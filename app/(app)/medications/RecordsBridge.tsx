"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconPlus, IconX, IconArrowBackUp } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { BridgeSuggestion } from "./med-data";
import {
  trackMedicationFromRecord,
  dismissMedicationRecord,
  restoreMedicationRecord,
} from "./actions";

// "From your records" bridge (#560/#817): imported prescription records with no
// matched tracked med, offered as suggest-only "Track this" (never auto-created).
// Each suggestion is dismissible per record with name-keyed hygiene (#203) — the
// dismiss rides the findings bus keyed by the drug name, so a reprocess that mints a
// new record id doesn't resurface a waved-off suggestion. Renders nothing when there
// are no suggestions (no standing empty section).
export default function RecordsBridge({
  suggestions,
  dismissed = [],
}: {
  suggestions: BridgeSuggestion[];
  // Suggestions the user dismissed (#852 item 6): shown in a collapsed "dismissed (N)"
  // disclosure with a Restore per row, so a mis-tap is recoverable.
  dismissed?: BridgeSuggestion[];
}) {
  const formatPrefs = useFormatPrefs();
  const [busyId, setBusyId] = useState<number | null>(null);
  const router = useRouter();
  const toast = useToast();

  if (suggestions.length === 0 && dismissed.length === 0) return null;

  async function track(s: BridgeSuggestion) {
    if (busyId != null) return;
    setBusyId(s.recordId);
    const fd = new FormData();
    fd.set("record_id", String(s.recordId));
    try {
      const res = await trackMedicationFromRecord(fd);
      if (res.ok) {
        toast(`Now tracking ${s.name}.`);
        router.refresh();
      } else {
        toast(res.error, { tone: "error" });
      }
    } catch {
      toast("Couldn't track that medication. Try again.", {
        tone: "error",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(s: BridgeSuggestion) {
    if (busyId != null) return;
    setBusyId(s.recordId);
    const fd = new FormData();
    fd.set("dedupe_key", s.dedupeKey);
    try {
      await dismissMedicationRecord(fd);
      router.refresh();
    } catch {
      toast("Couldn't dismiss that suggestion. Try again.", {
        tone: "error",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function restore(s: BridgeSuggestion) {
    if (busyId != null) return;
    setBusyId(s.recordId);
    const fd = new FormData();
    fd.set("dedupe_key", s.dedupeKey);
    try {
      const res = await restoreMedicationRecord(fd);
      if (res.ok) {
        toast(`Restored ${s.name}.`);
        router.refresh();
      } else {
        toast(res.error, { tone: "error" });
      }
    } catch {
      toast("Couldn't restore that suggestion. Try again.", {
        tone: "error",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section data-testid="records-bridge">
      {suggestions.length > 0 && (
        <>
          <h2 className="mb-2 section-label">From your records</h2>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            Imported prescriptions that aren’t on your medication list yet.
            Track one to get dose check-offs, interactions, and refill tracking.
          </p>
          <div className="space-y-2">
            {suggestions.map((s) => (
              <div
                key={s.recordId}
                data-testid="records-bridge-item"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-black/15 px-3 py-2 dark:border-white/15"
              >
                <div className="min-w-0">
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {s.name}
                  </span>
                  {s.detail && (
                    <span className="ml-2 text-sm text-slate-500 dark:text-slate-400">
                      {s.detail}
                    </span>
                  )}
                  <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                    {formatLongDate(s.date, formatPrefs)}
                  </span>
                  {s.strengthOffer && (
                    <span
                      className="ml-2 text-xs text-slate-500 dark:text-slate-400"
                      data-testid="records-bridge-strength-note"
                    >
                      Already tracked at a different strength
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => track(s)}
                    disabled={busyId != null}
                    className="btn btn-sm"
                    data-testid="records-bridge-track"
                  >
                    <IconPlus className="h-3.5 w-3.5" stroke={2.5} />
                    <span>
                      {s.strengthOffer
                        ? `Track as separate ${s.strengthOffer} item`
                        : "Track this"}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => dismiss(s)}
                    disabled={busyId != null}
                    aria-label={`Dismiss ${s.name}`}
                    title="Dismiss"
                    data-testid="records-bridge-dismiss"
                    className="tap-target flex h-8 w-8 items-center justify-center rounded text-slate-500 hover:text-rose-500 dark:text-slate-400 dark:hover:text-rose-400"
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
        <details className="mt-2" data-testid="records-bridge-dismissed">
          <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:underline dark:text-slate-400">
            Dismissed ({dismissed.length})
          </summary>
          <div className="mt-2 space-y-2">
            {dismissed.map((s) => (
              <div
                key={s.recordId}
                data-testid="records-bridge-dismissed-item"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-black/10 px-3 py-2 opacity-70 dark:border-white/10"
              >
                <div className="min-w-0">
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {s.name}
                  </span>
                  {s.detail && (
                    <span className="ml-2 text-sm text-slate-500 dark:text-slate-400">
                      {s.detail}
                    </span>
                  )}
                  <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                    {formatLongDate(s.date, formatPrefs)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => restore(s)}
                  disabled={busyId != null}
                  data-testid="records-bridge-restore"
                  className="btn btn-sm"
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
