import type { MouseEventHandler, ReactNode } from "react";

export interface IconButtonProps {
  /** The complete accessible name for the icon-only action. */
  label: string;
  /** Optional shorter hover text. Defaults to the accessible name. */
  tooltip?: string;
  /** Shared visual tone; target geometry and focus treatment never vary. */
  tone?: "neutral" | "amber" | "brand";
  /** The decorative glyph. IconButton hides it from the accessibility tree. */
  children: ReactNode;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  "data-testid"?: string;
}

// The one icon-only button primitive. Its rendered box owns the 44px tap floor,
// so callers never size a glyph and then try to recover its target with a local
// pseudo-element. The required label is both the accessible name and, by default,
// the hover title; the glyph contributes no competing name.
export default function IconButton({
  label,
  tooltip,
  tone = "neutral",
  children,
  type = "button",
  disabled,
  onClick,
  "data-testid": testId,
}: IconButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={tooltip ?? label}
      data-testid={testId}
      data-icon-button=""
      data-tone={tone}
      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-slate-500 transition data-[tone=amber]:text-amber-500 data-[tone=brand]:text-brand-500 hover:bg-slate-100 hover:text-slate-600 data-[tone=amber]:hover:bg-amber-100 data-[tone=amber]:hover:text-amber-700 data-[tone=brand]:hover:bg-brand-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-40 dark:text-slate-400 dark:data-[tone=amber]:text-amber-400 dark:data-[tone=brand]:text-brand-500 dark:hover:bg-ink-800 dark:hover:text-slate-300 dark:data-[tone=amber]:hover:bg-amber-900/40 dark:data-[tone=brand]:hover:bg-brand-500/20"
    >
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center"
      >
        {children}
      </span>
    </button>
  );
}
