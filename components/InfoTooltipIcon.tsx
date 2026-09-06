"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconInfoCircle } from "@tabler/icons-react";
import { TooltipPanel } from "@/components/ControlTooltip";

export default function InfoTooltipIcon({
  label,
  "data-testid": testId,
}: {
  label: string;
  "data-testid"?: string;
}) {
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || focused || pinned;

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
      className="pointer-events-auto relative z-10 inline-flex align-middle"
      data-escape-layer={open ? "true" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
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
        className="tap-target inline-flex h-(--control-box) w-(--control-box) shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-400 dark:hover:bg-ink-750 dark:hover:text-slate-300"
      >
        <IconInfoCircle className="h-4 w-4" stroke={2} aria-hidden />
      </button>
      {/* The fact tooltip and the control tooltip are two affordances with one box
          and one placement (owner ruling 2026-08-31). What stays HERE is the part
          that is only true of an info affordance: it opens on a TAP and stays
          pinned, because a fact is something you read rather than something you
          point at, and Escape closes it as its own layer (#3222/#3409). */}
      {open ? (
        <TooltipPanel id={tooltipId} label={label} anchorRef={buttonRef} />
      ) : null}
    </span>
  );
}
