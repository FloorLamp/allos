"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getExtractionStates } from "@/app/(app)/medical/actions";
import { diffCompletions, shouldResetSeed } from "@/lib/toaster-diff";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCircleCheck,
  IconX,
} from "@tabler/icons-react";

interface Toast {
  key: number;
  tone: "success" | "error";
  docId: number;
  filename: string;
  count: number;
  error?: string | null;
}

let toastSeq = 0;

// The document statuses `getExtractionStates` reports as terminal (no longer
// processing). `done` toasts as a success; `failed`/`skipped` as an error.
const isExtractionTerminal = (status: string) =>
  status === "done" || status === "failed" || status === "skipped";

// App-wide watcher for background medical-document extraction. Polls the
// extraction status (faster while something is processing), and when a document
// transitions out of `processing` it (a) refreshes the current route so the
// /medical table updates, and (b) shows a toast. Lives in the root layout so the
// toast still fires if the user has navigated away from /medical.
//
// `profileId` is the session's active profile — the profile `getExtractionStates`
// is scoped to. It's a dep of the poll effect and resets the seed on a switch
// (#296): the polled set is per-profile but this client component survives a
// profile switch (router.refresh() re-renders server components, not the layout's
// client tree), so without the reset the new profile's entire terminal document
// history reads as `before === undefined` and ghost-toasts as freshly finished.
export default function ExtractionToaster({
  profileId,
}: {
  profileId: number;
}) {
  const router = useRouter();
  const prev = useRef<Map<number, string> | null>(null);
  // The profile the current seed was built for; drives shouldResetSeed below.
  const seededFor = useRef<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((key: number) => {
    setToasts((list) => list.filter((t) => t.key !== key));
  }, []);

  useEffect(() => {
    // A profile switch re-runs this effect (profileId is a dep). Discard the
    // previous profile's seed so the new profile's first poll re-seeds silently
    // instead of announcing its whole terminal document history as freshly
    // finished (#296). A fresh mount (seededFor null) is not a reset — prev is
    // already null and the first poll seeds it.
    if (shouldResetSeed(seededFor.current, profileId)) {
      prev.current = null;
    }
    seededFor.current = profileId;

    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      // Skip polling while the tab is hidden (no background timers churning), but
      // only AFTER the first poll has seeded prev.current. Gating on the seed means
      // a document that finishes while the tab is hidden is still caught — as a
      // `before === undefined` terminal on the next visible poll — instead of being
      // silently absorbed into the seed and never toasted.
      if (
        prev.current !== null &&
        typeof document !== "undefined" &&
        document.hidden
      ) {
        timer = setTimeout(poll, 6000);
        return;
      }
      let docs: Awaited<ReturnType<typeof getExtractionStates>>;
      try {
        docs = await getExtractionStates();
      } catch {
        // Transient failure: do NOT touch prev.current. Replacing it with an empty
        // map would make the next successful poll treat every document as new
        // (before === undefined) and re-toast finished ones. Retry soon instead.
        if (active) timer = setTimeout(poll, 2000);
        return;
      }
      if (!active) return;

      // Diff against the seed. The `before === undefined` terminal case (a small
      // sync CCD/XDM/SHC/FHIR import that lands terminal within one poll, or a
      // rejected/duplicate upload inserted straight into a terminal state) and the
      // silent first-poll seed both live in diffCompletions — see its comment.
      const { finished, changed, next, seeded } = diffCompletions(
        prev.current,
        docs,
        isExtractionTerminal
      );
      prev.current = next;
      if (!seeded) {
        const fresh: Toast[] = finished.map((d) =>
          d.status === "done"
            ? {
                key: ++toastSeq,
                tone: "success",
                docId: d.id,
                filename: d.filename,
                count: d.count,
              }
            : {
                key: ++toastSeq,
                tone: "error",
                docId: d.id,
                filename: d.filename,
                count: 0,
                error: d.error,
              }
        );
        if (fresh.length) setToasts((list) => [...list, ...fresh]);
        if (changed) router.refresh();
      }

      const processing = docs.some((d) => d.status === "processing");
      timer = setTimeout(poll, processing ? 2000 : 6000);
    };

    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [router, profileId]);

  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.key} toast={t} onDismiss={() => dismiss(t.key)} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  const success = toast.tone === "success";

  // No auto-dismiss: extraction results are easy to miss, so the toast stays up
  // until the user dismisses it via the close button or the "View document"
  // link (both call onDismiss).
  return (
    <div
      role="status"
      className={`w-80 rounded-xl border bg-white p-4 shadow-lg dark:bg-ink-900 ${
        success
          ? "border-emerald-200 dark:border-emerald-800"
          : "border-rose-200 dark:border-rose-800"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="leading-none">
          {success ? (
            <IconCircleCheck className="h-5 w-5 text-emerald-500" />
          ) : (
            <IconAlertTriangle className="h-5 w-5 text-amber-500" />
          )}
        </span>
        <div className="flex-1">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {success ? "Extraction complete" : "Extraction unsuccessful"}
          </div>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            {success ? (
              <>
                Imported{" "}
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {toast.count}
                </span>{" "}
                record{toast.count === 1 ? "" : "s"} from {toast.filename}.
              </>
            ) : (
              <>
                Couldn’t extract results from {toast.filename}.
                {toast.error ? (
                  <span className="mt-1 block text-slate-600 dark:text-slate-300">
                    {toast.error}
                  </span>
                ) : null}
              </>
            )}
          </p>
          <Link
            href={`/import/${toast.docId}`}
            onClick={onDismiss}
            className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            View document <IconArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400"
        >
          <IconX className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
