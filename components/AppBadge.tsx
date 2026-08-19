"use client";

import { useEffect } from "react";
import { appBadgeAction } from "@/lib/app-badge";

// The installed-PWA app-icon badge (issue #1424, section B). Renders nothing.
//
// It is a FORMATTER, not an engine: `count` is the page's already-computed
// `attentionBadgeItems(items, today).length` (#449 care-tier set). This component
// deliberately imports no query layer and derives no dashboard policy.
//
// Mounted for every dashboard result, including all-clear where `count` is 0, so
// the last resolved item clears a stale installed-app badge.
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
