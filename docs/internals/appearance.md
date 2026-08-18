# Appearance

Allos uses one visual language: Botanical. Users can choose light, dark, or
system mode; there are no separate selectable color palettes.

## Tokens and primitives

`app/globals.css` owns the Botanical color ramps and semantic surface tokens.
Shared primitives such as `.card`, `.card-quiet`, `.input`, the button family,
badges, and segmented controls consume semantic tokens instead of restating
surface colors. This keeps both modes coherent and makes contrast review
tractable.

The main structural tokens are:

- `--canvas`, `--canvas-base`, and `--nav` for page and navigation grounds
- `--surface`, `--border`, `--divider`, and `--card-shadow` for cards
- `--field` and `--field-bd` for form controls
- `--btn`, `--ghost`, and their foreground/hover pairs for actions
- `--seg-*` for segmented controls

Form boundaries use a stronger token than atmospheric card borders so controls
remain identifiable at 3:1 in light and dark. The dark mode is selected through
the `dark` class on `<html>`; `lib/theme.ts` owns that decision and its pre-paint
boot script.

## Charts and exceptional surfaces

Chart marks and Recharts scaffolding need literal colors because CSS utilities
cannot reach every SVG attribute. Their values live in `lib/chart-colors.ts`
and `components/useChartColors.ts` and are validated against Botanical's real
light and dark card surfaces. See `docs/internals/charts.md` for the checks.

The root error boundary and script-less offline shell may render without the
normal stylesheet or theme class. They restate the same Botanical light/dark
colors as literals and have focused tests to prevent drift.
