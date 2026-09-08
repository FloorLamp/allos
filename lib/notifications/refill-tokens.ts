// THE REFILL-SNOOZE TOKEN FAMILY (issue #2961 step 2) — `rfsnooze:`. Carved off
// `callback-data.ts` verbatim; no imports. The answer text stays beside the handler's
// outcome type until step 3 moves the handler.

// ---- Phase 3: refill-nudge snooze button (issue #233) ----
// Ordered snoozes via refillSignalKey (#227). Its token carries the integer,
// never-recycled intake-item id; Received binds a stored receipt operation.

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

export function parseRefillReplyMarker(
  text: string | undefined
): { profileId: number; offerId: number } | null {
  const match = text?.match(/\(refill:([1-9]\d*):([1-9]\d*)\)/);
  return match
    ? { profileId: Number(match[1]), offerId: Number(match[2]) }
    : null;
}

export function parseReceivedAmount(text: string | undefined): number | null {
  const value = text?.trim();
  if (!value || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
