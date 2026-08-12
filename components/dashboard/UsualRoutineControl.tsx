"use client";

import { IconPlus } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import {
  usualRoutineAnswerText,
  usualRoutinePhrase,
} from "@/lib/usual-routine";
import { logUsualRoutine, type UsualRoutineResult } from "@/app/(app)/actions";

// THE MORNING IN ONE TAP, on the surface a morning actually starts on (#2458).
//
// It is an OFFER. The label below names EVERY serving and EVERY dose the tap will
// write, and the write core re-derives the same bundle from fresh server state and
// writes only the intersection — so this control cannot promise a write the server
// would not perform, and the server cannot perform one this label did not name. The
// user's tap is the write; nothing here logs anything on anyone's behalf.
//
// The answer is rendered from the typed outcome, never an unconditional ✓: a stale tab
// whose breakfast was logged from Telegram, or whose creatine was paused ten minutes
// ago, gets the honest partial sentence.
export interface UsualRoutineControlProps {
  window: string;
  // The offer, resolved server-side. Each half carries BOTH its wire id (the upper
  // bound the core intersects) and its display NAME — a label is a promise, and a slug
  // is not a promise anybody can read. Kept paired rather than as two parallel arrays
  // so the answer can name exactly the rows the server says it wrote.
  food: { slug: string; name: string }[];
  doses: { id: number; name: string }[];
  // Whose morning this logs (#1013), when the acting profile is not the viewer's own.
  // Resolved server-side through writeSubjectName so a caregiver is never ambiguous.
  subjectName: string | null;
}

export default function UsualRoutineControl({
  window,
  food,
  doses,
  subjectName,
}: UsualRoutineControlProps) {
  const toast = useToast();
  const ledger = useOptimisticLedger("routine-usual");
  const groups = food.map((f) => f.slug);
  const doseIds = doses.map((d) => d.id);
  const phrase = usualRoutinePhrase(
    food.map((f) => f.name),
    doses.map((d) => d.name)
  );
  const heading = subjectName
    ? `${subjectName}'s usual ${window}`
    : `Your usual ${window}`;

  function run() {
    void ledger.tap<UsualRoutineResult>({
      write: async () => {
        const fd = new FormData();
        fd.set("meal_slot", window);
        // The names the BUTTON named. The core intersects both lists with the bundle
        // it re-derives from fresh state, so neither is an instruction to write
        // outside the offer that currently stands.
        fd.set("groups", groups.join(","));
        fd.set("dose_ids", doseIds.join(","));
        return logUsualRoutine(fd);
      },
      settle: (result) => {
        if (!result.ok) {
          // The bundle went stale between render and tap. Answered from the typed
          // outcome — never confirmed — and the action revalidated, so the control
          // re-renders into whatever now stands (usually: gone).
          toast(result.error || "Couldn't log that — try again.", {
            tone: "error",
          });
          return { kind: "rollback" };
        }
        const wrote = new Set(result.groups.map((g) => g.groupKey));
        toast(
          usualRoutineAnswerText(
            food.filter((f) => wrote.has(f.slug)).map((f) => f.name),
            result.doses
              .filter(
                (d) => d.outcome === "logged" || d.outcome === "logged-off-day"
              )
              .map((d) => d.name),
            result.doses
              .filter(
                (d) => d.outcome !== "logged" && d.outcome !== "logged-off-day"
              )
              .map((d) => d.name)
          )
        );
        return { kind: "keep" };
      },
      onError: () => {
        // Online-only by declaration (lib/offline/queue.ts): the bundle's
        // justification is server state and a dose confirm moves supply. The
        // single-serving and single-dose taps beside it still queue, so nothing is
        // unreachable offline — only the shortcut is.
        toast("Couldn't log that — try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  return (
    <button
      type="button"
      data-testid="routine-usual-offer"
      data-groups={groups.join(",")}
      data-doses={doseIds.join(",")}
      aria-label={`${heading}: ${phrase}`}
      title={`One tap logs ${phrase}`}
      disabled={ledger.blocked()}
      onClick={run}
      className="mb-3 flex w-full items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-left transition hover:bg-brand-50 disabled:opacity-50 dark:border-brand-900 dark:bg-brand-950/40 dark:hover:bg-brand-950/60"
    >
      <IconPlus
        className="h-5 w-5 shrink-0 text-brand-700 dark:text-brand-300"
        stroke={2}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
          {heading}
        </span>
        <span
          data-testid="routine-usual-names"
          className="block truncate text-xs text-slate-600 dark:text-slate-300"
        >
          {phrase}
        </span>
      </span>
    </button>
  );
}
