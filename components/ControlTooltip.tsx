"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ANCHOR_MARGIN,
  anchoredPosition,
  type UnboundedAnchoredPosition,
} from "@/lib/anchored-position";
import { microMotionPlan } from "@/lib/micro-motion";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";

// A glyph control says what it does to a screen reader and to nobody else (#4511).
// `title=` used to be the sighted answer and #3729 removed it, correctly — it never
// fired on touch, it could not be styled, and it was a SECOND copy of a string that
// already existed. This is the replacement, and the whole design is that it is not a
// second copy: `ControlTooltip` takes ONE `label`, writes it as the control's
// `aria-label`, and renders that same value in the tooltip. A call site has no way to
// spell the two differently because there is only one place to spell either.
//
// TWO KINDS, ONE BOX. The app's other tooltip is `InfoTooltipIcon` — a tap-to-open
// explainer for a FACT, governed by #3970's rules and deliberately untouched here.
// What the two share is where a tooltip GOES and what it looks like when it gets
// there, so both render `TooltipPanel` below and neither one places anything itself.

// The widest a tooltip gets. Beyond this a label wraps rather than becoming a line
// of text nobody tracks back to its control.
const TOOLTIP_MAX_WIDTH = 256;

// The tooltip box, portaled to <body> and placed against its anchor. Both tooltip
// kinds render this and nothing else draws one.
//
// BELOW, CENTRED, flipping above only when the viewport leaves no room (owner ruling
// 2026-08-31). The decision is `anchoredPosition` — the same pure function every
// portaled panel in the app already asks — so "below by default" is stated once and
// a tooltip cannot drift from a menu. `align: "center"` is the one thing a tooltip
// wants that a menu does not: it is a label FOR the control, not a list hung off it.
export function TooltipPanel({
  id,
  label,
  anchorRef,
}: {
  id: string;
  label: string;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<UnboundedAnchoredPosition | null>(null);
  const reduceMotion = usePrefersReducedMotion();

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      setPos(
        anchoredPosition({
          anchor: anchor.getBoundingClientRect(),
          panel: { height: panel.offsetHeight, width: panel.offsetWidth },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          align: "center",
          // No height bound (#4917): pointer-events-none, so a cap would truncate
          // rather than scroll. `pos.maxHeight` below is `null` — stated, not
          // dropped — and TOOLTIP_MAX_WIDTH is the actual constraint.
          capHeight: false,
        })
      );
    };
    // Twice: once now, against a box the browser has laid out but not yet painted,
    // and once on the next frame, when the panel's own height is real. The second
    // pass is what a flip needs — a zero-height panel fits anywhere.
    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, label]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role="tooltip"
      style={{
        maxWidth: `min(${TOOLTIP_MAX_WIDTH}px, calc(100vw - ${ANCHOR_MARGIN * 2}px))`,
        // Hidden until it has been placed, so no frame paints it where the anchor
        // is not.
        ...(pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }),
      }}
      // `pointer-events-none` is load-bearing, not polish: a tooltip that could be
      // hit would be a tap target the control did not have before, and #3970's
      // per-row affordance budget is counted in tap targets.
      className={`pointer-events-none fixed z-100 w-max rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-left text-xs leading-4 text-slate-100 shadow-lg dark:bg-ink-700 dark:text-slate-100 ${
        microMotionPlan("promote", reduceMotion).className
      }`}
    >
      {label}
    </div>,
    document.body
  );
}

// What a control spreads onto itself to become a tooltip anchor. `aria-label` is in
// here rather than at the call site on purpose: it is the SAME string the tooltip
// draws, and taking it out of the caller's hands is what makes that structural.
export interface ControlAnchorProps {
  ref: RefObject<HTMLButtonElement | null>;
  "aria-label": string;
  "aria-describedby": string | undefined;
  onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

export default function ControlTooltip({
  label,
  children,
}: {
  // The control's accessible name, and therefore also the tooltip's text. One
  // string, one argument, no second channel.
  label: string;
  // The control itself. A render prop rather than a wrapper element because these
  // controls live inside flex toolbars with their own geometry and their own tap
  // floors (#1613, #4505) — a tooltip must not become a box in that layout, and
  // this component renders a fragment so it is not one.
  children: (anchor: ControlAnchorProps) => ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // Whether the focus this control is about to receive came from a pointer. The
  // browser's own answer to that question is `:focus-visible`, and it would be one
  // line — but it is resolved from a document-wide modality record, so the answer
  // depends on what happened before rather than on this control, and it is not the
  // same answer in every engine. This is the same heuristic stated locally: a
  // pointer landing on THIS control means the focus that follows is that pointer's.
  const focusFromPointer = useRef(false);

  return (
    <>
      {children({
        ref,
        "aria-label": label,
        "aria-describedby": open ? id : undefined,
        // MOUSE ONLY. A touch tap fires pointerenter too, and on a control a tap is
        // an ACTIVATION — revealing a label over the thing that just changed state
        // is the opposite of an answer. Touch keeps the platform's own semantics.
        onPointerEnter: (event) => {
          if (event.pointerType === "mouse") setOpen(true);
        },
        onPointerLeave: () => setOpen(false),
        onPointerDown: () => {
          focusFromPointer.current = true;
        },
        // KEYBOARD FOCUS ONLY. A click and a tap both focus the button on their way
        // to activating it, and neither is a request to be told what the button is.
        onFocus: () => {
          if (!focusFromPointer.current) setOpen(true);
        },
        onBlur: () => {
          focusFromPointer.current = false;
          setOpen(false);
        },
      })}
      {open ? <TooltipPanel id={id} label={label} anchorRef={ref} /> : null}
    </>
  );
}
