"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { IconPlus } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { useQuickEntry } from "@/components/QuickEntryProvider";
import { deepLinkFieldId } from "@/lib/measurements-deeplink";
import { useHydrated } from "@/components/useHydrated";
import { useMediaQuery } from "@/components/useMediaQuery";
import MeasurementsQuickAdd, {
  type MeasurementsQuickAddProps,
} from "./MeasurementsQuickAdd";

// Desktop opens the shared measurements form in a modal; mobile deep links
// open the global quick-entry overlay. The destination is fixed after hydration.
export default function LogMeasurementsPanel(
  props: Omit<MeasurementsQuickAddProps, "onSaved"> & {
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
  // null means the user has not overridden the deep-link default for this mount.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const { open: openQuickEntry } = useQuickEntry();
  const hydrated = useHydrated();
  const desktop = useMediaQuery("md");
  // Freeze the responsive destination at the first hydrated snapshot. Rotating a
  // phone after its quick-entry overlay opens must not also produce the desktop
  // modal for the same deep link.
  const [deepLinkDestination, setDeepLinkDestination] = useState<
    "pending" | "desktop" | "mobile"
  >("pending");
  if (deepLinked && hydrated && deepLinkDestination === "pending") {
    setDeepLinkDestination(desktop ? "desktop" : "mobile");
  }
  const open = openOverride ?? deepLinkDestination === "desktop";
  const handledDeepLinkRef = useRef(false);

  useEffect(() => {
    if (deepLinkDestination !== "mobile" || handledDeepLinkRef.current) return;
    handledDeepLinkRef.current = true;
    // Desktop opening is derived above. Mobile delegates to the one global entry
    // surface as the external synchronization this effect actually owns.
    openQuickEntry("measurements");
  }, [deepLinkDestination, openQuickEntry]);

  return (
    // Desktop-only container: phones use the global measurements entry surface.
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
          onClick={() => setOpenOverride(true)}
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
          onClose={() => setOpenOverride(false)}
          size="lg"
          initialFocusRef={deepLinkTarget ? modalInitialFocusRef : undefined}
        >
          <div
            ref={(node) => {
              modalInitialFocusRef.current = deepLinkTarget
                ? (node?.querySelector<HTMLElement>(`#${deepLinkTarget}`) ??
                  null)
                : null;
            }}
            className="min-h-0 overflow-y-auto px-1 pb-1"
            data-testid="log-measurements-modal-body"
          >
            {/* Trends → Overview → body census opens the BODY group (#2014): this affordance sits
                under the body census, so the reading the person came to log is a
                body one. A ?focus=/?new= deep link still wins over it. */}
            <MeasurementsQuickAdd
              {...measurementProps}
              defaultGroup="body"
              onSaved={() => setOpenOverride(false)}
            />
          </div>
        </ModalShell>
      )}
    </div>
  );
}
