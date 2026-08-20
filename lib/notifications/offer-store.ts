// WHAT A DELIVERED BUTTON OFFERED (issue #2460) — the store `notify_offers` fronts.
//
// Telegram gives a button 64 bytes of `callback_data` and no more. The composed
// "your usual <window>" one-tap names two sets, and spelling both into the token
// measured 63 bytes for the motivating profile — one byte of headroom, at the moment
// the token is LARGEST (send time, before anything is logged). So the token carries an
// OFFER ID instead: `usual:<profileId>:<offerId>`, constant size, and the bundle lives
// here beside `notify_messages`.
//
// ── THE STORED OFFER IS AN UPPER BOUND, NEVER AN INSTRUCTION ─────────────────
//
// Redeeming an offer does not write it. The handler re-derives what currently stands
// and writes the INTERSECTION of the two, which makes the stored row strictly
// STRONGER than a token that named the sets: a same-day replay can never write more
// than was offered, and a stale offer can never write more than still stands.
//
// ── EXPIRY IS THE DAY ROLLOVER, AND NOTHING ELSE ─────────────────────────────
//
// `date` is the subject's local day at mint time, exactly as `notify_messages.date`
// is, and `readOffer` refuses a row whose day is not the day asked for. That is the
// same rule that retires yesterday's keyboards, so an offer cannot outlive the message
// carrying it. `pruneNotifyOffers` then reclaims the rows on the reconcile sweep.
//
// Profile-scoped: every statement names `profile_id`, and a read for the wrong profile
// answers null rather than another profile's bundle.

import { db, writeTx } from "../db";
import { sqlNow } from "../clock";

// The offer FAMILY. One tenant today; `stacktake:`, the #2320 digest offer tail and
// #3087's interaction provenance are the named future ones. Matching on it is what
// stops one family from redeeming another's payload.
export type OfferFamily = "usual-routine";

// Rows are pruned on the same horizon message pointers use — an offer is only ever
// redeemed from a live message, so it can never usefully outlive one.
export const OFFER_RETENTION_DAYS = 3;

// Mint one offer row and return its id. The id is what the button's token carries.
export function mintOffer(
  profileId: number,
  family: OfferFamily,
  date: string,
  payload: unknown
): number {
  return writeTx(() => {
    const res = db
      .prepare(
        `INSERT INTO notify_offers (profile_id, family, date, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(profileId, family, date, JSON.stringify(payload), sqlNow());
    return Number(res.lastInsertRowid);
  });
}

// The bundle an offer id names, or null when there is no such offer FOR THIS PROFILE,
// IN THIS FAMILY, ON THIS DAY. All four are the same refusal on purpose: the caller's
// answer is the honest "this is out of date" either way, and distinguishing them would
// tell a forged token whether an id exists.
export function readOffer<T>(
  profileId: number,
  family: OfferFamily,
  offerId: number,
  date: string
): T | null {
  const row = db
    .prepare(
      `SELECT payload FROM notify_offers
        WHERE id = ? AND profile_id = ? AND family = ? AND date = ?`
    )
    .get(offerId, profileId, family, date) as { payload: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

// The retention sweep, run beside `pruneMessagePointers` on every reconcile pass —
// what keeps the table bounded for a household that never opens Telegram.
export function pruneNotifyOffers(profileId: number): number {
  return db
    .prepare(
      `DELETE FROM notify_offers
        WHERE profile_id = ? AND created_at < datetime(?, ?)`
    )
    .run(profileId, sqlNow(), `-${OFFER_RETENTION_DAYS} days`).changes;
}
