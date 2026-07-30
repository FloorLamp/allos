"use client";

import { IconHistory } from "@tabler/icons-react";
import { draftAgeLabel } from "@/lib/offline/drafts";
import type { FormDraftApi } from "./useFormDraft";

// The resume affordance for a local form draft (issue #1699).
//
// A restored draft must be VISIBLY restorable, never silently applied: the app
// makes no state change the user didn't ask for, and quietly refilling a form with
// something typed hours ago on another occasion is exactly such a change. So the
// draft announces itself, names WHEN it was captured, and waits for a tap —
// Resume or Discard, nothing else, no timeout, no default action.
//
// Rendered by the form itself (top of its own body), not as a floating notice: it
// belongs to the form it can restore, and a form that isn't on screen has nothing
// to offer.

export default function DraftRestoreBanner({
  draft,
  noun,
  className,
}: {
  draft: FormDraftApi;
  /** What was being entered, for the copy: "workout", "supplement", … */
  noun: string;
  className?: string;
}) {
  if (!draft.offer) return null;
  const when = draftAgeLabel(draft.offer.savedAt, Date.now());

  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200${
        className ? ` ${className}` : ""
      }`}
      data-testid="draft-restore-banner"
    >
      <IconHistory className="h-4 w-4 shrink-0" stroke={1.75} aria-hidden />
      <span className="flex-1">
        Unsaved {noun} from {when}, kept on this device.
      </span>
      <span className="flex items-center gap-3">
        <button
          type="button"
          onClick={draft.resume}
          className="font-medium text-brand-700 hover:underline dark:text-brand-300"
          data-testid="draft-restore-resume"
        >
          Resume
        </button>
        <button
          type="button"
          onClick={draft.discard}
          className="font-medium text-slate-500 hover:underline dark:text-slate-400"
          data-testid="draft-restore-discard"
        >
          Discard
        </button>
      </span>
    </div>
  );
}
