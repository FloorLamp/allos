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
// ── AN OFFER'S IDENTITY IS ITS CONTENT, NOT ITS ALLOCATION (#3282) ───────────
//
// `mintOffer` is get-or-create, so a tenant may mint from a RENDER: its token does not
// move when nothing about the offer moved. Two consequences for a third tenant — build
// the payload deterministically (fixed key order, deterministic member order) or it
// will not match itself, and never read an offer id as a per-mint receipt.
//
// ── EXPIRY IS THE DAY ROLLOVER, AND NOTHING ELSE ─────────────────────────────
//
// `date` is the subject's local day at mint time, exactly as `notify_messages.date`
// is, and `readOffer` refuses a row whose day is not the day asked for — the rule that
// retires yesterday's keyboards. A tenant whose payload is dated by the SCHEDULE reads
// `readOfferRow` and judges the day itself. `pruneNotifyOffers` reclaims either way.
//
// Profile-scoped: every statement names `profile_id`, and a read for the wrong profile
// answers null rather than another profile's bundle.

import { db, writeTx } from "../db";
import { sqlNow } from "../clock";

// The offer FAMILY. Two tenants: the composed one-tap (#2460) and the per-stack
// one-tap (#3282, the substrate's first migration); the #2320 digest offer tail and
// #3087's interaction provenance are the named future ones. Matching on it is what
// stops one family from redeeming another's payload.
export type OfferFamily = "usual-routine" | "stack-take";

// Rows are pruned on the same horizon message pointers use — an offer is only ever
// redeemed from a live message, so it can never usefully outlive one.
export const OFFER_RETENTION_DAYS = 3;

// Mint one offer row and return its id — or the id of the identical bundle already
// offered to this profile today, because re-offering is a READ (see the header). The
// per-stack one-tap mints on every rebuild and would otherwise move its own token.
export function mintOffer(
  profileId: number,
  family: OfferFamily,
  date: string,
  payload: unknown
): number {
  const json = JSON.stringify(payload);
  return writeTx(() => {
    const existing = db
      .prepare(
        `SELECT id FROM notify_offers
          WHERE profile_id = ? AND family = ? AND date = ? AND payload = ?`
      )
      .get(profileId, family, date, json) as { id: number } | undefined;
    if (existing) return existing.id;
    const res = db
      .prepare(
        `INSERT INTO notify_offers (profile_id, family, date, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(profileId, family, date, json, sqlNow());
    return Number(res.lastInsertRowid);
  });
}

// The bundle an offer id names AND the day it was minted for, or null when this profile
// has no such offer in this family (one refusal for both, so a forged token cannot
// learn whether an id exists). The day is RETURNED, not matched, because the tenants
// judge it differently: `usual:` expires at the rollover, while `stacktake:` names doses
// whose day the schedule assigned, so matching here would impose one answer on both.
export function readOfferRow<T>(
  profileId: number,
  family: OfferFamily,
  offerId: number
): { payload: T; date: string } | null {
  const row = db
    .prepare(
      `SELECT payload, date FROM notify_offers
        WHERE id = ? AND profile_id = ? AND family = ?`
    )
    .get(offerId, profileId, family) as
    { payload: string; date: string } | undefined;
  if (!row) return null;
  try {
    return { payload: JSON.parse(row.payload) as T, date: row.date };
  } catch {
    return null;
  }
}

// The same read, refused unless the offer is FOR THIS DAY (#2460's rollover expiry).
export function readOffer<T>(
  profileId: number,
  family: OfferFamily,
  offerId: number,
  date: string
): T | null {
  const row = readOfferRow<T>(profileId, family, offerId);
  return row?.date === date ? row.payload : null;
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
