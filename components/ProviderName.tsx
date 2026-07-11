import Link from "next/link";
import { IconStethoscope } from "@tabler/icons-react";

// A provider/performer name prefixed with a stethoscope glyph, shared by the
// clinical list pages (procedures, encounters, care-plan) so the attending
// provider renders identically everywhere. `size="sm"` is the compact inline
// variant used as a muted sub-line; the default `md` is the standalone cell.
// `className` overrides the container styling (color/spacing) when a caller
// needs it (e.g. an inline sub-line's `text-xs` treatment).
//
// When a `providerId` is given, the name becomes a link to the provider's detail
// page (issue #275) — the primary navigation into the registry. Callers rendering
// INSIDE another `<a>` must omit it (nested anchors are invalid), but the
// record-table cells that use this are not themselves links, so they pass it.
export default function ProviderName({
  name,
  providerId,
  size = "md",
  className = "text-slate-500 dark:text-slate-400",
}: {
  name: string;
  providerId?: number | null;
  size?: "sm" | "md";
  className?: string;
}) {
  const icon = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const gap = size === "sm" ? "gap-1" : "gap-1.5";
  const inner = (
    <>
      <IconStethoscope className={`${icon} shrink-0`} stroke={1.75} />
      {name}
    </>
  );
  if (providerId) {
    return (
      <Link
        href={`/providers/${providerId}`}
        className={`inline-flex items-center ${gap} ${className} hover:text-brand-700 hover:underline dark:hover:text-brand-300`}
      >
        {inner}
      </Link>
    );
  }
  return (
    <span className={`inline-flex items-center ${gap} ${className}`}>
      {inner}
    </span>
  );
}
