"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { useChromeRefresh } from "@/components/DirtyFormRegistry";
import { diffCompletions, shouldResetSeed } from "@/lib/toaster-diff";
import {
  IMPORT_JOB_STATES_ENDPOINT,
  isImportJobState,
  observeStates,
} from "@/lib/toaster-poll";

// The import-job statuses that count as terminal (extraction no longer running).
const isImportTerminal = (status: string) =>
  status === "ready" || status === "failed" || status === "skipped";

// App-wide watcher for async paste/CSV import jobs. Polls their status (fast
// while something is extracting, slow otherwise) and, when a job transitions out
// of `processing`, (a) asks the chrome for a repaint so the /import list updates
// and (b) shows a sticky toast — success with a "Review" link to /import, or the
// error text. Lives in the root layout so the toast still fires if the user
// navigated away from /import while the extraction ran. Uses the shared useToast
// (unlike the
// bespoke ExtractionToaster for medical documents).
//
// OBSERVATION AND REPAINT ARE SEPARATE (#1878). The poll reads a ROUTE HANDLER,
// not a Server Action: an action's response carries a freshly rendered page tree
// that Next applies, which repainted the page under a half-typed record form
// outside everything the dirty-form registry gates. Over `fetch` nothing can
// repaint, so this loop keeps observing at full cadence — the toast below still
// fires the instant the job finishes — and the only repaint is the
// `chromeRefresh()` at the bottom, which defers while a form is dirty and drains
// on release. See lib/toaster-poll.ts.
//
// `profileId` is the session's active profile — the profile /api/jobs/imports is
// scoped to. Like ExtractionToaster it's a dep of the poll effect and resets
// the seed on a switch (#296) so the new profile's pre-existing terminal jobs
// aren't announced as freshly finished.
export default function ImportJobsToaster({
  profileId,
}: {
  profileId: number;
}) {
  const router = useRouter();
  const toast = useToast();
  // CHROME-INITIATED (#1878): a poll noticed a background job finish. The user
  // did nothing; deferring it while a record form is dirty costs nothing and
  // saves the half-typed row. `router` stays for the toast's Review push, which
  // is a navigation the user asked for.
  const chromeRefresh = useChromeRefresh();
  // Last seen status per job id; null until the first poll (which seeds without
  // toasting, so pre-existing ready/failed jobs don't re-announce on load).
  const prev = useRef<Map<number, string> | null>(null);
  // The profile the current seed was built for; drives shouldResetSeed below.
  const seededFor = useRef<number | null>(null);

  useEffect(() => {
    // Discard the previous profile's seed on a switch so the new profile re-seeds
    // silently instead of spamming its whole terminal job history (#296). See
    // ExtractionToaster for the full rationale.
    if (shouldResetSeed(seededFor.current, profileId)) {
      prev.current = null;
    }
    seededFor.current = profileId;

    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      // Skip polling while the tab is hidden, but only after prev.current is seeded
      // (see ExtractionToaster) — a job that finishes while hidden is still caught
      // as a `before === undefined` terminal on the next visible poll.
      if (
        prev.current !== null &&
        typeof document !== "undefined" &&
        document.hidden
      ) {
        timer = setTimeout(poll, 6000);
        return;
      }
      const observed = await observeStates(
        IMPORT_JOB_STATES_ENDPOINT,
        isImportJobState
      );
      if (!active) return;
      if (!observed.ok) {
        // A refusal is NOT an empty result: do NOT touch prev.current. Seeding it
        // with an empty set here would defeat the on-load guard (pre-existing
        // ready/failed jobs would re-announce next tick). Retry soon rather than
        // dropping cadence. Over `fetch` this covers the offline case, a 401 after
        // the session lapsed, and a 200 whose body is not the envelope.
        timer = setTimeout(poll, 2000);
        return;
      }
      const jobs = observed.states;

      // Announce a job when it finishes. The `before === undefined` terminal case
      // (a job that started AND finished within a single poll interval — a real
      // risk for small pastes) and the silent first-poll seed both live in
      // diffCompletions — see its comment.
      const { finished, changed, next, seeded } = diffCompletions(
        prev.current,
        jobs,
        isImportTerminal
      );
      prev.current = next;
      if (!seeded) {
        for (const j of finished) {
          if (j.status === "ready") {
            toast(
              `Extracted ${j.summary ?? "your import"}. Review, then save.`,
              {
                duration: null,
                action: {
                  label: "Review",
                  onClick: () =>
                    router.push("/data?section=import#paste-import"),
                },
              }
            );
          } else if (j.status === "failed" || j.status === "skipped") {
            toast(j.error ?? "Extraction didn’t produce any rows.", {
              tone: "error",
              duration: null,
            });
          }
        }
        // Survives the #1473 sweep: this is poll-driven, and since #1878 it is the
        // ONLY thing here that can repaint — the observation above went over a
        // route handler, so no action response carried a tree. Deferred while a
        // record form holds unsaved input; drained, coalesced, on release.
        if (changed) chromeRefresh();
      }

      const processing = jobs.some((j) => j.status === "processing");
      timer = setTimeout(poll, processing ? 2000 : 6000);
    };

    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [router, toast, chromeRefresh, profileId]);

  return null;
}
