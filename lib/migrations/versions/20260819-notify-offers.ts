import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2460 — `notify_offers`: what a delivered button OFFERED, stored so the token
// does not have to carry it.
//
// WHY IT EXISTS. Telegram caps `callback_data` at 64 bytes. The composed
// "your usual <window>" one-tap names two sets — habitual food groups and declared
// doses — and a token that spells both out
// (`usual:<profileId>:<window>:<date>:<slug,slug>:<doseId,doseId>`) measured 63 bytes
// for the motivating profile's two groups and six doses. One byte of headroom, and the
// token is LARGEST at send time, before anything is logged — exactly when the offer is
// meant to help. A third habitual group or a seventh dose silently deletes the button
// under the drop-not-truncate rule (an offer may never name less than the tap would
// write). The owner's ruling was to stop spending the wire on the payload: the token
// carries `usual:<profileId>:<offerId>` — constant size, immune to both growth axes —
// and the bundle it names lives here.
//
// A SIBLING OF `notify_messages.keyboard`, deliberately. That table is already the only
// record of what a delivered message is SHOWING (Telegram cannot be asked), and it is
// already day-scoped for reconciliation. This is the same class of fact one step
// earlier: what the message OFFERED. It could not be a column on that table — the
// pointer row is written after the send, with Telegram's message id, while an offer id
// must exist before the keyboard is minted — so it is a row of its own, keyed the same
// way and expiring on the same day rollover.
//
// A SUBSTRATE, NOT A POINT FIX. `family` names the offer kind so the named future
// tenants land here rather than each inventing a store: `stacktake:` already
// self-amputates on the same byte limit (lib/notifications/intake-format.ts), the
// #2320 digest offer tail is structurally impossible under per-entity tokens, and
// #3087 interaction provenance wants a redeemed offer id as the durable record of
// which surface wrote a row.
//
// ── THE COLUMNS ──────────────────────────────────────────────────────────────
//
//   • `family` — the offer kind ("usual-routine" today). Readers match on it so one
//     family can never redeem another's payload.
//   • `date` — the SUBJECT's local calendar day at mint time, exactly as
//     `notify_messages.date` is. Expiry is the day rollover and nothing else: a tap
//     carrying yesterday's offer is refused by comparing this against `today(profileId)`,
//     the same rule that retires yesterday's keyboards.
//   • `payload` — the offered bundle verbatim, as JSON. An UPPER BOUND on the write and
//     never an instruction: the handler re-derives what currently stands and writes only
//     the intersection, so a replayed offer can never write more than was offered AND
//     still stands. Opaque to SQL — nothing filters, groups or joins on it.
//   • `created_at` — the send-side stamp, BARE (`sqlNow`) exactly like its sibling
//     `notify_messages.sent_at`, because the retention sweep compares it in SQL against
//     `datetime(...)`. A canonical `…Z` string would not compare against that at all.
//
// NO `notify_message_id` COLUMN. The offer is minted BEFORE the message exists, and the
// direction that matters at tap time is the other one: the token names the offer. The
// tap's provenance is already recorded where it belongs — `notify_message_id` on the
// food and intake ledger rows (#2264).
//
// ── THE CENSUSES, ANSWERED ───────────────────────────────────────────────────
//
//   • lib/owned-tables.ts — YES. `profile_id` is on the row, so the profile-delete sweep
//     clears it and every read must name profile_id. Like `notify_messages` it grows with
//     SENDS, so it carries a named cleanup class (#203): `pruneNotifyOffers` drops rows
//     past the same horizon the message-pointer prune uses.
//   • lib/time-columns.ts — YES: `date` (day) and `created_at` (bare instant).
//   • lib/export.ts DATASETS — NO, and the exemption is `notify_messages`'s verbatim:
//     this is delivery plumbing about a third-party chat, worthless on another instance,
//     and the health facts a redeemed offer wrote export via their own datasets.
//   • lib/dataset-undo.ts — no entry and none possible: not the root table of any
//     UNDO_KINDS kind.
//   • FK children — none. Nothing references this table.

export const migration: Migration = {
  name: "20260819-notify-offers",
  up(db: Database.Database) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS notify_offers (
         id         INTEGER PRIMARY KEY,
         profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
         family     TEXT NOT NULL,
         date       TEXT NOT NULL,
         payload    TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_notify_offers_profile
         ON notify_offers(profile_id, date)`
    );
  },
};
