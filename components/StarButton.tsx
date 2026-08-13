"use client";

import { useOptimistic, useTransition } from "react";
import { useToast } from "@/components/Toast";
import { toggleSavedItem } from "@/app/(app)/saved-actions";

// THE save toggle (issue #1456) — one gesture, one intent, every savable kind. It
// submits a Trends SERIES KEY ("bio:LDL Cholesterol" | "metric:weight"), which the
// action resolves to a (kind, key) row in `saved_items`; each kind's MEANING lives in
// domain code, not here.
//
// The ★ icon and the "star" verb are deliberately KEPT (existing muscle memory —
// `saved_items` is the internal name only). This replaced the separate pin toggle that
// used to live on Trends Overview tiles: starring a biomarker now earns it the Results
// status card, a Trends chart tile, AND passport inclusion in ONE gesture.
//
// ── The tap paints in the same frame (#2641) ─────────────────────────────────────
//
// This used to be a bare Server-Action `<form>`: the ★ did not move until the write
// returned AND five routes had revalidated AND the current page had re-rendered and
// repainted. Measured in-page (a MutationObserver on `aria-pressed`, six taps on a
// freshly-loaded idle page, seeded database, production build) that is a median
// ~473ms — 366–727ms — of a control that looks like it ignored the tap, and the
// gesture's whole character is that it is casual and repeated while reading. The
// same measurement with `useOptimistic` reads a median ~78ms (4–107ms): the star
// moves on the click and the round-trip catches up behind it.
//
// AND IT ANSWERS A REFUSAL. `toggleSavedItem` returns a typed `FormResult`; the old
// form discarded it, so a refusal painted nothing at all — the page simply
// re-rendered unchanged, which is exactly what a lost tap looks like. The optimistic
// star is therefore never a claim: on a refusal or a throw the transition ends,
// `useOptimistic` falls back to the server's `saved` prop — the pre-tap state, since
// nothing was written — and the reason is toasted. Never confirm-unconditionally
// (the inline-action rule, #2133).
//
// It is deliberately NOT a member of `ONE_TAP_AFFORDANCES` (lib/one-tap.ts). That
// registry is the census of one-tap LOGGING, and its `repeat` vocabulary
// (idempotent / additive / cadenced) classifies what a SECOND LOG means. A star is
// not a log and not a counter: it is a toggle, whose second tap is the UNDO of the
// first and is meant to land in full. Declaring it there would need a fourth repeat
// class to stay honest, and the machinery it would buy — the post-success cooldown
// that ABSORBS a second tap — is the one behaviour a toggle must not have.
//
// WHAT WOULD SHOW IT WORKING: `aria-pressed` and the glyph flip within a frame of
// the tap, independent of how long the write and its five revalidations take.
//
// WHAT WOULD SHOW IT WRONG: a star left lit over a write that did not happen. That
// is the failure this guards structurally — the displayed value is `useOptimistic`
// OVER the server's `saved` prop, not state of its own, so when the transition ends
// there is no path that keeps a refused tap painted.
//
// DECEPTIVE SUCCESS: the star feels instant while the surfaces it GOVERNS — the
// Results status card, the Trends tile, the passport summary — fall further behind,
// because nothing here shortens the revalidation they depend on. A tap that paints
// locally and lands nowhere else is a worse lie than a slow tap. The honest measure
// is the star's state after a reload, and whether the starred tile actually appears
// on Trends — not the frame after the tap.
export default function StarButton({
  itemKey,
  saved,
  compact = false,
  iconOnlyBelowSm = false,
  label,
}: {
  itemKey: string;
  saved: boolean;
  compact?: boolean;
  iconOnlyBelowSm?: boolean;
  label?: string;
}) {
  const toast = useToast();
  const [, startTransition] = useTransition();
  // Based on the SERVER's `saved`, so the optimistic value lives exactly as long as
  // the transition: it is a preview of the write, never a second source of truth.
  const [shown, showOptimistic] = useOptimistic(saved);
  const subject = label ?? "this";

  const toggle = () => {
    startTransition(async () => {
      showOptimistic(!saved);
      const fd = new FormData();
      fd.set("key", itemKey);
      let result;
      try {
        result = await toggleSavedItem(fd);
      } catch {
        // Same shape as every other inline action's throw (OverflowMenu's
        // runAction, #477): report it here rather than letting it escalate to the
        // route error boundary and replace a page the reader was using.
        toast("Couldn't complete that action. Try again.", { tone: "error" });
        return;
      }
      if (!result.ok) toast(result.error, { tone: "error" });
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={shown}
      aria-label={
        iconOnlyBelowSm
          ? shown
            ? `Unstar ${subject}`
            : `Star ${subject}`
          : undefined
      }
      data-testid="star-toggle"
      title={shown ? `Unstar ${subject}` : `Star ${subject}`}
      className={`inline-flex items-center justify-center rounded-lg border font-medium transition ${
        compact
          ? "gap-1 px-2 py-1 text-xs"
          : iconOnlyBelowSm
            ? "h-9 w-9 gap-1.5 p-0 text-sm sm:h-auto sm:w-auto sm:px-3 sm:py-1.5"
            : "gap-1.5 px-3 py-1.5 text-sm"
      } ${
        shown
          ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
          : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
      }`}
    >
      <span>{shown ? "★" : "☆"}</span>
      <span className={iconOnlyBelowSm ? "hidden sm:inline" : undefined}>
        {shown ? "Starred" : "Star"}
      </span>
    </button>
  );
}
