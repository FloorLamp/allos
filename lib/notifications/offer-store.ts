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
// `mintOffer` is get-or-create: the same bundle offered twice to the same profile on
// the same day is ONE row, and the second mint is a read. Every tenant inherits this,
// so a tenant that mints from a RENDER is safe — its token does not move when nothing
// about the offer moved. Two consequences worth knowing before adding a third tenant:
// a payload must be built deterministically (fixed key order, deterministic member
// order) or it will not match itself, and an offer id is not a per-mint receipt, so
// nothing may use one to count how many times a button was rendered.
//
// ── EXPIRY IS THE DAY ROLLOVER, AND NOTHING ELSE ─────────────────────────────
//
// `date` is the subject's local day at mint time, exactly as `notify_messages.date`
// is, and `readOffer` refuses a row whose day is not the day asked for — the same rule
// that retires yesterday's keyboards. A tenant whose payload is dated by the SCHEDULE
// rather than by the offer reads `readOfferRow` and judges the day itself; see the note
// there. `pruneNotifyOffers` reclaims the rows on the reconcile sweep either way.
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

// Mint one offer row and return its id. The id is what the button's token carries.
//
// THE SAME BUNDLE, OFFERED TWICE IN A DAY, IS ONE OFFER. A tenant that mints from a
// RENDER — the per-stack one-tap does, because its buttons are re-derived on every
// rebuild — would otherwise put a fresh id in the token every time, and a keyboard
// that differs is a keyboard the reconcile sweep EDITS: the zero-Telegram-call steady
// state a quiet tick relies on would be gone, and the table would grow a row per tick.
// So the identity of an offer is its content, and re-offering is a read.
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

// The bundle an offer id names AND the day it was minted for, or null when there is no
// such offer for this profile in this family. Both refusals are the same on purpose:
// distinguishing them would tell a forged token whether an id exists.
//
// THE DAY IS RETURNED, NOT MATCHED, because the tenants judge it differently. `usual:`
// expires at the rollover — its food half is a claim about today. `stacktake:` names
// doses whose day the SCHEDULE assigned before the message was sent, so it rides the
// same ±DOSE_LOG_DATE_WINDOW_DAYS window every dose button uses. Matching here would
// have imposed one answer on both.
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

// The same read, refused unless the offer is FOR THIS DAY — the day-rollover expiry
// `usual:` was built with (#2460).
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
