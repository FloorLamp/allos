import { REFILL_GENERATION_PATTERN } from "../refill-nudge";

// ---- Phase 3: refill-nudge snooze button (issue #233) ----
// Ordered snoozes via refillSignalKey (#227). Its token carries the integer,
// never-recycled intake-item id; Received binds a stored receipt operation.

export interface RefillCallback {
  profileId: number;
  itemId: number;
}

export interface OrderedRefillCallback extends RefillCallback {
  generation: string;
  cancel: boolean;
}

export function orderedRefillToken(
  profileId: number,
  itemId: number,
  generation: string,
  cancel = false
): string {
  if (cancel) return `rfordno:${profileId}:${itemId}:${generation}`;
  return `rfordered:${profileId}:${itemId}:${generation}`;
}

// A distinct namespace matters: deployed rfsnooze readers ignore extra fields.
export function parseOrderedRefillCallback(
  data: unknown
): OrderedRefillCallback | null {
  if (typeof data !== "string") return null;
  const [prefix, profile, item, generation, extra] = data.split(":");
  if (
    (prefix !== "rfordered" && prefix !== "rfordno") ||
    extra !== undefined ||
    !/^[1-9]\d*$/.test(profile ?? "") ||
    !/^[1-9]\d*$/.test(item ?? "") ||
    !REFILL_GENERATION_PATTERN.test(generation ?? "")
  )
    return null;
  const profileId = Number(profile);
  const itemId = Number(item);
  return Number.isSafeInteger(profileId) && Number.isSafeInteger(itemId)
    ? { profileId, itemId, generation, cancel: prefix === "rfordno" }
    : null;
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

// The receipt's REPLY marker and its number grammar left this file at #5650: both are
// the typed-reply contract's (./typed-reply), shared now with `/temp` and `/weight`
// rather than spelled a third time here. What stays is what is genuinely this family's
// — the CALLBACK tokens its buttons carry.
