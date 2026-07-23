// The persisted multi-profile VIEW-SET, pure (issue #1096).
//
// A session's view-set is stored as JSON on `sessions.view_profile_ids` (migration
// 101) — a small array of profile ids, or NULL for the default single-view. This
// module owns the parse / serialize / toggle of that raw stored value; it does NO
// validation against grants (that is resolveScope's job, on every read — the raw set
// is untrusted and re-intersected with the caller's accessible set there). Keeping
// these pure lets the storage round-trip be unit-tested without a DB or a session.

// Parse the stored JSON into a de-duplicated, positive-integer id array. Anything
// malformed (NULL, non-JSON, non-array, non-integer members) yields [] — a stored
// value can never crash a read, and a garbage value degrades to the single-view
// default (resolveScope maps [] → [actingProfileId]). Order is preserved as stored;
// resolveScope re-orders to the accessible order anyway.
export function parseViewProfileIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of parsed) {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Serialize a view-set for storage, or NULL when it is the single-view default (the
// set is exactly the acting profile, or empty). Storing NULL for the default keeps a
// never-touched session indistinguishable from an un-migrated one — zero-regression
// rollout — and avoids persisting a redundant single-element array. The ids are NOT
// grant-validated here; the write path validates before calling this.
export function serializeViewProfileIds(
  ids: readonly number[],
  actingProfileId: number
): string | null {
  const clean = parseViewProfileIds(JSON.stringify([...ids]));
  if (clean.length === 0) return null;
  if (clean.length === 1 && clean[0] === actingProfileId) return null;
  return JSON.stringify(clean);
}

// Toggle one profile id in/out of a view-set. The acting profile is ALWAYS retained
// in the view (a multi-view page must always show the profile it is acting as — you
// cannot "hide yourself"), so toggling the acting id off is a no-op. Returns a new
// array; does not mutate the input.
export function toggleViewId(
  current: readonly number[],
  profileId: number,
  actingProfileId: number
): number[] {
  const base = current.length === 0 ? [actingProfileId] : [...current];
  if (profileId === actingProfileId) {
    // Ensure the acting profile is present; never removable.
    return base.includes(actingProfileId) ? base : [actingProfileId, ...base];
  }
  if (base.includes(profileId)) {
    return base.filter((id) => id !== profileId);
  }
  return [...base, profileId];
}
