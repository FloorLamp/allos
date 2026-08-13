// TICK-SCOPED memoization for the notification sidecar (#2118, #2111).
//
// WHY THIS EXISTS AT ALL. `lib/request-cache.ts` degrades React's `cache()` to
// IDENTITY outside a Next server request, deliberately: the plain `react` package a
// tsx entrypoint resolves has no `cache` export, and a memo with no request to bound
// it has no honest lifetime. That decision is right, and it leaves the hourly tick —
// which is not a request — with no memoization anywhere. So the same profile's
// heaviest per-tick gathers ran two, three, or once-per-live-message-pointer times
// per tick: `assessProfilePreventive` from the nudge planner, the digest's
// `collectUpcoming`, and again inside the reconcile sweep for every preventive-
// carrying pointer (#2118); `getMedicationFamilyStates` from the redose notice, the
// digest's over-max finding, and the quick-log gather (#2111).
//
// WHY NOT A TTL MEMO. `tzMemo` (lib/db.ts) and the schedule-history memo
// (lib/queries/intake/schedule.ts, #2066) bound their own staleness with a short TTL
// because three processes share one database file. That shape is right for a value
// whose miss "degrades to the documented fallback, never a wrong answer". It is the
// WRONG shape here: a stale medication-family state is a SAFETY counter reading low
// — the redose notice saying "you may redose" from a count that no longer holds,
// which is precisely the dangerous-direction failure the #1027 family gather exists
// to prevent. A TTL would let a web request minutes-old-at-worst serve that read
// AFTER a dose was confirmed. So the lifetime here is not a duration at all: it is a
// SCOPE, opened and closed by the one caller that can promise nothing inside it
// writes what it reads.
//
// THE SCOPE. `scripts/notify.ts` opens one around each profile's tick. Inside that
// window the tick only READS these inputs — it sends messages and writes send
// markers (`notify_*` profile settings), which are not inputs to either gather. The
// writers that DO move them (`markDoseTaken`, `setPreventiveOverride`,
// `recordPreventiveSatisfaction`) are reached from Telegram taps and Server Actions,
// i.e. the webhook route or the sidecar's separate `poll` mode — never from `tick()`.
// `syncIntegrations` runs first, before the scope's first read, and writes activity/
// metric/appointment rows rather than dose logs or preventive records. The scope
// closes with the profile, so the next profile — and the next tick — re-reads.
//
// WHAT THE SCOPE DOES NOT COVER (#2674). "The tick only READS these inputs" is a
// claim about the two gathers named above, not a property of the tick, and the
// difference is load-bearing: a read repeated inside a tick is NOT thereby a
// candidate. `getFindingSuppressions` is the worked counter-example. It is read six
// times in one digest gather and eleven times across an ordinary two-profile tick,
// which is exactly the shape that looks like this module's job — but `runPreventive`
// DELETES from upcoming_dismissals inside the scope (its #1024 episode-end sweep,
// lib/notifications/preventive.ts:127, reached from scripts/notify.ts:605), and the
// Telegram poll loop writes the same table from ANOTHER PROCESS while the scope sits
// open across every awaited dispatch. So the read stays unmemoized and pays its
// round-trip; the compile cost, which is the expensive half, is already gone through
// `hoistedStatement`. Before adding a name here, find the writers first — a snapshot
// of a suppression bus reads as "still silenced", and that is a safety direction.
//
// Outside a scope this is a plain passthrough, exactly like the request-cache shim:
// a DB test, a `manual` send, and the `poll` loop all compute every call. That is
// what makes it composable with `cache()` — wrap a gather in both and each process
// gets the memo whose lifetime it can actually justify.

// The open scope, or null when there is none. A plain module-level slot rather than
// AsyncLocalStorage: the tick awaits one profile at a time, and every key carries
// its own profile id, so an interleaving could at worst drop a memo entry early —
// never serve one profile's answer to another.
let openScope: Map<string, unknown> | null = null;

// WHO the open scope is for (#2209). The scope is already "one profile's tick", so
// it is the honest carrier for that fact — and the persisted tick log needs it to
// attribute a line to a profile without every log call site passing an id. Kept in
// its own slot beside the memo map rather than inside it, so nothing can memoize on
// it and the two lifetimes stay obviously the same one.
export interface TickScopeSubject {
  /** The profile this scope was opened for. */
  profileId: number;
}

let openSubject: TickScopeSubject | null = null;

// Run `fn` with a fresh tick scope open, closing it (and dropping everything
// memoized in it) when `fn` settles — including on a throw, so a failed profile
// tick can never leak its snapshot into the next one. Nesting restores the outer
// scope rather than clearing to null.
export async function runInTickScope<T>(
  fn: () => Promise<T>,
  subject?: TickScopeSubject
): Promise<T> {
  const outer = openScope;
  const outerSubject = openSubject;
  openScope = new Map();
  openSubject = subject ?? null;
  try {
    return await fn();
  } finally {
    openScope = outer;
    openSubject = outerSubject;
  }
}

// The profile the open scope belongs to, or null (no scope, or one opened without a
// declared subject — a DB test, a `manual` send, the poll loop).
export function currentTickSubject(): TickScopeSubject | null {
  return openSubject;
}

// Whether a tick scope is currently open. For tests and for a caller that wants to
// state which lifetime it is running under; never a substitute for the scope itself.
export function inTickScope(): boolean {
  return openScope !== null;
}

// Memoize `fn` for the lifetime of the open tick scope, keyed by `name` plus the
// caller's own key function. With no scope open the wrapper calls straight through,
// so behavior outside the tick is byte-identical to the unwrapped gather.
//
// `keyOf` must project EVERY argument that can change the answer — the same
// discipline `cache()` imposes by identity. Keep the arguments primitive.
export function tickCached<A extends unknown[], R>(
  name: string,
  keyOf: (...args: A) => string,
  fn: (...args: A) => R
): (...args: A) => R {
  return (...args: A): R => {
    const scope = openScope;
    if (!scope) return fn(...args);
    const key = `${name}:${keyOf(...args)}`;
    if (scope.has(key)) return scope.get(key) as R;
    const value = fn(...args);
    scope.set(key, value);
    return value;
  };
}
