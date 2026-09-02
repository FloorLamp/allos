"use client";

import { IconPlus } from "@tabler/icons-react";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import {
  usualRoutinePhrase,
  usualRoutineWriteAnswer,
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
//
// ── AND IT STANDS ON A DAY (#4424 ruling 2, folded here 2026-09-02) ──────────
//
// The `/history` add door had spelled this button a FOURTH time — its own markup, its
// own submit path, its own answer rounding — for the single reason that it knows a day
// and this did not. `date` is that reason, deleted: absent is the profile's today (the
// dashboard and the sheet, neither of which has a day to be about), present is the
// record day the reader found the gap on. The core owns the reach either way, so the
// door's whole affordance is now this control with one more prop — which is what "past
// days for free" means for a row control rather than for a form.
export interface UsualRoutineControlProps {
  window: string;
  // The offer, resolved server-side. Each half carries BOTH its wire id (the upper
  // bound the core intersects) and its display NAME — a label is a promise, and a slug
  // is not a promise anybody can read. Kept paired rather than as two parallel arrays
  // so the answer can name exactly the rows the server says it wrote.
  food: { slug: string; name: string }[];
  // The scoop this offer promises (#4379), or null when protein is not a member. The
  // member itself rides `food` above, named as the bundle names it; this is the NUMBER
  // the write needs, resolved when the offer was read so the label and the write agree.
  proteinGrams: number | null;
  // `stack` (#3098) feeds the shared label compression: an all-one-stack rider is
  // promised as "<Stack> (n)" — the profile's own name for exactly those doses.
  doses: { id: number; name: string; stack?: string | null }[];
  // Whose morning this logs (#1013), when the acting profile is not the viewer's own.
  // Resolved server-side through writeSubjectName so a caregiver is never ambiguous.
  subjectName: string | null;
  /**
   * The day this bundle is about. Absent posts no date and the core resolves the
   * profile's today, which is the dashboard's and the sheet's shape; present is the
   * record day the add door stands on (#4118). The bound is the CORE's on both paths.
   */
  date?: string;
}

// THE WIRING A MOUNT ADDS, kept OFF `UsualRoutineControlProps` deliberately: that type
// is the return shape of `loadLogSheetContext`, a Server Action, and
// `serializable-action-returns.test.ts` fails the build the moment a function can reach
// it. So the props the SERVER resolves and the props the CLIENT supplies are two types,
// and the boundary is enforced by the guard rather than remembered.
interface UsualRoutineMountProps {
  /**
   * The two markers this control hangs off, defaulted to the ones the dashboard and the
   * sheet have always carried. The record door passes its own — `history-add-usual-<window>`
   * is the marker its specs address and it is one per standing window, so renaming it to
   * fit a shared scheme would have broken specs to buy nothing.
   */
  testIds?: { button: string; names: string };
  /**
   * The mount's business after a bundle lands — the record door closes its panel and
   * re-reads the feed. The dashboard and the sheet pass nothing: the action's own
   * revalidation is what re-renders them.
   */
  onLogged?: () => void;
}

const DASHBOARD_TEST_IDS = {
  button: "routine-usual-offer",
  names: "routine-usual-names",
} as const;

export default function UsualRoutineControl({
  window,
  food,
  proteinGrams,
  doses,
  subjectName,
  date,
  testIds = DASHBOARD_TEST_IDS,
  onLogged,
}: UsualRoutineControlProps & UsualRoutineMountProps) {
  const toast = useToast();
  // WHICH SURFACE THIS MOUNTING IS (#3087). This control is rendered TWICE — as the
  // dashboard's usual-routine atom and as the phone dock's raised puck inside the
  // quick-log sheet — and the two are one component posting one action, so the region
  // it is mounted in is the only thing that can tell them apart. It is on neither
  // attention card, which is what `dashboard-hero` means.
  const stampLoggedVia = useLoggedViaStamp();
  const ledger = useOptimisticLedger("routine-usual");
  const groups = food.map((f) => f.slug);
  const doseIds = doses.map((d) => d.id);
  const phrase = usualRoutinePhrase(
    food.map((f) => f.name),
    doses
  );
  // THE COUNT IS EVERY WRITE THE TAP PERFORMS (#2460) — the rule the chat attachment
  // has always rendered and the record door had too, now said once for every host.
  const heading = `${
    subjectName ? `${subjectName}'s usual ${window}` : `Your usual ${window}`
  } (${food.length + doses.length})`;

  function run() {
    void ledger.tap<UsualRoutineResult>({
      write: async () => {
        const fd = stampLoggedVia(new FormData());
        fd.set("meal_slot", window);
        // THE DAY BEING FILLED, when this mount stands on one (#4118). Absent lets the
        // action resolve today; either way how far back it may reach is the core's.
        if (date) fd.set("date", date);
        // The names the BUTTON named. The core intersects both lists with the bundle
        // it re-derives from fresh state, so neither is an instruction to write
        // outside the offer that currently stands.
        fd.set("groups", groups.join(","));
        fd.set("dose_ids", doseIds.join(","));
        if (proteinGrams != null) fd.set("protein_grams", String(proteinGrams));
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
        toast(usualRoutineWriteAnswer(food, result));
        onLogged?.();
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
      data-testid={testIds.button}
      data-groups={groups.join(",")}
      data-doses={doseIds.join(",")}
      // The day is named to a screen reader wherever there is one to name: the record
      // door reaches days the reader is not living, and "your usual Morning" without
      // one would be the same sentence for every day it can fill.
      aria-label={
        date ? `${heading} on ${date}: ${phrase}` : `${heading}: ${phrase}`
      }
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
          data-testid={testIds.names}
          className="block truncate text-xs text-slate-600 dark:text-slate-300"
        >
          {phrase}
        </span>
      </span>
    </button>
  );
}
