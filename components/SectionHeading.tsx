import type { ReactNode } from "react";

// ── ONE SECTION HEADING (issue #5186) ───────────────────────────────────────
//
// A card or section title below the page's h1. The level picks the element and
// nothing else; the size is the one scale axis callers choose. Omitting `size`
// inherits the surrounding text size, which is the common card heading. Weight
// and grey are fixed here, and margin belongs to the parent's gap.
const SIZE_CLASS = {
  lg: "text-lg ",
  base: "text-base ",
  sm: "text-sm ",
} as const;

export default function SectionHeading({
  level,
  size,
  trailing,
  id,
  "data-testid": testId,
  children,
}: {
  level: 2 | 3;
  size?: keyof typeof SIZE_CLASS;
  /** The small right-aligned caption or link beside the title. */
  trailing?: ReactNode;
  id?: string;
  "data-testid"?: string;
  children: ReactNode;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  const heading = (
    <Heading
      id={id}
      data-testid={testId}
      className={`${size ? SIZE_CLASS[size] : ""}font-semibold text-slate-800 dark:text-slate-100`}
    >
      {children}
    </Heading>
  );
  if (trailing == null) return heading;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      {heading}
      {trailing}
    </div>
  );
}
