// The unified save store's PURE layer (issue #1456). One gesture — the ★ star —
// answers one question ("does this matter to me?") for every savable kind, and one
// table (`saved_items`, migration 113) records the answer. This module owns the
// kind/key vocabulary and the ordering math; lib/queries/saved.ts owns the SQL.
//
// It replaces lib/trend-pins.ts, whose list math served a per-profile JSON KV
// (`trend_pins`) that has been folded into the table. The "metric:" / "bio:" PREFIXES
// survive here because they are ALSO the Trends series-key vocabulary (TrendSeries.key,
// the compare controls, and the digest's `digest:<series-key>:<direction>` dedupe keys
// all speak it) — but they are now just a rendering vocabulary that maps onto a
// (kind, key) pair, not a storage format.
//
// KIND SEMANTICS (kind-specific meaning is the whole point of a generic store):
//   • `biomarker` — key is the #482 canonical analyte name. Saved = it appears in the
//     Results → Biomarkers status card, earns a chart tile on Trends Overview, AND is
//     included in the profile passport summary. Membership, not position, drives all
//     three (the passport contract: lib/profile-summary-load.ts).
//   • `trend-metric` — key is a standard body/training metric id ("weight"). A save is
//     MEMBERSHIP here too, since #1487: Trends Overview renders the saved set and
//     nothing else, so unstarring a standard metric removes its tile (the metric stays
//     on its domain tab, and SaveTrendPicker offers it back). The four standard tiles
//     are default-saved SEEDS (lib/standard-metric-seeds.ts) rather than a hardcoded
//     sampler, which is what made the two kinds mean the same thing. Before that, a
//     metric save was PROMOTION only — every metric tile rendered either way.

export const SAVED_KINDS = ["biomarker", "trend-metric"] as const;
export type SavedKind = (typeof SAVED_KINDS)[number];

export function isSavedKind(value: string): value is SavedKind {
  return (SAVED_KINDS as readonly string[]).includes(value);
}

// A saved item's identity: its kind plus the kind's own key. Position is carried
// separately (it is presentation state, not identity).
export interface SavedRef {
  kind: SavedKind;
  key: string;
}

// The Trends series-key prefixes. A biomarker named "weight" can never collide with
// the weight metric tile because each carries its namespace.
export const METRIC_KEY_PREFIX = "metric:";
export const BIO_KEY_PREFIX = "bio:";

export function metricSeriesKey(id: string): string {
  return `${METRIC_KEY_PREFIX}${id}`;
}

export function bioSeriesKey(canonicalName: string): string {
  return `${BIO_KEY_PREFIX}${canonicalName}`;
}

// The canonical biomarker name a "bio:" series key points at, or null for other keys.
export function bioSeriesName(key: string): string | null {
  return key.startsWith(BIO_KEY_PREFIX)
    ? key.slice(BIO_KEY_PREFIX.length)
    : null;
}

// A Trends series key ("metric:weight" | "bio:LDL Cholesterol") → the saved-store ref
// it saves as, or null when the key names nothing savable (an unknown namespace, or an
// empty name after the prefix). This is the ONE place the two vocabularies meet.
export function savedRefFromSeriesKey(seriesKey: string): SavedRef | null {
  const trimmed = seriesKey.trim();
  if (trimmed.startsWith(BIO_KEY_PREFIX)) {
    const key = trimmed.slice(BIO_KEY_PREFIX.length).trim();
    return key ? { kind: "biomarker", key } : null;
  }
  if (trimmed.startsWith(METRIC_KEY_PREFIX)) {
    const key = trimmed.slice(METRIC_KEY_PREFIX.length).trim();
    return key ? { kind: "trend-metric", key } : null;
  }
  return null;
}

// The inverse: a saved ref → the Trends series key that renders it.
export function seriesKeyOfSavedRef(ref: SavedRef): string {
  return ref.kind === "biomarker"
    ? bioSeriesKey(ref.key)
    : metricSeriesKey(ref.key);
}

// Keys are matched case-insensitively everywhere (the store's `key` column is
// COLLATE NOCASE, inherited from the star store's NOCASE canonical_name), so a save on
// "apob" and one on "ApoB" are the same save.
export function sameSavedRef(a: SavedRef, b: SavedRef): boolean {
  return a.kind === b.kind && a.key.toLowerCase() === b.key.toLowerCase();
}

// Whether a Trends series key is currently saved.
export function isSeriesKeySaved(
  saved: readonly SavedRef[],
  seriesKey: string
): boolean {
  const ref = savedRefFromSeriesKey(seriesKey);
  if (!ref) return false;
  return saved.some((s) => sameSavedRef(s, ref));
}

// A stored row as the ordering math sees it: its ref plus the two sort inputs.
export interface SavedOrderRow extends SavedRef {
  position: number | null;
  created_at?: string | null;
}

// The canonical saved order: positioned rows first (ascending), then unpositioned ones
// newest-first by created_at — the star store's old "ORDER BY created_at DESC" for
// rows that never got an explicit position. Stable for equal keys (input order wins).
export function orderSavedRefs<T extends SavedOrderRow>(
  rows: readonly T[]
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ap = a.row.position;
      const bp = b.row.position;
      if (ap != null && bp != null) return ap - bp || a.index - b.index;
      if (ap != null) return -1;
      if (bp != null) return 1;
      const at = a.row.created_at ?? "";
      const bt = b.row.created_at ?? "";
      if (at !== bt) return at < bt ? 1 : -1; // newest first
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

// Move one entry of an ordered list one slot earlier ("up") or later ("down"),
// returning a NEW list. A move off either end is a no-op (the caller renders the
// affordance disabled, but a direct POST must not throw or wrap around), as is an
// index that isn't in the list.
export function moveInOrder<T>(
  list: readonly T[],
  index: number,
  direction: "up" | "down"
): T[] {
  const out = [...list];
  if (!Number.isInteger(index) || index < 0 || index >= out.length) return out;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= out.length) return out;
  [out[index], out[target]] = [out[target], out[index]];
  return out;
}
