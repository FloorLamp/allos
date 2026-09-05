// THE CALLBACK TOKEN LEAF (issue #2961, step 1) — the vocabulary a RENDERER needs,
// with nothing above it.
//
// `callback-data.ts` mints and parses every Telegram button token, and `intake-format.ts`
// renders the dose rows those buttons ride on. They imported each other:
//
//   callback-data.ts:20   INTAKE_SEND_SLOTS   ← intake-format.ts
//   intake-format.ts:36   callbackDataFits, MED_STOP_PREFIX   ← callback-data.ts
//
// A runtime cycle, and #2961's acyclic criterion is about what it costs rather than
// about tidiness: while it stands, no domain module can own its own tokens, because the
// file the tokens live in cannot be split without the renderer coming with it. Every
// later step of that issue — per-family token modules, then per-family handlers — sits
// behind this edge being cut.
//
// The back edge was three symbols, so this leaf is three symbols. It imports NOTHING,
// which is the property that makes it one: a leaf that grows an import is a file that
// can be in a cycle again, and the next thing to move here should be moved for the same
// reason rather than because this is where token-ish things go.
//
// NO CALLBACK BYTE MOVES. The prefix below is the same string it has always been; only
// the file it is declared in changed. A token already sitting in somebody's chat still
// parses, which is the non-negotiable for every step of #2961.

/** Telegram's hard cap on a button's callback_data, in bytes. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Does a token fit Telegram's callback budget? The EXACT encoded byte length, not a
 * character count and not an estimate — a multi-byte character in a future token shape
 * would pass a `.length` check and be rejected on the wire.
 *
 * Compose-time callers DROP a button whose token does not fit; they never truncate it.
 * An offer may never name less than the tap would write (#2460), and #3098's per-stack
 * one-tap already ships that rule (lib/notifications/intake-format.ts).
 */
export function callbackDataFits(data: string): boolean {
  return (
    new TextEncoder().encode(data).length <= TELEGRAM_CALLBACK_DATA_MAX_BYTES
  );
}

/**
 * The token prefix for the Stop button riding a dose reminder (#2574).
 *
 * Its own namespace, and deliberately not a variant of `demote:` — the two buttons
 * perform different writes through different cores, and one token that could mean
 * either is one mis-parse away from stopping a medication somebody asked to demote.
 *
 * Its parser stays in `callback-data.ts` with every other parser; only the DECLARATION
 * is here, which is what the renderer needs and all it needs.
 */
export const MED_STOP_PREFIX = "medstop";
