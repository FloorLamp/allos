// Pure Google "encoded polyline" decoder + a tile-free SVG projection for route
// thumbnails (issue #569). No dependency, no external request: we decode the
// polyline Strava already delivers and draw the route's SHAPE as an SVG path
// scaled to its bounding box — the Strava-feed-thumbnail look, no basemap. This
// keeps the app's `img-src 'self'` / `connect-src 'self'` CSP untouched (a
// route reveals a home address, so it must never be fetched from a tile CDN).
//
// Pure functions only (no DB/DOM), so this lives in the pure vitest tier; the
// rendering component (components/RouteMap.tsx) is a thin formatter over
// polylineToSvg().

// A decoded coordinate: [lat, lng] in degrees. Mirrors Strava's [lat, lng] order.
export type LatLng = [number, number];

// Decode a Google encoded polyline (https://developers.google.com/maps/documentation/
// utilities/polylinealgorithm) into [lat, lng] pairs. `precision` is the number of
// decimal places the encoder used (Google/Strava use 5). Tolerant: returns [] for a
// non-string or empty input, and stops cleanly at the end of the buffer.
export function decodePolyline(
  encoded: string | null | undefined,
  precision = 5
): LatLng[] {
  if (typeof encoded !== "string" || encoded.length === 0) return [];
  // Bind to a const after the guard so the nested closure sees a `string` (a
  // function parameter's narrowing is lost inside a closure).
  const enc: string = encoded;
  const factor = Math.pow(10, precision);
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const len = enc.length;

  // Read one signed varint (the polyline delta encoding) starting at `index`.
  function readDelta(): number | null {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= len) return null; // truncated — stop cleanly
      byte = enc.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    // The sign is stored in the least-significant bit (zigzag).
    return result & 1 ? ~(result >> 1) : result >> 1;
  }

  while (index < len) {
    const dLat = readDelta();
    if (dLat == null) break;
    const dLng = readDelta();
    if (dLng == null) break;
    lat += dLat;
    lng += dLng;
    points.push([lat / factor, lng / factor]);
  }
  return points;
}

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

// Bounding box of a set of points, or null when empty.
export function routeBounds(points: LatLng[]): Bounds | null {
  if (points.length === 0) return null;
  let minLat = Infinity,
    maxLat = -Infinity,
    minLng = Infinity,
    maxLng = -Infinity;
  for (const [lat, lng] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

export interface SvgPoint {
  x: number;
  y: number;
}

export interface SvgRoute {
  // The `d` attribute of an SVG <path> tracing the route.
  d: string;
  // Projected points (same order as input) for callers that want markers.
  points: SvgPoint[];
  // The viewBox dims the projection was fit into.
  width: number;
  height: number;
}

export interface ProjectOptions {
  width?: number; // viewBox width (default 100)
  height?: number; // viewBox height (default 100)
  padding?: number; // inner padding in viewBox units (default 4)
}

// Project decoded [lat, lng] points into an SVG coordinate space fit to their
// bounding box. Uses an equirectangular projection with longitude scaled by
// cos(meanLat) so the route keeps a correct aspect ratio at city scale (a degree
// of longitude is shorter than a degree of latitude away from the equator). North
// is up (SVG y grows downward, so latitude is flipped). The route is centered and
// letterboxed inside width×height (minus padding), preserving aspect. Returns null
// when there aren't at least two distinct points to draw.
export function polylineToSvg(
  points: LatLng[],
  opts: ProjectOptions = {}
): SvgRoute | null {
  const width = opts.width ?? 100;
  const height = opts.height ?? 100;
  const padding = opts.padding ?? 4;
  const bounds = routeBounds(points);
  if (!bounds || points.length < 2) return null;

  const meanLat = (bounds.minLat + bounds.maxLat) / 2;
  const lngScale = Math.max(Math.cos((meanLat * Math.PI) / 180), 1e-6);

  // World-space extents (lng compressed by lngScale), guarded against a zero span
  // (a straight N–S or E–W route, or a point).
  const spanX = Math.max((bounds.maxLng - bounds.minLng) * lngScale, 1e-9);
  const spanY = Math.max(bounds.maxLat - bounds.minLat, 1e-9);

  const availW = width - 2 * padding;
  const availH = height - 2 * padding;
  const scale = Math.min(availW / spanX, availH / spanY);
  // Centering offsets so the scaled route sits in the middle of the box.
  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offX = padding + (availW - drawnW) / 2;
  const offY = padding + (availH - drawnH) / 2;

  const projected: SvgPoint[] = points.map(([lat, lng]) => {
    const wx = (lng - bounds.minLng) * lngScale;
    const wy = bounds.maxLat - lat; // flip: north up
    return {
      x: round2(offX + wx * scale),
      y: round2(offY + wy * scale),
    };
  });

  const d = projected
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`)
    .join(" ");

  return { d, points: projected, width, height };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Convenience: decode + project in one call. Returns null when the polyline yields
// no drawable route.
export function encodedPolylineToSvg(
  encoded: string | null | undefined,
  opts: ProjectOptions = {}
): SvgRoute | null {
  return polylineToSvg(decodePolyline(encoded), opts);
}
