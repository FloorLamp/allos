"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { useQuickEntry } from "@/components/QuickEntryProvider";
import { openGlobalSearch } from "@/components/CommandPalette";
import { currentPathHref } from "@/lib/hrefs";
import { QUICK_PARAM, shortcutAction } from "@/lib/pwa-shortcuts";

// The landing half of the PWA manifest shortcuts (issue #1424, section A).
// Renders nothing; it exists to interpret `?quick=<id>` on arrival.
//
// **No new entry paths.** The dispatch below is the SAME switch
// `components/QuickLogSheet.tsx` runs over the same `QuickLogTarget` union from
// the same `lib/quick-log.ts` registry (#1476) — a shortcut opens the activity
// editor through `openCreate()` and every other logger through the shared
// quick-entry overlay's `open(form)`. Search reuses `openGlobalSearch()`, the
// palette's existing programmatic seam (already used by the mobile bar).
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

export default function QuickShortcutHandler({
  restricted = false,
}: {
  restricted?: boolean;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { openCreate } = useActivityEditor();
  const { open: openQuickEntry } = useQuickEntry();
  const handled = useRef<string | null>(null);

  const raw = params.get(QUICK_PARAM);

  useEffect(() => {
    if (raw == null) {
      handled.current = null;
      return;
    }
    if (handled.current === raw) return;
    handled.current = raw;

    // Strip the param FIRST, and for an unrecognized value too — a URL that does
    // nothing shouldn't keep advertising an action in the address bar.
    const rest = new URLSearchParams(params.toString());
    rest.delete(QUICK_PARAM);
    const qs = rest.toString();
    router.replace(currentPathHref(qs ? `${pathname}?${qs}` : pathname), {
      scroll: false,
    });

    const action = shortcutAction(raw, restricted);
    if (!action) return;
    if (action.kind === "search") {
      openGlobalSearch();
      return;
    }
    const target = action.item.target;
    if (target.kind === "activity") openCreate();
    else if (target.kind === "overlay") openQuickEntry(target.form);
    // `navigate` is unreachable from a shortcut (no registry row carries one, and
    // a shortcut URL that navigates would be a plain href instead) — but the
    // union stays exhaustive so a future one is a compile error here, not a
    // silently dead deep link.
    else router.push(target.href);
  }, [raw, params, pathname, router, restricted, openCreate, openQuickEntry]);

  return null;
}
