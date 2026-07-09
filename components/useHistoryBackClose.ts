"use client";

import { useCallback, useEffect, useRef } from "react";

// While `active`, hold a history entry so the phone's back button/gesture
// closes the surface (popstate → onClose) instead of leaving the page. Closing
// any other way (✕, Escape) consumes the entry via history.back() so Back
// doesn't need pressing twice afterwards.
//
// Callers must drive `active` through state on an always-mounted component —
// a mount-tied effect would push/pop on StrictMode's dev double-mount.
//
// `enabled` (optional) is read once when the surface activates, for callers
// that only want the entry on some viewports; it is deliberately not a
// dependency.
//
// Returns markLinkFollowed: call it when a link inside the surface is
// navigating away. The entry can't be consumed reliably mid-navigation, and a
// compensating back() could undo the navigation itself — so the entry is
// deliberately left behind (one inert Back stop) instead.
export function useHistoryBackClose(
  active: boolean,
  onClose: () => void,
  enabled?: () => boolean
) {
  // Callers pass inline closures; keep the latest without retriggering the
  // effect (a push/pop per parent render would trash the history stack).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const linkFollowedRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    if (enabled && !enabled()) return;
    linkFollowedRef.current = false;
    let closedByBack = false;
    window.history.pushState({ backClose: true }, "");
    const onPop = () => {
      closedByBack = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!closedByBack && !linkFollowedRef.current) window.history.back();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return useCallback(() => {
    linkFollowedRef.current = true;
  }, []);
}
