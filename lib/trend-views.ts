// Saved views for the Trends hub. A named snapshot of the
// hub's state — the date range, active tab, compare pair, and the pinned-tile set
// — so a user can flip between e.g. "Lipids review" and "Cut progress" without
// rebuilding the view each time.
//
// Stored per-profile as a JSON array in profile_settings (key "trend_views"), the
// same precedent as trend_pins — NO owned table. Everything here is pure list math
// (validate / normalize / add / rename / delete) plus the mapping to the URL params
// the hub already reads (?from/to/tab/cmpA/cmpB/cmpn); unit-tested. The settings
// layer only (de)serializes it.

import { normalizePins } from "./trend-pins";

// The captured hub state. Every field is optional so a view can pin down as much
// or as little as the user had set (an unset field just isn't restored).
export interface TrendViewParams {
  from?: string;
  to?: string;
  tab?: string;
  cmpA?: string;
  cmpB?: string;
  cmpn?: boolean;
  // Snapshot of the pinned-tile keys at save time (restored on apply).
  pins?: string[];
}

export interface TrendView {
  name: string;
  params: TrendViewParams;
}

// Bounds so a corrupt/oversized post can't bloat the stored blob.
export const MAX_VIEWS = 24;
const MAX_NAME_LEN = 60;
const MAX_PARAM_LEN = 40;

const cleanStr = (v: unknown, max = MAX_PARAM_LEN): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};

// Coerce an arbitrary object into a well-formed params bag, dropping anything
// unrecognized or malformed. Pins are run through normalizePins (trim/dedupe).
export function normalizeViewParams(raw: unknown): TrendViewParams {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const out: TrendViewParams = {};
  const from = cleanStr(r.from);
  const to = cleanStr(r.to);
  const tab = cleanStr(r.tab);
  const cmpA = cleanStr(r.cmpA, 120);
  const cmpB = cleanStr(r.cmpB, 120);
  if (from) out.from = from;
  if (to) out.to = to;
  if (tab) out.tab = tab;
  if (cmpA) out.cmpA = cmpA;
  if (cmpB) out.cmpB = cmpB;
  if (r.cmpn === true || r.cmpn === "1") out.cmpn = true;
  if (Array.isArray(r.pins)) {
    const pins = normalizePins(
      r.pins.filter((x): x is string => typeof x === "string")
    );
    if (pins.length) out.pins = pins;
  }
  return out;
}

// A single view is valid iff it has a non-empty name; the name is trimmed + capped.
// Returns null for an unusable entry so normalizeViews can drop it.
export function normalizeView(raw: unknown): TrendView | null {
  const r =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r) return null;
  const name = cleanStr(r.name, MAX_NAME_LEN);
  if (!name) return null;
  return { name, params: normalizeViewParams(r.params) };
}

// Normalize a whole list: clean each entry, drop the invalid, de-dupe by name
// (case-insensitive, keeping the FIRST occurrence — the render order), cap count.
export function normalizeViews(list: unknown): TrendView[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: TrendView[] = [];
  for (const raw of list) {
    const v = normalizeView(raw);
    if (!v) continue;
    const key = v.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_VIEWS) break;
  }
  return out;
}

// Add (or overwrite) a view by name: an existing same-name (case-insensitive)
// entry is replaced IN PLACE so re-saving updates it without reordering; a new one
// is appended. Capped to MAX_VIEWS by dropping the OLDEST when full. Input is not
// mutated.
export function addView(
  list: readonly TrendView[],
  view: TrendView
): TrendView[] {
  const clean = normalizeView(view);
  if (!clean) return normalizeViews(list as unknown);
  const key = clean.name.toLowerCase();
  const existingIdx = list.findIndex((v) => v.name.toLowerCase() === key);
  let next: TrendView[];
  if (existingIdx >= 0) {
    next = list.slice();
    next[existingIdx] = clean;
  } else {
    next = [...list, clean];
  }
  const normalized = normalizeViews(next as unknown);
  // normalizeViews caps by dropping from the END; when appending a fresh view that
  // overflows, drop the OLDEST instead so the new one survives.
  if (existingIdx < 0 && next.length > MAX_VIEWS) {
    return normalizeViews(next.slice(next.length - MAX_VIEWS) as unknown);
  }
  return normalized;
}

// Delete a view by name (case-insensitive). Input is not mutated.
export function deleteView(
  list: readonly TrendView[],
  name: string
): TrendView[] {
  const key = name.trim().toLowerCase();
  return normalizeViews(
    list.filter((v) => v.name.toLowerCase() !== key) as unknown
  );
}

// Rename a view (case-insensitive match on the old name). A no-op when the old
// name isn't found or the new name is blank; if the new name collides with another
// view, normalizeViews de-dupes (keeping the renamed entry's position). Not mutating.
export function renameView(
  list: readonly TrendView[],
  oldName: string,
  newName: string
): TrendView[] {
  const key = oldName.trim().toLowerCase();
  const nextName = newName.trim().slice(0, MAX_NAME_LEN);
  if (!nextName) return normalizeViews(list as unknown);
  return normalizeViews(
    list.map((v) =>
      v.name.toLowerCase() === key ? { ...v, name: nextName } : v
    ) as unknown
  );
}

// Find a view by name (case-insensitive), or null.
export function findView(
  list: readonly TrendView[],
  name: string
): TrendView | null {
  const key = name.trim().toLowerCase();
  return list.find((v) => v.name.toLowerCase() === key) ?? null;
}

// Parse the stored JSON blob into a clean view list (never throws → []).
export function parseViews(raw: string | null | undefined): TrendView[] {
  if (!raw) return [];
  try {
    return normalizeViews(JSON.parse(raw));
  } catch {
    return [];
  }
}

// Serialize a view list for storage (normalized first).
export function serializeViews(list: readonly TrendView[]): string {
  return JSON.stringify(normalizeViews(list as unknown));
}

// Build the hub's query string for a view's params, reusing the EXISTING param
// vocabulary (?from/to/tab/cmpA/cmpB/cmpn) so applying a view round-trips through
// the same URL the DateRangeControl / CompareControls already write. "overview" is
// the default tab, so it's dropped. Pins are restored separately (a per-profile
// write), not carried in the URL. Returns "" when no params are set.
export function viewToQuery(params: TrendViewParams): string {
  const sp = new URLSearchParams();
  if (params.tab && params.tab !== "overview") sp.set("tab", params.tab);
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.cmpA) sp.set("cmpA", params.cmpA);
  if (params.cmpB) sp.set("cmpB", params.cmpB);
  if (params.cmpn) sp.set("cmpn", "1");
  return sp.toString();
}
