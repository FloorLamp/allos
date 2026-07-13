// Pure builders for "Open in Maps / Directions" deep links from a free-text address
// (issue #568). No storage, no schema, no server-side network: the ONLY data that
// ever leaves the system is the address the user chose to click, sent by THEIR
// browser to THEIR maps provider — the same as pasting it themselves. That
// user-initiated, outward-facing posture is deliberately different from geocoding
// (which would send provider addresses, and by inference care relationships, to a
// third party) — geocoding stays out of scope (Phase 3, #567).
//
// Pure string logic only (no DB, no `db` import) so it lives in the pure vitest
// tier; the one small component that consumes it is components/OpenInMaps.tsx.

// A maps provider we can build a search deep link for.
export type MapsProvider = "google" | "apple" | "geo";

// One selectable maps destination: a human label + the URL to open.
export interface MapsLink {
  provider: MapsProvider;
  label: string;
  href: string;
}

// Normalize a free-text address/location for a maps query: collapse internal
// whitespace and trim. Returns null for an empty/blank string so callers render
// nothing rather than a query-less "search for ''" link.
export function normalizeMapsQuery(
  address: string | null | undefined
): string | null {
  if (typeof address !== "string") return null;
  const q = address.replace(/\s+/g, " ").trim();
  return q.length > 0 ? q : null;
}

// Google Maps universal cross-platform search URL. Works on desktop browsers and
// deep-links into the Google Maps app on mobile — the single most compatible
// target, so it is the primary "Open in Maps" affordance.
export function googleMapsSearchUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// Apple Maps search URL — opens Apple Maps on Apple platforms, falls back to the
// web viewer elsewhere.
export function appleMapsSearchUrl(address: string): string {
  return `https://maps.apple.com/?q=${encodeURIComponent(address)}`;
}

// A `geo:` URI (RFC 5870) with a query — the OS-native "let the platform pick the
// maps app" scheme on Android; no coordinates, so we anchor at 0,0 and pass the
// address as the `q` query the way the platform expects.
export function geoUri(address: string): string {
  return `geo:0,0?q=${encodeURIComponent(address)}`;
}

// Build the full set of maps destinations for an address, in preference order
// (google first — the universal default). Returns [] for a blank address so a
// caller can decide to render nothing. The component renders the first (google) as
// its single primary link; the rest are available for a future picker without
// re-deriving the encoding.
export function mapsLinks(address: string | null | undefined): MapsLink[] {
  const q = normalizeMapsQuery(address);
  if (!q) return [];
  return [
    { provider: "google", label: "Open in Maps", href: googleMapsSearchUrl(q) },
    { provider: "apple", label: "Apple Maps", href: appleMapsSearchUrl(q) },
    { provider: "geo", label: "Open in Maps", href: geoUri(q) },
  ];
}

// The single primary maps href for an address, or null when there's nothing to
// link. The one-call convenience the component uses.
export function primaryMapsHref(
  address: string | null | undefined
): string | null {
  const q = normalizeMapsQuery(address);
  return q ? googleMapsSearchUrl(q) : null;
}
