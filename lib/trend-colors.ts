// Deterministic biomarker chart colors. Pure (no DB/query imports) so the Compare
// overlay's color logic is unit-testable — trends-series re-exports these but also
// pulls in the profile-scoped query layer, which opens the DB at import.

// A small deterministic palette so a biomarker gets a stable color across renders.
export const BIO_COLORS = [
  "#2563eb",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#ca8a04",
  "#db2777",
  "#059669",
  "#ea580c",
] as const;

// Stable per-name color via an 8-bucket name hash.
export function bioColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return BIO_COLORS[h % BIO_COLORS.length];
}

// The 8-bucket hash can hand two compared biomarkers the SAME color, so both
// Compare lines (and, when unit-matched, both sharing one axis) draw
// indistinguishably (issue #400). When `color` collides with `avoid`, pick the
// first palette entry that differs so the two series stay visually separable;
// otherwise return `color` unchanged. Pure — the caller passes both resolved
// colors. Falls back to the original color only in the degenerate case of a
// single-color palette.
export function deCollideColor(
  color: string,
  avoid: string,
  palette: readonly string[] = BIO_COLORS
): string {
  if (color !== avoid) return color;
  return palette.find((c) => c !== avoid) ?? color;
}
