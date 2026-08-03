"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { diffCompletions, shouldResetSeed } from "@/lib/toaster-diff";
import { useToast, useDismissToast } from "@/components/Toast";
import { useChromeRefresh } from "@/components/DirtyFormRegistry";
import {
  EXTRACTION_STATES_ENDPOINT,
  isExtractionState,
  observeStates,
} from "@/lib/toaster-poll";
import { MEDICAL_UPLOAD_TOAST_KEY } from "@/lib/upload-gate";

// The document statuses `getExtractionStates` reports as terminal (no longer
// processing). `done` toasts as a success; `failed`/`skipped` as an error.
const isExtractionTerminal = (status: string) =>
  status === "done" || status === "failed" || status === "skipped";

// App-wide HEADLESS watcher for background medical-document extraction (#1315).
// Polls the extraction status (faster while something is processing), and when a
// document transitions out of `processing` it (a) asks the chrome to repaint the
// current route so the /medical table updates, and (b) raises a toast — now through the shared
// ToastProvider (useToast), not a bespoke second renderer. Lives in the root layout
// so the toast still fires if the user navigated away from /medical.
//
// One toast system (#1315): the merge kills the two-renderers disease. The upload
// confirmation and the extraction-complete toast now share ONE lifecycle slot — the
// upload posts under MEDICAL_UPLOAD_TOAST_KEY, and the FIRST terminal event here
// dismisses that key and posts its own per-document toast, so the slot upgrades in
// place ("Uploaded — reading…" → "12 records ✓") instead of stacking. Subsequent
// docs each get their own key (doc-<id>) as before.
//
// OBSERVATION AND REPAINT ARE SEPARATE (#1878). The poll reads a ROUTE HANDLER,
// not a Server Action: an action's response carries a freshly rendered page tree
// that Next applies, which repainted the page under a half-typed record form
// outside everything the dirty-form registry gates. Over `fetch` nothing can
// repaint, so this loop keeps observing at full cadence — the toast below still
// fires the instant the extraction finishes — and the only repaint is the
// `chromeRefresh()` at the bottom, which defers while a form is dirty and drains
// on release. See lib/toaster-poll.ts.
//
// `profileId` is the session's active profile — the profile /api/jobs/extractions
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
  const toast = useToast();
  const dismissKey = useDismissToast();
  // CHROME-INITIATED (#1878): same shape as ImportJobsToaster — a poll saw a
  // background extraction finish. `router` stays for the toast's "View document"
  // push, which the user asks for by tapping it.
  const chromeRefresh = useChromeRefresh();
  const prev = useRef<Map<number, string> | null>(null);
  // The profile the current seed was built for; drives shouldResetSeed below.
  const seededFor = useRef<number | null>(null);

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
      const observed = await observeStates(
        EXTRACTION_STATES_ENDPOINT,
        isExtractionState
      );
      if (!active) return;
      if (!observed.ok) {
        // A refusal is NOT an empty result: do NOT touch prev.current. Replacing
        // it with an empty map would make the next successful poll treat every
        // document as new (before === undefined) and re-toast finished ones. Retry
        // soon instead. Over `fetch` this covers the offline case, a 401 after the
        // session lapsed, and a 200 whose body is not the envelope.
        timer = setTimeout(poll, 2000);
        return;
      }
      const docs = observed.states;

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
      if (!seeded && finished.length) {
        // The first real result retires the upload confirmation slot — the upload
        // toast's job ("it's in flight, track in Review") is done. dismissKey is a
        // no-op once cleared, so calling it per batch of finished docs is safe.
        dismissKey(MEDICAL_UPLOAD_TOAST_KEY);
        for (const d of finished) {
          const action = {
            label: "View document",
            onClick: () => router.push(`/import/${d.id}`),
          };
          if (d.status === "done") {
            toast(
              `${d.filename}: imported ${d.count} record${d.count === 1 ? "" : "s"}.`,
              { key: `doc-${d.id}`, duration: null, action }
            );
          } else {
            toast(
              d.error
                ? `Couldn’t extract results from ${d.filename}: ${d.error}`
                : `Couldn’t extract results from ${d.filename}.`,
              { key: `doc-${d.id}`, tone: "error", duration: null, action }
            );
          }
        }
      }
      // Survives the #1473 sweep: poll-driven, same as ImportJobsToaster — and
      // since #1878 it is the ONLY thing here that can repaint, because the
      // observation above went over a route handler. Deferred while a record form
      // holds unsaved input; drained, coalesced, on release.
      if (!seeded && changed) chromeRefresh();

      const processing = docs.some((d) => d.status === "processing");
      timer = setTimeout(poll, processing ? 2000 : 6000);
    };

    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [router, toast, dismissKey, chromeRefresh, profileId]);

  // Headless: it renders through the shared ToastProvider, not its own overlay.
  return null;
}
