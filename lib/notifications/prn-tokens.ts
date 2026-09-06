// THE PRN TOKEN FAMILY (issue #2961 step 2) — `prn:` (the reusable `/dose` list) and
// `redose:` (the one-window notice). Carved off `callback-data.ts` verbatim; no imports.

// ---- PRN administration logging over Telegram (/dose command, #797) ----
// A "prn:<profileId>:<itemId>:<token>" button logs one PRN (as-needed)
// administration NOW. Like a dose tap, the profile id is a cross-check (the handler
// re-resolves the acting profile from the chat and logAdministration re-verifies the
// item is that profile's), and the handler answers from the typed
// AdministrationOutcome — never unconditionally, because a PRN log is NOT idempotent
// (multiple/day is the point). `token` is a per-render nonce (the "dedup token"): a
// redelivered identical callback carries the same token, and the actual double-log
// guard is logAdministration's short-window dedup, so a re-tap doesn't invent a
// phantom dose. The button is NOT consumed on tap (you can log again later).

export interface PrnLogCallback {
  profileId: number;
  itemId: number;
  token: string;
}

// Parse a "prn:<profileId>:<itemId>:<token>" token. The token is the greedy tail (a
// nonce with no colons). Malformed (wrong prefix, bad ids, missing token) → null.
export function parsePrnLogCallback(data: unknown): PrnLogCallback | null {
  if (typeof data !== "string" || !data.startsWith("prn:")) return null;
  const [, profStr, itemStr, token] = data.split(":");
  const profileId = Number(profStr);
  const itemId = Number(itemStr);
  if (!profileId || !itemId || !token) return null;
  return { profileId, itemId, token };
}

// A redose NOTICE is one administration-armed window, unlike the reusable `/dose`
// list above. Its token carries the administration id that opened this exact window,
// so a dose logged in the app can supersede it and both the tap handler and the
// reconciliation sweep can retire the old button.
export interface RedoseLogCallback {
  profileId: number;
  itemId: number;
  administrationId: number;
  token: string;
}

export function redoseLogCallback(
  profileId: number,
  itemId: number,
  administrationId: number,
  token: string
): string {
  return `redose:${profileId}:${itemId}:${administrationId}:${token}`;
}

// `redose:<profileId>:<itemId>:<armingAdministrationId>:<nonce>`.
export function parseRedoseLogCallback(
  data: unknown
): RedoseLogCallback | null {
  if (typeof data !== "string" || !data.startsWith("redose:")) return null;
  const [, profStr, itemStr, administrationStr, token] = data.split(":");
  const profileId = Number(profStr);
  const itemId = Number(itemStr);
  const administrationId = Number(administrationStr);
  if (!profileId || !itemId || !administrationId || !token) return null;
  return { profileId, itemId, administrationId, token };
}
