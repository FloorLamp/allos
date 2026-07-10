"use client";

import { useEffect, type RefObject } from "react";

// When a create surface is reached from a command-palette "create" action, it
// carries a query param (see lib/palette-actions FOCUS_PARAM) telling the target
// form to open itself: scroll into view + focus its first field (issue #29).
//
// Reads window.location.search directly (once, on mount) rather than
// useSearchParams so it needs no Suspense boundary and runs client-only. A
// navigation always mounts the destination fresh, so once-on-mount is enough.
//
// `param` is the query key to look for; `value`, when given, must match the
// param's value (e.g. `new=weight` vs `new=vitals` targeting the same form).
// `enabled` (default true) lets a shared form component opt a non-create instance
// out — an edit/prefill variant on the same page must not steal the focus.
export function useFocusFormOnParam(
  ref: RefObject<HTMLElement | null>,
  param: string,
  value?: string,
  enabled = true
): void {
  useEffect(() => {
    if (typeof window === "undefined" || !enabled) return;
    const got = new URLSearchParams(window.location.search).get(param);
    if (got == null) return;
    if (value != null && got !== value) return;
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Focus the first enabled field so the user can type immediately.
    const field = el.querySelector<HTMLElement>(
      "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])"
    );
    field?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
