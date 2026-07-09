// The Allos mark — a single continuous line that rises and settles like an
// allostatic wave (stability through change). Unlike the old filled "W", this is
// a *stroked* open path, so consumers must render it with `fill="none"` and a
// stroke of LOGO_STROKE_WIDTH. Single source of truth for the geometry so the
// sidebar/mobile wordmark (components/Wordmark.tsx), the login page, and the
// generated app icons stay in sync. app/icon.svg is a static file and inlines the
// same path + gradient — keep it matching.
export const LOGO_VIEWBOX = "48 12 164 106";
export const LOGO_PATH =
  "m59.9 107c7.7 0 12.3-4.1 12.3-12.2 0-2.5 0-12.6 0-16.1 0-16.8 28.3-16.8 28.3-0.4 0 2.9 0.3 12.6 0.3 16.2 0 17.6 28.7 16.8 28.7-0.5 0-8.3 0.2-50.1 0.2-58.6 0-15.7 28.1-15.9 28.1-0.4 0 12.1-0.1 21.6-0.1 37.5 0 17.1 28.5 17.4 28.5 0.8 0-3.8 0.1-10 0.1-13.6 0-9.5 3.9-15.8 13.7-15.8";
// The mark is drawn as a stroke, not a fill.
export const LOGO_STROKE_WIDTH = 12;
// Brand gradient (blue → brand green), painted left-to-right across the mark.
export const LOGO_GRADIENT_FROM = "#3a7dac";
export const LOGO_GRADIENT_TO = "#22c55e";
