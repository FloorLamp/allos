import { encodedPolylineToSvg } from "@/lib/polyline";

// Tile-free SVG route thumbnail (issue #569). Decodes the activity's encoded GPS
// polyline and draws its SHAPE as an SVG <path> scaled to its bounding box — the
// Strava-feed-thumbnail look, no basemap. NOTHING is fetched: a route reveals a
// home address, so it must never hit a tile CDN; this keeps the app's
// `img-src 'self'` / `connect-src 'self'` CSP untouched and theme-styles trivially
// (the stroke uses currentColor / the brand token, no external font or image).
//
// Server-safe (pure render over the decoded points). Renders nothing when the
// polyline yields no drawable route, so callers can drop it in unconditionally.
export default function RouteMap({
  polyline,
  size = 120,
  width,
  height,
  className,
  title = "Activity route",
}: {
  polyline: string | null | undefined;
  size?: number;
  // Optional non-square canvas for compact feed strips. `size` remains the
  // backwards-compatible square default used by existing render sites.
  width?: number;
  height?: number;
  className?: string;
  title?: string;
}) {
  const routeWidth = width ?? size;
  const routeHeight = height ?? size;
  const route = encodedPolylineToSvg(polyline, {
    width: routeWidth,
    height: routeHeight,
    padding: 6,
  });
  if (!route) return null;
  const start = route.points[0];
  const end = route.points[route.points.length - 1];
  return (
    <svg
      viewBox={`0 0 ${route.width} ${route.height}`}
      width={routeWidth}
      height={routeHeight}
      role="img"
      aria-label={title}
      data-testid="route-map"
      className={
        className ??
        "rounded-md border border-black/10 bg-slate-50 text-brand-600 dark:border-white/10 dark:bg-ink-900 dark:text-brand-400"
      }
    >
      <title>{title}</title>
      <path
        d={route.d}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Start (hollow) and end (filled) markers, like a route feed thumbnail. */}
      <circle
        cx={start.x}
        cy={start.y}
        r={3}
        fill="var(--color-surface, #fff)"
        stroke="currentColor"
        strokeWidth={2}
      />
      <circle cx={end.x} cy={end.y} r={3} fill="currentColor" />
    </svg>
  );
}
