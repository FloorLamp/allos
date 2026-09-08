// Breakpoint names follow Tailwind. Keep maxMd's existing fractional boundary:
// it is not exactly the inverse of md on a fractionally sized viewport.
export const MEDIA_QUERIES = {
  sm: "(min-width: 640px)",
  md: "(min-width: 768px)",
  xl: "(min-width: 1280px)",
  maxMd: "(max-width: 767.98px)",
  reducedMotion: "(prefers-reduced-motion: reduce)",
  standalone: "(display-mode: standalone)",
  dark: "(prefers-color-scheme: dark)",
} as const;

export type MediaQuery = keyof typeof MEDIA_QUERIES;
