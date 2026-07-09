"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { getImportJobStates } from "@/app/(app)/data/actions";
import { useToast } from "@/components/Toast";

// App-wide watcher for async paste/CSV import jobs. Polls their status (fast
// while something is extracting, slow otherwise) and, when a job transitions out
// of `processing`, (a) refreshes the current route so the /import list updates
// and (b) shows a sticky toast — success with a "Review" link to /import, or the
// error text. Lives in the root layout so the toast still fires if the user
// navigated away from /import while the extraction ran. Uses the shared useToast
// (unlike the
// bespoke ExtractionToaster for medical documents).
export default function ImportJobsToaster() {
  const router = useRouter();
  const toast = useToast();
  // Last seen status per job id; null until the first poll (which seeds without
  // toasting, so pre-existing ready/failed jobs don't re-announce on load).
  const prev = useRef<Map<number, string> | null>(null);

  useEffect(() => {
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

      const cur = new Map(jobs.map((j) => [j.id, j.status]));

      if (prev.current === null) {
        prev.current = cur;
      } else {
        let changed = cur.size !== prev.current.size;
        for (const j of jobs) {
          const before = prev.current.get(j.id);
          if (before === undefined || before !== j.status) changed = true;
          const terminal =
            j.status === "ready" ||
            j.status === "failed" ||
            j.status === "skipped";
          // Announce a job when it finishes. `before === "processing"` is the
          // normal case; `before === undefined` covers a job that started AND
          // finished within a single poll interval (so we never saw it
          // processing) — a real risk for small pastes. Jobs already present at
          // seed time have a `before` status, so they never re-announce on load.
          if (!terminal || (before !== "processing" && before !== undefined))
            continue;
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
        prev.current = cur;
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
  }, [router, toast]);

  return null;
}
