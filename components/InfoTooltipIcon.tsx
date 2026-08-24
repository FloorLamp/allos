"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconInfoCircle } from "@tabler/icons-react";

const TOOLTIP_MAX_WIDTH = 256;
const TOOLTIP_MARGIN = 12;
const TOOLTIP_GAP = 8;

type TooltipPosition = {
  left: number;
  top: number;
  width: number;
};

export default function InfoTooltipIcon({
  label,
  className,
  "data-testid": testId,
}: {
  label: string;
  className?: string;
  "data-testid"?: string;
}) {
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const open = hovered || focused || pinned;

  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const width = Math.min(
        TOOLTIP_MAX_WIDTH,
        window.innerWidth - TOOLTIP_MARGIN * 2
      );
      const left = Math.min(
        Math.max(TOOLTIP_MARGIN, rect.left + rect.width / 2 - width / 2),
        window.innerWidth - width - TOOLTIP_MARGIN
      );
      const tooltipHeight = tooltipRef.current?.offsetHeight ?? 0;
      const fitsRight =
        rect.right + TOOLTIP_GAP + width <= window.innerWidth - TOOLTIP_MARGIN;
      const fitsLeft = rect.left - TOOLTIP_GAP - width >= TOOLTIP_MARGIN;
      const sideTop = Math.min(
        Math.max(
          TOOLTIP_MARGIN,
          rect.top + rect.height / 2 - tooltipHeight / 2
        ),
        window.innerHeight - tooltipHeight - TOOLTIP_MARGIN
      );
      const fitsAbove =
        rect.top - TOOLTIP_GAP - tooltipHeight >= TOOLTIP_MARGIN;
      const top =
        fitsRight || fitsLeft
          ? sideTop
          : fitsAbove
            ? rect.top - TOOLTIP_GAP - tooltipHeight
            : rect.bottom + TOOLTIP_GAP;
      const placedLeft = fitsRight
        ? rect.right + TOOLTIP_GAP
        : fitsLeft
          ? rect.left - TOOLTIP_GAP - width
          : left;
      setPosition({ left: placedLeft, top, width });
    };

    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [label, open]);

  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      setPinned(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pinned]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPinned(false);
      setHovered(false);
      setFocused(false);
      buttonRef.current?.blur();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  return (
    <span
      className={["relative z-10 inline-flex align-middle", className]
        .filter(Boolean)
        .join(" ")}
      data-escape-layer={open ? "true" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title="More information"
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        data-testid={testId}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={() =>
          setPinned((value) => {
            const next = !value;
            if (!next) {
              setFocused(false);
              buttonRef.current?.blur();
            }
            return next;
          })
        }
        className="tap-target inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-400 dark:hover:bg-ink-750 dark:hover:text-slate-300"
      >
        <IconInfoCircle className="h-4 w-4" stroke={2} aria-hidden />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              style={
                position
                  ? {
                      left: position.left,
                      top: position.top,
                      width: position.width,
                    }
                  : { visibility: "hidden" }
              }
              className="pointer-events-none fixed z-100 rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-left text-xs leading-4 text-slate-100 shadow-lg dark:bg-ink-700 dark:text-slate-100"
            >
              {label}
            </div>,
            document.body
          )
        : null}
    </span>
  );
}
