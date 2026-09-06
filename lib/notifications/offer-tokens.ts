// THE OFFER-TOKEN FAMILY (issue #2961 step 2) — `usual:` and `stacktake:`.
//
// Carved off `callback-data.ts` verbatim: same prefixes, same grammar, no imports. The
// two prefixes share one builder and one parser because they share one GRAMMAR (the
// stored-bundle id); each still routes to its own handler and keeps its own reconcile
// family. The #1779 vocabulary guard reads the `OfferPrefix` union below.

// ---- OFFER TOKENS: the button names a STORED bundle, not its contents -------
//
// Two buttons write a whole named set in one tap — the composed "your usual <window>"
// (#2460) and the per-stack one-tap (#3098) — and a token that spells its set out
// grows with the set, against a hard 64 bytes, and is LARGEST at send time before
// anything is logged. `usual:` measured 63 of 64; `stacktake:` dropped its own button
// once a stack outgrew the limit. So neither names its set: the bundle is stored
// (`notify_offers`, ./offer-store.ts) and the token carries the row id, constant size.
//
// NO DATE CROSSES THE WIRE either: the offer ROW carries the day, so a token cannot
// backfill; how old a row may be is each tenant's own rule (./offer-store.ts).
// AND THE ID IS THE WHOLE TOKEN, which is why `notify_offers.id` is AUTOINCREMENT
// (20260827-notify-offers-autoincrement): a reissued row id silently re-points a button
// still sitting in a chat at a bundle it never named.

// The prefixes that spell an offer token. Not a registry of behaviour — the dispatcher
// still routes each to its own handler, and each keeps its own reconcile family; only
// the GRAMMAR is shared, the way `take:` and `skip:` share theirs.
export type OfferPrefix = "usual" | "stacktake";

export interface OfferCallback {
  profileId: number;
  offerId: number;
}

// The single source of truth for the shape (the mint sites write it, the parsers and
// the reconcile sweep read it): "<prefix>:<profileId>:<offerId>".
export function offerCallback(
  prefix: OfferPrefix,
  profileId: number,
  offerId: number
): string {
  return `${prefix}:${profileId}:${offerId}`;
}

// Parse an offer token for one prefix. Malformed (wrong prefix, non-numeric, zero or
// negative ids, missing or trailing fields) → null. The profile id is a cross-check
// like every other tap token: the handler re-resolves the acting profile from the chat
// and the offer row is read scoped by that profile.
export function parseOfferCallback(
  data: unknown,
  prefix: OfferPrefix
): OfferCallback | null {
  if (typeof data !== "string" || !data.startsWith(`${prefix}:`)) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const profileId = Number(parts[1]);
  const offerId = Number(parts[2]);
  if (!Number.isInteger(profileId) || profileId <= 0) return null;
  if (!Number.isInteger(offerId) || offerId <= 0) return null;
  return { profileId, offerId };
}
