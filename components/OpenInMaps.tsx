import { IconMapPin } from "@tabler/icons-react";
import { primaryMapsHref } from "@/lib/maps-link";

// Small "Open in Maps / Directions" affordance for a free-text address or location
// (issue #568). Renders a single link to the user's own maps provider (Google Maps
// universal URL — cross-platform, deep-links the native app on mobile). Nothing
// leaves the app: this is a plain outbound navigation to a URL built from the
// address the user clicks. Renders NOTHING when there's no usable address, so
// callers can drop it in unconditionally.
//
// Server-safe (no client state) — it's a static <a>, like ProviderName.
export default function OpenInMaps({
  address,
  label = "Open in Maps",
  className,
  showIcon = true,
}: {
  address: string | null | undefined;
  label?: string;
  className?: string;
  showIcon?: boolean;
}) {
  const href = primaryMapsHref(address);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid="open-in-maps"
      title={`${label} — opens your maps app`}
      className={
        className ??
        "inline-flex items-center gap-1 text-brand-700 hover:underline dark:text-brand-300"
      }
    >
      {showIcon ? (
        <IconMapPin className="h-4 w-4 shrink-0" stroke={1.75} />
      ) : null}
      {label}
    </a>
  );
}
