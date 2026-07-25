"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { IconPlus } from "@tabler/icons-react";
import { useQuickEntry } from "@/components/QuickEntryProvider";
import { measurementsDeepLinked } from "@/lib/measurements-deeplink";
import MeasurementsQuickAdd, {
  type MeasurementsQuickAddProps,
} from "./MeasurementsQuickAdd";

// The Body tab's on-page logging affordance (issue #1486).
//
// The tab is a READING surface. It used to open with up to three full entry forms
// stacked above the first chart — the #1067 chip collapse softened that on a phone,
// but the forms were still there, mid-scroll, on every visit. The owner decision:
//
//   • DESKTOP — one quiet "+ Log" button that expands the combined form IN PLACE,
//     collapsed by default. Logging is deliberate; reading is not.
//   • MOBILE  — NO on-page form at all. The phone's logging path is the global
//     quick-log sheet / quick-entry overlay (#1467/#1468), which is one tap from
//     anywhere and returns you to where you were. A second, page-local copy of the
//     same form would be exactly the duplication that rule exists to prevent.
//
// The form itself is authored ONCE (MeasurementsQuickAdd) and mounted here and in
// the overlay — never hand-mirrored into a `hidden md:*` / `md:hidden` pair.
//
// ── Deep links ───────────────────────────────────────────────────────────────
// `?focus=blood-pressure` / `?new=weight` (and friends) must still land the user in
// a focused field on BOTH viewports, and the two viewports need different things to
// happen: desktop expands the panel, mobile opens the overlay. That is a genuine
// BEHAVIOUR fork (open which surface), not a layout fork, so it is resolved once on
// mount with matchMedia rather than by rendering two copies of anything. The
// breakpoint string matches Tailwind's `md`.
const DESKTOP_QUERY = "(min-width: 768px)";

export default function LogMeasurementsPanel(
  props: Omit<MeasurementsQuickAddProps, "onSaved" | "headerSlot">
) {
  const params = useSearchParams();
  const deepLinked = measurementsDeepLinked(
    params.get("focus"),
    params.get("new")
  );
  const [open, setOpen] = useState(false);
  const { open: openQuickEntry } = useQuickEntry();

  useEffect(() => {
    if (!deepLinked) return;
    const desktop =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(DESKTOP_QUERY).matches
        : true;
    if (desktop) setOpen(true);
    else openQuickEntry("measurements");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // Desktop-only container: on a phone this renders nothing at all, so the tab
    // opens on the Today strip.
    <div className="hidden md:block" data-testid="log-measurements-panel">
      {open ? (
        <MeasurementsQuickAdd
          {...props}
          headerSlot={
            <button
              type="button"
              onClick={() => setOpen(false)}
              data-testid="log-measurements-close"
              className="shrink-0 rounded-full border border-black/10 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
            >
              Done
            </button>
          }
        />
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-expanded={false}
            aria-controls="measurements-quick-add"
            data-testid="log-measurements-toggle"
            className="inline-flex items-center gap-1.5 rounded-full border border-black/10 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            <IconPlus className="h-4 w-4" stroke={1.75} aria-hidden />
            Log
          </button>
        </div>
      )}
    </div>
  );
}
