import { IconStethoscope } from "@tabler/icons-react";

// A provider/performer name prefixed with a stethoscope glyph, shared by the
// clinical list pages (procedures, encounters, care-plan) so the attending
// provider renders identically everywhere. `size="sm"` is the compact inline
// variant used as a muted sub-line; the default `md` is the standalone cell.
// `className` overrides the container styling (color/spacing) when a caller
// needs it (e.g. an inline sub-line's `text-xs` treatment).
export default function ProviderName({
  name,
  size = "md",
  className = "text-slate-500 dark:text-slate-400",
}: {
  name: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const icon = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const gap = size === "sm" ? "gap-1" : "gap-1.5";
  return (
    <span className={`inline-flex items-center ${gap} ${className}`}>
      <IconStethoscope className={`${icon} shrink-0`} stroke={1.75} />
      {name}
    </span>
  );
}
