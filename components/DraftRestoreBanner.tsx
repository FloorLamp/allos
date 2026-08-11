"use client";

import { IconHistory } from "@tabler/icons-react";
import { Notice } from "./Notice";
import { draftAgeLabel } from "@/lib/offline/drafts";
import type { FormDraftApi } from "./useFormDraft";
import { useState } from "react";

// The resume affordance for a local form draft (issue #1699).
//
// A restored draft must be VISIBLY restorable, never silently applied: the app makes
// no state change the user didn't ask for, and quietly refilling a form with
// something typed hours ago on another occasion is exactly such a change. So the
// draft announces itself, says WHEN it was captured and that it never left the
// device, and then waits — Resume or Discard, nothing else, no timeout, no default
// action.
//
// Rendered by the form itself (at the top of its own body), not as a floating
// notice: it belongs to the form it can restore, and a form that isn't on screen has
// nothing to offer.

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
  const [mountedAt] = useState(Date.now);
  if (!draft.offer) return null;
  const when = draftAgeLabel(draft.offer.savedAt, mountedAt);

  return (
    <Notice
      tone="amber"
      testid="draft-restore-banner"
      className={className}
      icon={<IconHistory className="mt-0.5 h-4 w-4 shrink-0" stroke={1.75} />}
      action={
        <span className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={draft.resume}
            className="font-medium underline-offset-2 hover:underline"
            data-testid="draft-restore-resume"
          >
            Resume
          </button>
          <button
            type="button"
            onClick={draft.discard}
            className="font-medium opacity-70 underline-offset-2 hover:underline"
            data-testid="draft-restore-discard"
          >
            Discard
          </button>
        </span>
      }
    >
      Unsaved {noun} from {when}, kept on this device.
    </Notice>
  );
}
