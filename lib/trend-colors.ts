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

// The bucket a name hashes to, modulo `mod`. The shared name-hash behind every
// deterministic per-entity color: identity follows the ENTITY, never its rank/
// position, so a series keeps its color across renders (issue #406).
export function nameHashIndex(name: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % mod;
}

// Stable per-name color via an 8-bucket name hash.
export function bioColor(name: string): string {
  return BIO_COLORS[nameHashIndex(name, BIO_COLORS.length)];
}

// Assign a stable, per-name color to each entity in a set, de-colliding WITHIN the
// visible set (issue #406). Color follows the name hash — NOT volume rank — so an
// activity that changes rank between views keeps its color; the caller keeps rank
// for legend/stack ORDER only. De-collision is deterministic (names processed in
// sorted order, independent of the caller's rank order): a name takes its hashed
// color when free, else probes forward to the next unused palette entry. Once the
// visible set exceeds the palette, further names accept their hashed color (a
// collision is unavoidable). Returns name → color for every input name.
export function assignHashedColors(
  names: string[],
  palette: readonly string[] = BIO_COLORS
): Map<string, string> {
  const out = new Map<string, string>();
  if (palette.length === 0) return out;
  const used = new Set<string>();
  for (const name of [...new Set(names)].sort()) {
    const start = nameHashIndex(name, palette.length);
    let color = palette[start];
    if (used.size < palette.length) {
      let i = 0;
      while (used.has(color) && i < palette.length) {
        color = palette[(start + ++i) % palette.length];
      }
    }
    used.add(color);
    out.set(name, color);
  }
  return out;
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
