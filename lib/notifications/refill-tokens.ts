// THE REFILL-SNOOZE TOKEN FAMILY (issue #2961 step 2) — `rfsnooze:`. Carved off
// `callback-data.ts` verbatim; no imports. The answer text stays beside the handler's
// outcome type until step 3 moves the handler.

// ---- Phase 3: refill-nudge snooze button (issue #233) ----
// 📦 Ordered — remind me in 3 days → bus snooze via refillSignalKey (#227). No
// "mark refilled" button: that needs an amount, which a button handles badly (a
// deep-link opens the form instead). The token carries the (integer, never-
// recycled) intake-item id.

export interface RefillCallback {
  profileId: number;
  itemId: number;
}

// Parse a "rfsnooze:<profileId>:<itemId>" token. Malformed → null.
export function parseRefillCallback(data: unknown): RefillCallback | null {
  if (typeof data !== "string" || !data.startsWith("rfsnooze:")) return null;
  const [, profStr, itemStr] = data.split(":");
  const profileId = Number(profStr);
  const itemId = Number(itemStr);
  if (!profileId || !itemId) return null;
  return { profileId, itemId };
}
