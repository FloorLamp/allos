"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconClock, IconEyeOff } from "@tabler/icons-react";
import OverflowMenu, {
  MENU_ITEM,
  type MenuHelpers,
} from "@/components/OverflowMenu";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { microMotionPlan } from "@/lib/micro-motion";

// Quick-snooze durations offered per item. One list, shared by both surfaces
// that render this menu, so the choices can't drift apart.
const SNOOZE_OPTIONS: { label: string; days: number }[] = [
  { label: "1 day", days: 1 },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
];

export interface SnoozeDismissProps {
  signalKey: string;
  snoozeAction: (formData: FormData) => Promise<void>;
  dismissAction: (formData: FormData) => Promise<void>;
  // The item's OWNING profile (issue #1096). On a multi-view surface the
  // dismissal/snooze must land on the ITEM's profile, not the acting one, so the
  // caller threads it and each form posts `profile_id`. Omitted (undefined) on a
  // single-view surface, where the action falls back to the active profile.
  profileId?: number;
  // Care-tier persistence (#700 ask 5): an OVERDUE safety follow-up resists an
  // indefinite dismiss — it can still be time-boxed-snoozed, but the Dismiss option
  // is omitted (the filter would ignore a dismiss for it anyway; hiding it here keeps
  // the affordance honest). `dismissAction` is still required so the caller can pass
  // one uniform prop set.
  snoozeOnly?: boolean;
  // THE DISMISSAL SLIDE (#2654, motion 2). The element that should travel toward the
  // fold — in practice the dismissed row — resolved by the caller at tap time.
  //
  // Supplying it is the SURFACE'S DECLARATION THAT IT HAS A FOLD. Only /upcoming
  // does: its "Snoozed & dismissed" disclosure sits below the rows and catches every
  // dismissal, which is the lesson the travel teaches (dismissed ≠ deleted, and here
  // is where to look — the #2386 doctrine's reachability, animated). The dashboard
  // "Needs attention" hero passes nothing: there is no fold on that page, and a row
  // sliding toward nowhere would teach a place that does not exist.
  //
  // A SNOOZE does not slide. It is also caught by the same fold, but a snooze is a
  // "later" and its row is coming back on its own; the travel is the answer to
  // "where did it GO", which is a question only a dismiss raises.
  slideTarget?: () => HTMLElement | null;
}

// The snooze/dismiss MENU ITEMS on their own, so a row that also has other menu
// content can compose them into ONE popover instead of rendering a second kebab
// beside the first (issue #1446 — every overdue preventive row on /upcoming grew
// two identical "⋯" triggers because the preventive override menu and this one are
// separate components). The standalone `SnoozeDismissMenu` below is just these
// items wrapped in their own OverflowMenu, for the surfaces (the dashboard
// "Needs attention" hero) whose rows have nothing else to put in the menu.
export function SnoozeDismissItems({
  runAction,
  signalKey,
  snoozeAction,
  dismissAction,
  profileId,
  snoozeOnly = false,
  slideTarget,
}: SnoozeDismissProps & { runAction: MenuHelpers["runAction"] }) {
  // THE DISMISSAL SLIDE (#2654, motion 2), started on the tap and NEVER awaited.
  //
  // The class goes on the row the instant the form is submitted, before `runAction`
  // awaits the write. That ordering is the whole "motion never delays interactivity"
  // rule: the animation rides the round-trip the dismissal was already going to take,
  // and the row is normally gone — replaced by the revalidated render — before the
  // travel finishes. Nothing waits on it, and no second tap is blocked by it.
  //
  // It is applied imperatively rather than through state because the row is a Server
  // Component: there is no React path from this portaled menu item to the element
  // that must move. The class is removed on a timer for the one path where the row
  // SURVIVES the tap — a write that threw, which `runAction` reports as an error
  // toast — so a refused dismissal leaves no half-faded row behind. The keyframe has
  // no `forwards`, so that row is already back at full opacity by then: it did not go
  // anywhere, and it should not look like it did.
  const reduced = usePrefersReducedMotion();
  const slidePlan = microMotionPlan("slide", reduced);
  const slideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slidingEl = useRef<HTMLElement | null>(null);

  const clearSlide = useCallback(() => {
    if (slideTimer.current) clearTimeout(slideTimer.current);
    slideTimer.current = null;
    slidingEl.current?.classList.remove(slidePlan.className || "motion-slide");
    slidingEl.current?.removeAttribute("data-sliding");
    slidingEl.current = null;
  }, [slidePlan.className]);

  useEffect(() => clearSlide, [clearSlide]);

  function slideToFold() {
    if (!slidePlan.animate || !slideTarget) return;
    const el = slideTarget();
    if (!el) return;
    clearSlide();
    slidingEl.current = el;
    el.classList.add(slidePlan.className);
    el.setAttribute("data-sliding", "true");
    slideTimer.current = setTimeout(clearSlide, slidePlan.ms);
  }

  return (
    <>
      <div className="flex items-center gap-1 px-3 py-1 section-label">
        <IconClock className="h-3 w-3" stroke={1.75} />
        Snooze
      </div>
      {SNOOZE_OPTIONS.map((opt) => (
        <form
          key={opt.days}
          action={(fd) =>
            runAction(snoozeAction, fd, `Snoozed for ${opt.label}`)
          }
        >
          <input type="hidden" name="signal_key" value={signalKey} />
          <input type="hidden" name="days" value={opt.days} />
          {profileId != null && (
            <input type="hidden" name="profile_id" value={profileId} />
          )}
          <button type="submit" role="menuitem" className={MENU_ITEM}>
            {opt.label}
          </button>
        </form>
      ))}
      {!snoozeOnly && (
        <form
          action={(fd) => {
            slideToFold();
            return runAction(dismissAction, fd, "Dismissed");
          }}
          className="border-t border-black/5 dark:border-white/5"
        >
          <input type="hidden" name="signal_key" value={signalKey} />
          {profileId != null && (
            <input type="hidden" name="profile_id" value={profileId} />
          )}
          <button
            type="submit"
            role="menuitem"
            className={`${MENU_ITEM} flex items-center gap-1.5`}
          >
            <IconEyeOff className="h-3.5 w-3.5" stroke={1.75} />
            Dismiss
          </button>
        </form>
      )}
    </>
  );
}

// Per-item snooze/dismiss popover used by the dashboard "Needs attention" hero
// (issue #281). Built on the same OverflowMenu the goal / supplement /
// extracted-record kebabs use, so every popover in the app gets the same opaque
// panel, click-away backdrop, Escape handling, and viewport-aware positioning —
// the old native-<details> version floated a translucent .card and never closed
// on an outside click or after picking an option.
//
// The Upcoming page does NOT use this wrapper: its rows compose
// `SnoozeDismissItems` into the single per-row menu (see UpcomingRowMenu), so a
// row that also offers preventive overrides still shows exactly one "⋯" (#1446).
//
// The Server Actions come in as props from the (server-component) caller: both
// surfaces speak the same shared findings-suppression store, but each keeps its
// own action so it revalidates its own paths. Each action reads `signal_key`
// (+ `days` for a snooze) from the submitted FormData.
export default function SnoozeDismissMenu(props: SnoozeDismissProps) {
  const [open, setOpen] = useState(false);
  return (
    <OverflowMenu label="Snooze or dismiss" open={open} onOpenChange={setOpen}>
      {({ runAction }) => (
        <SnoozeDismissItems {...props} runAction={runAction} />
      )}
    </OverflowMenu>
  );
}
