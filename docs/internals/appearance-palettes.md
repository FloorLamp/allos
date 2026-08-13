# Appearance palettes

Issue #2701. The theme redesign shipped as a palette system: the old Vitals
look (sage gradient, green glow, dot texture, frosted-glass cards) is retired,
**Botanical** is the base theme, and **Almanac** and **Floodlight** are the two
selectable palettes. Palette is orthogonal to light/dark/system mode: three
palettes × two modes, six combinations, all first-class.

## Architecture: tokens re-point, call sites never sweep

Tailwind v4 compiles every color utility to a CSS-variable reference
(`text-slate-800` → `var(--color-slate-800)`, `bg-white/55` → `color-mix` over
`var(--color-white)`), so re-pointing a variable under a scope re-themes every
call site with no sweep. A palette is therefore two bounded things in
`app/globals.css`:

1. **Ramp re-points** — `brand` (accent: green / olive-lime / amber-orange),
   `slate` (green-greys / warm greys / true neutrals), `ink` (green-black /
   warm-black / neutral-black), plus exactly the amber/rose/emerald steps the
   `NOTICE_TONE` family reads (50/300/800 light, 950/900/200 dark). One ramp
   serves both modes because light reads the low steps and dark the high ones.
2. **Semantic chokepoint tokens** — `--canvas`, `--surface`, `--border`,
   `--divider`, `--card-shadow`, `--btn`/`--btn-fg`, `--ghost`, `--field`,
   `--field-bd`, `--seg-*`, `--radius-card`, `--radius-control`, `--chevron`,
   `--font-display`, … — consumed by the structural primitives (`body`,
   `.card`, `.card-quiet`, the `.btn` family, `.input`, `SegmentedControl`).

Every scope lives ON `:root` (the `dark` class and the `data-palette` attribute
are both stamped on `<html>`), which is what makes var() substitution correct:
the winning values are always resolved on the same element. The base palette is
the **absence** of the attribute — `paletteAttribute()` in `lib/theme.ts` is
the one rule, and it answers `null` for Botanical so a stale attribute is
removed, never overwritten with a third value.

Dark token blocks are wrapped in `@media not print`, mirroring the `dark`
variant's own posture, so printing from a dark session still produces the light
passport. In print a palette contributes only its display font: no texture, no
underline, no ticks, no skew.

## Plumbing (follows the theme doctrine, #1906/#2183)

- `PALETTE_STORAGE_KEY` (`"palette"`) lives beside `theme` in `lib/theme.ts`;
  `normalizePaletteChoice` collapses anything unrecognised to the base.
- The boot script stamps `data-palette` pre-paint; `lib/__tests__/theme.test.ts`
  executes it against `paletteAttribute` so the transcription cannot drift.
- `ThemeReassert` re-asserts the attribute post-hydration and on route changes.
- `app/global-error.tsx` reads the same storage key: `errorCardPalette(dark,
palette)` carries all six combinations, so the error card is recognisably the
  app the user was in even with globals.css gone.
- Settings → Display → **Appearance** (`components/AppearancePicker.tsx`) is
  the device-scoped picker with swatch previews. Per-login sync is deferred.
- The offline shell restates Botanical dark as literals: a script-less page can
  never receive the attribute, so it is always the base palette, by design.
- `app/manifest.ts` and the `themeColor` viewport export speak the base
  palette's canvases (they are static and cannot follow the attribute).

## Design rules the CSS encodes

- **Field boundaries are their own token** (`--field-bd`) at ≥3:1 in all six
  combinations (WCAG 1.4.11) — the atmospheric card border may not double as an
  input edge.
- **Two card tiers**: `.card` (palette shadow) for content modules,
  `.card-quiet` (border only) for repeated list items.
- **Tone-on-tone palettes border their badges**: the base `.badge` wears a
  border mixed from its own text tone (`color-mix` over `currentColor`); the
  high-contrast palettes zero `--badge-bd` back out.
- **Shadow rule**: decorative offsets are light-only (Floodlight's hard amber
  offset dies in its dark twin); functional elevation shadows — menus, dialogs,
  sheets, toasts — keep their shadow in BOTH modes, because a floating
  surface's shadow is information. Those elevation surfaces paint `bg-surface`
  (and form fields `bg-field`), the two semantic utilities from `@theme inline`.
- **No gradients on buttons**; solid `--btn` fills with per-mode hovers.
- **Floodlight doctrine**: emphasis honesty (a filled black/amber chip means
  interactive/selected; marks may underlap text, never contain it), skew only
  on standalone chips — the segmented control dissolves its container so the
  selected tab is the ONE skewed chip — and buttons and digits never slant.
  Skews are off under `prefers-reduced-motion` and in print.

## Charts

`PALETTES` in `lib/chart-colors.ts` is the per-palette token→hex map (it must
mirror globals.css's ramp blocks); the cell-ramp hex tables are DERIVED from
its base column, and `lib/__tests__/chart-palette.test.ts` runs a 3-palette ×
2-mode matrix: series contrast on every surface, cell-ramp monotonicity and
separation, adherence-state separation, the muscle-anatomy ramp (which paints
`var(--color-brand-600)` and is validated per palette), and Floodlight's
declared accent/amber-series adjacency. `components/useChartColors.ts` watches
`data-palette` alongside the `dark` class and derives scaffolding colors from
the same map. See `docs/internals/charts.md`.

## Testing

- `lib/__tests__/theme.test.ts` — boot script ≡ `paletteAttribute`, error cards
  across all six combinations pinned to the stylesheet's canvases.
- `lib/__tests__/chart-palette.test.ts` — the validator matrix above.
- `e2e/appearance-palette.spec.ts` — pick → applies live → survives reload and
  route change; the base choice REMOVES the attribute.
- `e2e/theme-reassert.spec.ts` — the script-less offline shell paints the base
  palette's dark canvas.
