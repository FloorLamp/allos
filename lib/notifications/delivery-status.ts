// Pure half of the SCOPED delivery lifecycle (#2565 A; owner ruling 2026-08-18). No DB,
// no clock, no network — unit-tested in lib/__tests__/delivery-status.test.ts. The row
// I/O it decides for is lib/notifications/delivery-marker.ts.
//
// WHAT REPLACED WHAT. Until #2565 the app kept ONE global delivery-health fact — "the
// last dispatch failed on channel X" — set on any failure and cleared by the next
// healthy dispatch that exercised that channel (#131/#192/#942, `decideMarker`). One
// shared bot made that an instance-level signal, and it was honest about the instance.
// It could not be honest about a PERSON: a member's Settings row had to say either
// "configured" (true of the config, silent about outcome) or borrow the instance's
// failure (which may be someone else's chat). Neither is the four-state row the strip
// draws, and "Delivering" inferred from configuration plus the absence of an error is
// the lie the ruling forbids.
//
// So the fact is now kept PER DELIVERY OWNER — the identity a send is actually
// addressed to, which the channel adapters already resolve:
//
//     Telegram        (telegram,       login_id)    the login's chat
//     Web Push        (push,           login_id)    the login's browsers
//     Email           (email,          login_id)    the login's address
//     Home Assistant  (home-assistant, profile_id)  the profile's webhook
//
// One row per owner holds the LATEST attempt under the current configuration: whether
// it succeeded, the failure detail, and the instant. A configuration write for that
// owner DELETES the row (`invalidateDeliveryOutcome`), so a row's existence is itself
// the statement "this outcome is about the configuration that stands now" — there is
// no generation counter to compare, because the write that would advance one removes
// the rows it would have out-dated.

// A stored owner outcome. `failing` is the #942 marker's own state word, kept so the
// legacy aggregate row and the scoped rows read through one vocabulary; `delivering` is
// the success the old marker never stored (healthy ⇒ no row was its whole design, and
// that is exactly what could not tell Ready from Delivering).
export interface DeliveryOutcomeRow {
  state: "failing" | "delivering";
  detail: string | null;
  // Canonical stored instant of the attempt (migration 167's convention).
  at: string;
}

// The strip's four truthful states. Discriminated so a row's copy is a switch that
// cannot forget one — see `channelRowState` for which facts produce which.
export type ChannelRowState =
  | { state: "not-set-up" }
  | { state: "ready" }
  | { state: "delivering"; at: string }
  | { state: "erroring"; detail: string; at: string };

// The words the strip prints for each state — the ruling's four, verbatim.
export const CHANNEL_ROW_LABEL: Record<ChannelRowState["state"], string> = {
  "not-set-up": "Not set up",
  ready: "Ready",
  delivering: "Delivering",
  erroring: "Erroring",
};

// One row's state from two facts: whether the owner can receive through this channel
// under today's configuration (the matrix's own liveness — configuration words, never
// delivery words), and the owner's latest recorded attempt, if any.
//
//   Not set up  dominates: it HIDES a stale outcome rather than qualifying it, because a
//               person who removed their chat id must not read last month's "Delivering"
//               beside a channel that can no longer reach them.
//   Ready       is set up with NO completed attempt — the state the old marker could not
//               represent. A fresh configuration is Ready, never Delivering.
//   Delivering  only ever comes from a recorded success.
//   Erroring    only ever comes from a recorded failure.
export function channelRowState(
  setUp: boolean,
  row: DeliveryOutcomeRow | null
): ChannelRowState {
  if (!setUp) return { state: "not-set-up" };
  if (!row) return { state: "ready" };
  if (row.state === "delivering") return { state: "delivering", at: row.at };
  return {
    state: "erroring",
    detail: row.detail ?? "unknown send failure",
    at: row.at,
  };
}

// The aggregate marker Settings → Server and the logs still read (the #131 surface).
// Same shape it always had; the source is now a FOLD over scoped failures rather than
// a fact of its own.
export interface NotifyErrorMarker {
  error: string;
  at: string;
  channel: string;
}

// The fold's tie-break: dispatch()'s channel registry order, so two failures recorded
// in the same second resolve the same way on every read.
const CHANNEL_ORDER: readonly string[] = [
  "telegram",
  "push",
  "home-assistant",
  "email",
];

export interface ScopedFailure {
  channel: string;
  detail: string | null;
  at: string | null;
}

// Fold the current scoped failures into ONE marker, deterministically: the most recent
// attempt wins (the heading says "Last notification delivery failed"), ties by channel
// order. Null when nothing is failing — a claim about EVERY owner, not about the most
// recent dispatch: one login's success never clears another login's error here,
// because nothing here clears anything. A failure with no detail is one this surface
// cannot explain, and is skipped.
export function foldFailures(
  rows: readonly ScopedFailure[]
): NotifyErrorMarker | null {
  const ranked = rows
    .filter((r): r is ScopedFailure & { detail: string } => !!r.detail)
    .sort(
      (a, b) =>
        (b.at ?? "").localeCompare(a.at ?? "") ||
        CHANNEL_ORDER.indexOf(a.channel) - CHANNEL_ORDER.indexOf(b.channel)
    );
  const top = ranked[0];
  return top ? { error: top.detail, at: top.at ?? "", channel: top.channel } : null;
}
