// Pure helpers for the per-profile home location (issue #570): coordinate
// validation, COARSE rounding, and the offline US-ZIP → centroid lookup used to
// SUGGEST a home location from an imported CCD's patient postal code.
//
// PRIVACY BY CONSTRUCTION. Solar math is insensitive below city scale, so home
// coordinates are stored ROUNDED TO ~0.1° (~11 km): a DB compromise or an
// accidental export can never encode a street address. The ZIP→centroid table is
// already rounded the same way (scripts/gen-zip-centroids.ts), so an imported ZIP
// resolves to exactly the coarse precision we store — nothing sharper ever exists.
// Home location is NEVER written to any log (it's PHI-adjacent).
//
// Pure (the JSON import is a static bundled dataset, no DB/network), so this lives
// in the pure test tier; the profile_settings read/write wrapper is in
// lib/settings/location.ts.

import zipCentroids from "./zip-centroids.json";

// The JSON infers each value as number[]; assert the [lat, lng] tuple shape.
const ZIP_CENTROIDS = zipCentroids as unknown as Record<
  string,
  [number, number]
>;

export interface HomeLocation {
  lat: number;
  lng: number;
}

export function isValidLat(n: number): boolean {
  return Number.isFinite(n) && n >= -90 && n <= 90;
}

export function isValidLng(n: number): boolean {
  return Number.isFinite(n) && n >= -180 && n <= 180;
}

// Round a coordinate to one decimal place (~11 km) — the coarse storage precision.
export function roundCoord(n: number): number {
  return Math.round(n * 10) / 10;
}

// Validate + coarsen a lat/lng pair, or null if either is out of range. This is the
// ONLY way a home location should be built for storage — it guarantees the coarse
// precision invariant.
export function normalizeHome(lat: number, lng: number): HomeLocation | null {
  if (!isValidLat(lat) || !isValidLng(lng)) return null;
  return { lat: roundCoord(lat), lng: roundCoord(lng) };
}

// Parse a stored/user string pair into a coarse HomeLocation, or null. Accepts
// numbers or numeric strings; blank/invalid → null (feature quietly absent).
export function parseHome(
  lat: string | number | null | undefined,
  lng: string | number | null | undefined
): HomeLocation | null {
  if (lat == null || lng == null || lat === "" || lng === "") return null;
  const la = typeof lat === "number" ? lat : Number(lat);
  const ln = typeof lng === "number" ? lng : Number(lng);
  return normalizeHome(la, ln);
}

// The 5-digit ZIP embedded in a free-text US postal-code string (handles the
// "12345-6789" ZIP+4 form and surrounding text), or null.
export function extractZip5(postal: string | null | undefined): string | null {
  if (typeof postal !== "string") return null;
  const m = /\b(\d{5})(?:-\d{4})?\b/.exec(postal.trim());
  return m ? m[1] : null;
}

// The coarse centroid for a US ZIP (ZCTA), or null when it's not a US ZIP we bundle
// (non-US postal codes stay manual). Accepts a bare ZIP or a "ZIP+4"/free-text
// string. Already coarse by construction (the dataset is rounded).
export function zipToHome(
  postal: string | null | undefined
): HomeLocation | null {
  const zip = extractZip5(postal);
  if (!zip) return null;
  const c = ZIP_CENTROIDS[zip];
  if (!c) return null;
  return { lat: c[0], lng: c[1] };
}
