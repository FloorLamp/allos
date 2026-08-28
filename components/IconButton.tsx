import type { MouseEventHandler, ReactNode } from "react";

export interface IconButtonProps {
  /** The complete accessible name for the icon-only action. */
  label: string;
  /** Shared visual tone; target geometry and focus treatment never vary. */
  tone?: "neutral" | "amber" | "brand";
  /** The decorative glyph. IconButton hides it from the accessibility tree. */
  children: ReactNode;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Toggle state; IconButton owns both aria-pressed and its selected paint. */
  pressed?: boolean;
  /** Keeps pointer-only helpers out of an editor's keyboard sequence. */
  tabIndex?: number;
  "data-testid"?: string;
}

// The one icon-only button primitive. Its rendered box owns the 44px tap floor,
// so callers never size a glyph and then try to recover its target with a local
// pseudo-element. The required label is the accessible name; the glyph contributes
// no competing name.
export default function IconButton({
  label,
  tone = "neutral",
  children,
  type = "button",
  disabled,
  onClick,
  pressed,
  tabIndex,
  "data-testid": testId,
}: IconButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={label}
      tabIndex={tabIndex}
      data-testid={testId}
      data-icon-button=""
      data-tone={tone}
      className="tap-target inline-flex min-h-(--control-box) min-w-(--control-box) shrink-0 items-center justify-center rounded-full text-slate-500 transition aria-pressed:bg-brand-50 aria-pressed:text-brand-600 aria-pressed:ring-1 aria-pressed:ring-brand-500 data-[tone=amber]:text-amber-500 data-[tone=brand]:text-brand-500 hover:bg-slate-100 hover:text-slate-600 aria-pressed:hover:bg-brand-100 data-[tone=amber]:hover:bg-amber-100 data-[tone=amber]:hover:text-amber-700 data-[tone=brand]:hover:bg-brand-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-40 dark:text-slate-400 dark:aria-pressed:bg-brand-500/10 dark:aria-pressed:text-brand-300 dark:data-[tone=amber]:text-amber-400 dark:data-[tone=brand]:text-brand-500 dark:hover:bg-ink-800 dark:hover:text-slate-300 dark:aria-pressed:hover:bg-brand-500/20 dark:data-[tone=amber]:hover:bg-amber-900/40 dark:data-[tone=brand]:hover:bg-brand-500/20"
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
