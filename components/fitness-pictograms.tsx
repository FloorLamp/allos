// Fitness-check pictograms (#1253) — the rendering half of the pictogram asset
// class. Hand-authored inline SVG (no icon pack, no raster): one figure per battery
// test plus one abstract glyph per domain, path data in lib/fitness-pictograms.ts
// (pure, so the battery⇆pictogram totality test runs in the pure tier — the
// lib/muscle-anatomy-paths.ts split). Every surface (heat-grid tile, entry modal,
// domain chip, "By domain" bars) renders through THESE two components, never a
// per-surface copy.
//
// House contract: 24×24 viewBox, stroke="currentColor" at 1.75 with round
// caps/joins, no fills — the figure inherits the tile tone's text color in light
// and dark, and the stale opacity/grayscale treatment applies for free. Decorative
// only (`aria-hidden`): the tile's text label/overlay stays the accessible name —
// the #1249 "never color-only" grid must not become icon-only either.
//
// No hooks/handlers, so they render in Server Component hosts (FitnessDomainBars)
// and client trees (FitnessCheckView) alike.

import {
  FITNESS_DOMAIN_GLYPH_PATHS,
  FITNESS_PICTOGRAM_PATHS,
  resolveFitnessPictogram,
} from "@/lib/fitness-pictograms";
import type { FitnessDomain } from "@/lib/fitness-battery";

const STROKE_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

// The per-test figure. An unknown/future test key renders the neutral fallback
// figure (resolveFitnessPictogram) — never a crash.
export function FitnessPictogram({
  testKey,
  className = "h-7 w-7",
}: {
  testKey: string;
  className?: string;
}) {
  const key = resolveFitnessPictogram(testKey);
  return (
    <svg
      {...STROKE_PROPS}
      className={className}
      data-testid={`fitness-pictogram-${testKey}`}
      data-pictogram={key}
    >
      {FITNESS_PICTOGRAM_PATHS[key].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

// The per-domain glyph (tile domain chips + the "By domain" bar labels).
export function FitnessDomainGlyph({
  domain,
  className = "h-3.5 w-3.5",
}: {
  domain: FitnessDomain;
  className?: string;
}) {
  return (
    <svg
      {...STROKE_PROPS}
      className={className}
      data-testid={`fitness-domain-glyph-${domain}`}
    >
      {FITNESS_DOMAIN_GLYPH_PATHS[domain].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
