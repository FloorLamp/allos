// Pin-to-Trends. A profile can pin specific Overview tiles
// — the standard body/training metrics ("metric:weight") and individual
// biomarkers ("bio:LDL Cholesterol") — so they persist at the TOP of the Trends
// Overview across sessions. The pin list is stored per-profile as a JSON array in
// profile_settings (key "trend_pins", via lib/settings), so no owned SQL table is
// added. Everything here is pure list math (parse / toggle / order) and unit-
// tested; the settings layer only (de)serializes it.

// Pin keys are opaque strings; these prefixes namespace the two kinds so a
// biomarker named "weight" can never collide with the weight metric tile.
export const METRIC_PIN_PREFIX = "metric:";
export const BIO_PIN_PREFIX = "bio:";

export function metricPinKey(id: string): string {
  return `${METRIC_PIN_PREFIX}${id}`;
}

export function bioPinKey(canonicalName: string): string {
  return `${BIO_PIN_PREFIX}${canonicalName}`;
}

// The canonical biomarker name a "bio:" pin points at, or null for other keys.
export function bioPinName(key: string): string | null {
  return key.startsWith(BIO_PIN_PREFIX)
    ? key.slice(BIO_PIN_PREFIX.length)
    : null;
}

// Normalize a raw pin list: trim, drop empties, and de-dupe while preserving the
// FIRST occurrence's order (the order pins were added, which is the render order).
// Biomarker keys de-dupe case-insensitively on the name so "bio:LDL" and "bio:ldl"
// don't both pin the same biomarker; the first spelling seen is kept.
export function normalizePins(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key) continue;
    const name = bioPinName(key);
    const dedupeKey =
      name != null ? `${BIO_PIN_PREFIX}${name.toLowerCase()}` : key;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(key);
  }
  return out;
}

// Parse the stored JSON blob into a clean pin list. Any malformed/legacy shape
// yields an empty list (never throws) so the Overview falls back to its default
// ordering rather than erroring — mirrors getDashboardLayout's defensive read.
export function parsePins(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizePins(
      parsed.filter((x): x is string => typeof x === "string")
    );
  } catch {
    return [];
  }
}

// Serialize a pin list for storage (normalized first, so a corrupt post can't
// bloat or duplicate the blob).
export function serializePins(list: readonly string[]): string {
  return JSON.stringify(normalizePins(list));
}

// Whether a key is currently pinned (case-insensitive for biomarker keys).
export function isPinned(pins: readonly string[], key: string): boolean {
  const target = bioPinName(key);
  if (target == null) return pins.includes(key);
  const targetLc = target.toLowerCase();
  return pins.some((p) => bioPinName(p)?.toLowerCase() === targetLc);
}

// Toggle a key: remove it if already pinned (case-insensitive for biomarkers),
// otherwise append it to the END so newly pinned tiles land after existing ones.
// Returns a new normalized list; the input is not mutated.
export function togglePin(pins: readonly string[], key: string): string[] {
  const trimmed = key.trim();
  if (!trimmed) return normalizePins(pins);
  if (isPinned(pins, trimmed)) {
    const name = bioPinName(trimmed);
    const nameLc = name?.toLowerCase();
    return normalizePins(
      pins.filter((p) =>
        name != null ? bioPinName(p)?.toLowerCase() !== nameLc : p !== trimmed
      )
    );
  }
  return normalizePins([...pins, trimmed]);
}

// Partition a list of keyed items into pinned (in PIN order — the order they were
// pinned) and unpinned (in their original order). An item whose key isn't pinned
// stays put; a pinned key with no matching item is skipped (e.g. a pinned
// biomarker that lost all its readings). This is what renders pinned tiles first.
export function partitionPinned<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  pins: readonly string[]
): { pinned: T[]; unpinned: T[] } {
  const byKey = new Map<string, T>();
  const byBioNameLc = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    byKey.set(key, item);
    const name = bioPinName(key);
    if (name != null) byBioNameLc.set(name.toLowerCase(), item);
  }
  const pinnedItems: T[] = [];
  const claimed = new Set<T>();
  for (const pin of pins) {
    const name = bioPinName(pin);
    const found =
      name != null ? byBioNameLc.get(name.toLowerCase()) : byKey.get(pin);
    if (found && !claimed.has(found)) {
      claimed.add(found);
      pinnedItems.push(found);
    }
  }
  const unpinned = items.filter((item) => !claimed.has(item));
  return { pinned: pinnedItems, unpinned };
}
