"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { useQuickEntry } from "@/components/QuickEntryProvider";
import { openGlobalSearch } from "@/components/CommandPalette";
import { QUICK_PARAM, shortcutAction } from "@/lib/pwa-shortcuts";

// The landing half of the PWA manifest shortcuts (issue #1424, section A).
// Renders no UI; it exists to interpret `?quick=<id>` on arrival. Its hidden
// state marker records the exact value its effect consumed so browser tests can
// wait for consumption itself instead of polling Playwright's cached URL (#1992).
//
// **No new entry paths.** The dispatch below is the SAME switch
// `components/QuickLogSheet.tsx` runs over the same `QuickLogTarget` union from
// the same `lib/quick-log.ts` registry (#1476) — a shortcut opens the activity
// editor through `openCreate()`, a live session through `openLive()`, and a
// transactional logger through the shared quick-entry overlay's `open(form)`.
// Search reuses `openGlobalSearch()`, the palette's existing programmatic seam.
//
// Mounted beside `CommandPalette` in `app/(app)/layout.tsx` — inside
// `ActivityEditorProvider` (it needs both contexts) and viewport-agnostic on
// purpose: an installed PWA shortcut is a phone affordance, but the resulting URL
// is an ordinary link that must behave the same if pasted into a desktop tab.
//
// The param is stripped with `router.replace` as soon as it is read, so a reload,
// a back-navigation, or a shared URL doesn't re-pop the editor over work in
// progress. The `handled` ref keys on the VALUE (not a bare fire-once latch) so
// a later arrival with a different — or the same, after the param cleared —
// shortcut still opens.
//
// THIS EFFECT OPENS ONCE PER VALUE, INCLUDING ACROSS A STRICTMODE REMOUNT (#5922).
// The ref survives React's development double-invoke, so the second pass does not
// re-open — which means anything that tears the overlay down BETWEEN the two passes
// leaves the param consumed and nothing on screen. That is exactly what
// `?quick=log-stool` did on a dev server while `e2e/bristol-stool.spec.ts` was green
// at five call sites through the same URL: the e2e servers are `next start` with
// NODE_ENV=production (e2e/fixtures.ts), where effects run once. The teardown was
// QuickEntryProvider's mount-time `clearLastGood()` broadcast; the fix and the full
// account live at that effect. A browser suite cannot see a StrictMode-only
// regression, so the pin is a component test —
// `components/__tests__/quick-entry-last-good.test.tsx`, "a deep link opened during
// mount survives a StrictMode remount".

export default function QuickShortcutHandler({
  cycleRelevant = true,
  substanceRelevant = false,
}: {
  // The #1042 `cycle` relevance bit (#1892), so `?quick=log-period` is gated exactly
  // as the sheet row is. The overlay re-checks it server-side regardless.
  cycleRelevant?: boolean;
  // The #3327 bit, so `?quick=log-substance` is gated exactly as the sheet row is.
  // The overlay re-checks both halves server-side regardless.
  substanceRelevant?: boolean;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const { openCreate, openLive, canStartWorkout } = useActivityEditor();
  const { open: openQuickEntry } = useQuickEntry();
  const handled = useRef<string | null>(null);
  // The value this effect consumed and WHAT IT OPENED for it — one piece of state, so
  // the marker can never name a value without answering the second question (#5922).
  // `opened` is null for a consumed value that opened nothing.
  const [consumed, setConsumed] = useState<{
    value: string;
    opened: string | null;
  } | null>(null);

  const raw = params.get(QUICK_PARAM);

  useEffect(() => {
    if (raw == null) {
      handled.current = null;
      return;
    }
    if (handled.current === raw) return;
    handled.current = raw;

    // Erase the consumed param FIRST, and for an unrecognized value too — a URL
    // that does nothing shouldn't keep advertising an action in the address bar.
    //
    // `history.replaceState`, NOT `router.replace`: this is a URL correction, not
    // a navigation. router.replace would kick off a soft navigation — an RSC
    // round trip that re-renders the page we are simultaneously opening an
    // overlay on top of, for no benefit. Next supports the native history methods
    // for exactly this (they stay in sync with usePathname/useSearchParams), and
    // the `handled` ref covers us either way.
    const url = new URL(window.location.href);
    url.searchParams.delete(QUICK_PARAM);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    // CONSUMING AND OPENING ARE ANSWERED TOGETHER. Every branch below records what it
    // opened, so "the param vanished and the dashboard sat there" is a state the app
    // can state rather than one a reader has to infer. Nothing user-facing: a stale
    // bookmark or a row this profile does not carry is a no-op by design (see
    // `shortcutAction`), not an error worth interrupting anyone with. The marker is
    // what a browser test reads; the console line is what a developer meets.
    const action = shortcutAction(raw, cycleRelevant, substanceRelevant);
    let opened: string | null = null;
    if (!action) {
      // Unrecognized, or a row gated away by this profile's relevance bits.
    } else if (action.kind === "search") {
      openGlobalSearch();
      opened = "search";
    } else {
      const target = action.item.target;
      if (target.kind === "activity") {
        openCreate();
        opened = "activity";
      } else if (target.kind === "live") {
        // The only recognized row that can legitimately open nothing: no workout to
        // start or resume for this profile.
        if (canStartWorkout) {
          openLive();
          opened = "live";
        }
      } else if (target.kind === "overlay") {
        openQuickEntry(target.form);
        opened = `overlay:${target.form}`;
      }
      // `navigate` is unreachable from a shortcut (no registry row carries one, and
      // a shortcut URL that navigates would be a plain href instead) — but the
      // union stays exhaustive so a future one is a compile error here, not a
      // silently dead deep link.
      else {
        router.push(target.href);
        opened = "navigate";
      }
    }
    setConsumed({ value: raw, opened });
    if (!opened) {
      console.warn(
        `?${QUICK_PARAM}=${raw} was consumed but opened nothing (unknown shortcut, or one this profile does not carry).`
      );
    }
  }, [
    raw,
    router,
    cycleRelevant,
    substanceRelevant,
    openCreate,
    openLive,
    canStartWorkout,
    openQuickEntry,
  ]);

  return (
    <span
      hidden
      data-testid="quick-shortcut-handler"
      data-consumed={consumed?.value ?? ""}
      // "" before anything is consumed AND for a consumed value that opened nothing —
      // read it beside `data-consumed`, which says whether the effect ran at all.
      data-opened={consumed?.opened ?? ""}
    />
  );
}
