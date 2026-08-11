"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { IconPlus } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { useQuickEntry } from "@/components/QuickEntryProvider";
import { deepLinkFieldId } from "@/lib/measurements-deeplink";
import MeasurementsQuickAdd, {
  type MeasurementsQuickAddProps,
} from "./MeasurementsQuickAdd";

// The Body tab's on-page logging affordance (issue #1486).
//
// The tab is a READING surface. It used to open with up to three full entry forms
// stacked above the first chart — the #1067 chip collapse softened that on a phone,
// but the forms were still there, mid-scroll, on every visit. The owner decision:
//
//   • DESKTOP — one quiet "+ Log" button that opens the combined form in the
//     standard modal shell. Logging is deliberate; reading is not.
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
// happen: desktop opens the modal, mobile opens the overlay. That is a genuine
// BEHAVIOUR fork (open which surface), not a layout fork, so it is resolved once on
// mount with matchMedia rather than by rendering two copies of anything. The
// breakpoint string matches Tailwind's `md`.
const DESKTOP_QUERY = "(min-width: 768px)";

export default function LogMeasurementsPanel(
  props: Omit<MeasurementsQuickAddProps, "onSaved" | "headerSlot"> & {
    leftControl: ReactNode;
    centerControl: ReactNode;
  }
) {
  const { leftControl, centerControl, ...measurementProps } = props;
  const params = useSearchParams();
  const deepLinkTarget = deepLinkFieldId(
    params.get("focus"),
    params.get("new")
  );
  const deepLinked = deepLinkTarget != null;
  const modalInitialFocusRef = useRef<HTMLElement | null>(null);
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
      <div
        className="relative z-40 flex items-center justify-center"
        data-testid="body-view-controls"
      >
        <div className="absolute inset-y-0 left-0 z-50 flex items-center">
          {leftControl}
        </div>
        {centerControl}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="log-measurements-toggle"
          className="btn btn-sm absolute right-0 top-1/2 -translate-y-1/2"
        >
          <IconPlus className="h-4 w-4" stroke={1.75} aria-hidden />
          Log
        </button>
      </div>

      {open && (
        <ModalShell
          title="Log measurements"
          onClose={() => setOpen(false)}
          className="flex max-h-[calc(100dvh-4rem)] w-full max-w-5xl flex-col rounded-xl bg-white p-5 shadow-xl outline-hidden dark:bg-ink-900"
          initialFocusRef={deepLinkTarget ? modalInitialFocusRef : undefined}
        >
          <div
            ref={(node) => {
              modalInitialFocusRef.current = deepLinkTarget
                ? (node?.querySelector<HTMLElement>(`#${deepLinkTarget}`) ??
                  null)
                : null;
            }}
            className="mt-4 min-h-0 overflow-y-auto px-1 pb-1"
            data-testid="log-measurements-modal-body"
          >
            {/* Trends → Body opens the BODY group (#2014): this affordance sits
                under the body census, so the reading the person came to log is a
                body one. A ?focus=/?new= deep link still wins over it. */}
            <MeasurementsQuickAdd
              {...measurementProps}
              presentation="modal"
              defaultGroup="body"
              onSaved={() => setOpen(false)}
            />
          </div>
        </ModalShell>
      )}
    </div>
  );
}
