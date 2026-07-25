"use client";

import { useEffect } from "react";
import { appBadgeAction } from "@/lib/app-badge";

// The installed-PWA app-icon badge (issue #1424, section B). Renders nothing.
//
// It is a FORMATTER, not an engine: `count` is the number
// `components/dashboard/NeedsAttentionHero.tsx` already computed for its own
// visible badge (`attentionCardItems(items, today).length` — the #449 care-tier
// set), so the home-screen icon and the hero can never disagree. This component
// deliberately imports no query layer; `lib/__tests__/app-badge-chokepoint.test.ts`
// fails the build if it ever grows one, or if the Badging API is called from
// anywhere else.
//
// Mounted on BOTH of the hero's branches — including the all-clear one, where
// `count` is 0. That is the whole reason it is a separate component rather than
// an effect inside `AttentionHeroCard`: the card is not rendered at count 0, so
// an effect living there could set a badge but never clear one, and a stale "3"
// would outlive the last resolved item.
//
// Feature-detected and silent: browsers without the Badging API (Firefox, iOS
// Safari today) simply have no `setAppBadge`, and Chromium REJECTS the promise
// in a plain tab (the badge only applies to an installed app). Both are normal,
// not errors — nothing is logged or surfaced.

type BadgingNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export default function AppBadge({ count }: { count: number }) {
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const nav = navigator as BadgingNavigator;

    const apply = () => {
      const action = appBadgeAction(count);
      try {
        const p =
          action.kind === "set"
            ? nav.setAppBadge?.(action.count)
            : nav.clearAppBadge?.();
        // Rejects in a non-installed context; that is expected, not a failure.
        void p?.catch(() => {});
      } catch {
        // Synchronous throw (older/partial implementations) — degrade silently.
      }
    };

    apply();

    // Re-assert on foreground (issue #1424: "set on app open/focus"). An OS can
    // drop the badge when the app is swiped away, and a standalone launch that
    // restores a cached page may not re-run the effect — re-applying the SAME
    // already-rendered count on visibility is free and idempotent. It never
    // re-derives: `count` is still the prop.
    const onVisible = () => {
      if (document.visibilityState === "visible") apply();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [count]);

  return null;
}
