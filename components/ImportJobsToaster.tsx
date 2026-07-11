"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { getImportJobStates } from "@/app/(app)/data/actions";
import { useToast } from "@/components/Toast";
import { diffCompletions, shouldResetSeed } from "@/lib/toaster-diff";

// The import-job statuses that count as terminal (extraction no longer running).
const isImportTerminal = (status: string) =>
  status === "ready" || status === "failed" || status === "skipped";

// App-wide watcher for async paste/CSV import jobs. Polls their status (fast
// while something is extracting, slow otherwise) and, when a job transitions out
// of `processing`, (a) refreshes the current route so the /import list updates
// and (b) shows a sticky toast — success with a "Review" link to /import, or the
// error text. Lives in the root layout so the toast still fires if the user
// navigated away from /import while the extraction ran. Uses the shared useToast
// (unlike the
// bespoke ExtractionToaster for medical documents).
//
// `profileId` is the session's active profile — the profile `getImportJobStates`
// is scoped to. Like ExtractionToaster it's a dep of the poll effect and resets
// the seed on a switch (#296) so the new profile's pre-existing terminal jobs
// aren't announced as freshly finished.
export default function ImportJobsToaster({
  profileId,
}: {
  profileId: number;
}) {
  const router = useRouter();
  const toast = useToast();
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
      let jobs: Awaited<ReturnType<typeof getImportJobStates>>;
      try {
        jobs = await getImportJobStates();
      } catch {
        // Transient failure: do NOT touch prev.current. Seeding it with an empty
        // set here would defeat the on-load guard (pre-existing ready/failed jobs
        // would re-announce next tick). Retry soon rather than dropping cadence.
        if (active) timer = setTimeout(poll, 2000);
        return;
      }
      if (!active) return;

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
        if (changed) router.refresh();
      }

      const processing = jobs.some((j) => j.status === "processing");
      timer = setTimeout(poll, processing ? 2000 : 6000);
    };

    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [router, toast, profileId]);

  return null;
}
