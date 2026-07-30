"use client";

import { IconRefresh, IconX } from "@tabler/icons-react";
import {
  BOTTOM_EDGE_GUTTER_LEFT,
  BOTTOM_EDGE_NOTICE_BOTTOM,
  BOTTOM_EDGE_NOTICE_LAYER,
} from "./overlay";

// "Update ready — reload when you like" (issue #1700).
//
// The whole point of the change behind it is that a new build must not interrupt
// anything, so this affordance is as quiet as an affordance can be: small,
// bottom-anchored, dismissible, non-modal, no scrim, no timeout, and it never acts
// on its own. Reloading is one tap and it is the user's tap.
//
// When a form is holding unsaved input the bar says so rather than hiding: the work
// is already kept on this device (#1699), so the honest thing is to tell the user the
// reload is safe and let them decide, not to make the decision for them.
//
// BOTTOM EDGE (#1520): notice layer, bottom-left, using the shared tokens. It sits
// one row higher than the offline pill's slot so the two never land on top of each
// other on the rare occasion both are up.

export default function UpdateReadyBar({
  onReload,
  onDismiss,
  unsavedWork,
}: {
  onReload: () => void;
  onDismiss: () => void;
  unsavedWork: boolean;
}) {
  return (
    <div
      className={`fixed ${BOTTOM_EDGE_NOTICE_BOTTOM} ${BOTTOM_EDGE_GUTTER_LEFT} ${BOTTOM_EDGE_NOTICE_LAYER} mb-12 flex max-w-[min(22rem,calc(100vw-2rem))] items-center gap-3 rounded-lg border border-black/10 bg-white/95 px-3 py-2 text-sm shadow-lg backdrop-blur dark:border-white/10 dark:bg-ink-850/95`}
      data-testid="update-ready-bar"
      role="status"
    >
      <IconRefresh
        className="h-4 w-4 shrink-0 text-brand-600 dark:text-brand-400"
        stroke={1.75}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-slate-700 dark:text-slate-200">
          Update ready
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {unsavedWork
            ? "Reload when you're ready — your entry is kept on this device."
            : "Reload whenever suits you."}
        </p>
      </div>
      <button
        type="button"
        onClick={onReload}
        className="btn shrink-0 px-2.5 py-1 text-xs"
        data-testid="update-ready-reload"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss the update notice"
        title="Dismiss"
        className="shrink-0 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-ink-750 dark:hover:text-slate-300"
        data-testid="update-ready-dismiss"
      >
        <IconX className="h-4 w-4" stroke={1.75} aria-hidden />
      </button>
    </div>
  );
}
