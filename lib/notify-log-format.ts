// Pure decision logic for the persisted NOTIFY TICK log (issue #2209): which lines
// the sink admits, how a line reads, and how lines fold back into the RUN they came
// from. No fs, no clock, no DB — the impure fs half lives in lib/notify-log.ts, and
// the append/trim substrate it shares with errors.jsonl and ai.jsonl is
// lib/jsonl-log-file.ts (#1883).
//
// WHY A SCOPE FILTER AND NOT A LEVEL FILTER. `errors.jsonl` persists a LEVEL
// (`error`), and that half works. What it cannot reach is the class of thing this
// log exists for: the DECLINE. A send writes a row (`notify_messages`, a
// `notify_last_*` marker); a decision NOT to send writes nothing, anywhere, and
// lands in the container's stdout that the deploy timer deletes. Filtering by scope
// keeps everything the tick says about a run; filtering by level would either keep
// only the failures again, or persist every `info` in the whole web app — a much
// larger decision this issue does not make.
//
// THE UNIT IS A RUN, NOT A LINE. Nobody asks "show me line 4,912". The question is
// always "what did the 07:00 tick decide for this profile, and why didn't it send
// X?" — so the viewer groups by (run, profile) and `groupNotifyRuns` below is that
// grouping. It keys on a stamped RUN ID, never on a timestamp bucket: a tick that
// straddles a minute boundary must not split into two runs, and a bucket heuristic
// gets exactly that case wrong.

export type NotifyLevel = "info" | "warn" | "error";

// The logger scopes this sink admits. `notify` is the sidecar's own scope (18
// modules), `notifications` the shared delivery layer's. Both are the tick; nothing
// else is. Growing this list is a deliberate act — see the module header.
export const NOTIFY_LOG_SCOPES = ["notify", "notifications"] as const;

const SCOPE_SET: ReadonlySet<string> = new Set<string>(NOTIFY_LOG_SCOPES);

export function admitsNotifyScope(scope: string | undefined): boolean {
  return scope != null && SCOPE_SET.has(scope);
}

// `debug` is developer tracing, not the operator record, and the default LOG_LEVEL
// already hides it — persisting it would be new chatter nobody asked for. Everything
// at `info` and above in an admitted scope is kept, whatever LOG_LEVEL says.
export function notifyLogAdmits(e: {
  level: string;
  scope?: string;
}): e is { level: NotifyLevel; scope: string } {
  if (!admitsNotifyScope(e.scope)) return false;
  return e.level === "info" || e.level === "warn" || e.level === "error";
}

// One persisted tick line. Mirrors ErrorEvent's id/time/level/scope shape so the
// admin surface can render it the same way, plus the two fields that make a RUN
// reconstructable: the run id the tick stamped and the profile the scope was open
// for.
export interface NotifyEvent {
  id: string;
  time: string;
  level: NotifyLevel;
  scope: string;
  // The tick RUN this line belongs to. Null for a line emitted outside any run (a
  // `notify`-scoped line from a web request, or a sidecar poll-mode line).
  runId: string | null;
  // The profile whose tick scope was open, or null for the run's global phase.
  profileId: number | null;
  // Acting login when a request context is in scope (a Telegram tap handled by the
  // webhook route); null in the tick itself.
  loginId: number | null;
  message: string;
  // Serialized, redacted, capped fields — identical treatment to ErrorEvent.detail.
  detail?: string;
  // Set when the emitting call site DECLARED the decision rather than leaving it to
  // be read off the message text. The #2102 digest-deferral trace declares it; the
  // legacy lines are classified by the tables below.
  decision?: "declined" | "proceeded";
}

// ---- What a line MEANS -------------------------------------------------------
//
// A presentation classification, and honest about being one: these are the messages
// the tick already emits (censused from lib/notifications/** and scripts/notify.ts),
// not a contract the emitters sign. A call site that wants to be sure declares
// `decision` in its fields instead, which always wins. Anything unrecognised is a
// `note` — never an error, and never silently dropped.

// Exact messages that ARE the decline.
export const NOTIFY_DECLINE_MESSAGES: readonly string[] = [
  "nothing due",
  "already sent today",
  "no channels configured for profile",
  "no configured channels; nothing sent",
];

// Fragments that make a message a decline wherever they appear.
export const NOTIFY_DECLINE_SUBSTRINGS: readonly string[] = [
  // "refill nudge skipped: no channel", "skipped: kind not deliverable to push",
  // "skipped: kind disabled for HA channel", "pool refill nudge skipped: no
  // managing login" — the whole skipped-because family.
  "skipped:",
  // "digest: nothing to send", "weekly recap: nothing to send".
  "nothing to send",
  // Reconcile outcomes: what was STRIPPED from a live keyboard, which
  // notify_messages never records (it holds the current keyboard only).
  "pointer kept",
  "pointer dropped",
  // The #2102 digest deferral's trace.
  "deferred",
];

// Fragments that make a message a send. Checked AFTER the decline tables on
// purpose: "no configured channels; nothing sent" contains "sent" and is a decline.
export const NOTIFY_SEND_SUBSTRINGS: readonly string[] = [
  "nudge sent",
  "notice sent",
  "suggest sent",
  "escalated missed dose",
];

export type NotifyLineKind = "decline" | "send" | "failure" | "note";

export function classifyNotifyLine(e: {
  level: NotifyLevel;
  message: string;
  decision?: "declined" | "proceeded";
}): NotifyLineKind {
  if (e.decision === "declined") return "decline";
  const msg = e.message.toLowerCase();
  if (NOTIFY_DECLINE_MESSAGES.includes(msg)) return "decline";
  if (NOTIFY_DECLINE_SUBSTRINGS.some((s) => msg.includes(s))) return "decline";
  if (e.level === "warn" || e.level === "error") return "failure";
  if (msg === "sent" || NOTIFY_SEND_SUBSTRINGS.some((s) => msg.includes(s)))
    return "send";
  return "note";
}

// ---- Runs --------------------------------------------------------------------

// The label a line with no run id groups under. A line CAN legitimately lack one
// (poll mode, a `notify`-scoped line from a web request), and an unreadable one from
// a future/older writer must degrade to its own bucket rather than throw.
export const UNKNOWN_RUN_KEY = "unknown";

export interface NotifyRun {
  // Stable identity for React keys and for the expand/collapse anchor.
  key: string;
  runId: string | null;
  profileId: number | null;
  startedAt: string;
  endedAt: string;
  events: NotifyEvent[];
  counts: {
    total: number;
    declines: number;
    sends: number;
    failures: number;
  };
}

function runKeyOf(e: NotifyEvent): string {
  const run =
    typeof e.runId === "string" && e.runId.length > 0
      ? e.runId
      : UNKNOWN_RUN_KEY;
  const profile = e.profileId == null ? "global" : String(e.profileId);
  return `${run}::${profile}`;
}

/**
 * Fold a flat line list into (run, profile) groups, newest run first.
 *
 * Keyed on the STAMPED run id, so a tick that straddles a minute boundary stays one
 * run — the reason the tick stamps an id at all instead of the viewer bucketing by
 * timestamp. Lines with no usable run id land in their own `unknown` group per
 * profile rather than being merged into a real run or throwing.
 *
 * Input order does not matter; each group's events come back oldest-first (reading
 * order for "what did it do, in what order"), and the groups newest-first.
 */
export function groupNotifyRuns(events: readonly NotifyEvent[]): NotifyRun[] {
  const byKey = new Map<string, NotifyEvent[]>();
  for (const e of events) {
    const key = runKeyOf(e);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(e);
    else byKey.set(key, [e]);
  }
  const runs: NotifyRun[] = [];
  for (const [key, bucket] of byKey) {
    const sorted = [...bucket].sort((a, b) =>
      a.time === b.time
        ? a.id.localeCompare(b.id)
        : a.time.localeCompare(b.time)
    );
    let declines = 0;
    let sends = 0;
    let failures = 0;
    for (const e of sorted) {
      const kind = classifyNotifyLine(e);
      if (kind === "decline") declines++;
      else if (kind === "send") sends++;
      else if (kind === "failure") failures++;
    }
    const first = sorted[0];
    runs.push({
      key,
      runId: first.runId ?? null,
      profileId: first.profileId ?? null,
      startedAt: first.time,
      endedAt: sorted[sorted.length - 1].time,
      events: sorted,
      counts: { total: sorted.length, declines, sends, failures },
    });
  }
  runs.sort((a, b) =>
    a.startedAt === b.startedAt
      ? b.key.localeCompare(a.key)
      : b.startedAt.localeCompare(a.startedAt)
  );
  return runs;
}

// ---- Filters -----------------------------------------------------------------

export interface NotifyLogFilters {
  profileId: number | null;
  level: NotifyLevel | null;
  declinesOnly: boolean;
}

export const EMPTY_NOTIFY_FILTERS: NotifyLogFilters = {
  profileId: null,
  level: null,
  declinesOnly: false,
};

/**
 * Narrow runs by the viewer's declared filters.
 *
 * A profile filter selects RUNS (the row is "this profile in this run"). A level or
 * declines-only filter selects LINES inside a run, and a run left with nothing
 * matching drops out — which is exactly what "declines only" should do to a run that
 * declined nothing. With no filters, every run survives, INCLUDING a quiet one whose
 * only line is the tick's own per-profile marker: a run that decided nothing must
 * still render as a row, or the page reproduces the ambiguity it exists to kill.
 */
export function filterNotifyRuns(
  runs: readonly NotifyRun[],
  filters: NotifyLogFilters
): NotifyRun[] {
  const out: NotifyRun[] = [];
  for (const run of runs) {
    if (filters.profileId != null && run.profileId !== filters.profileId)
      continue;
    if (filters.level == null && !filters.declinesOnly) {
      out.push(run);
      continue;
    }
    const events = run.events.filter((e) => {
      if (filters.level != null && e.level !== filters.level) return false;
      if (filters.declinesOnly && classifyNotifyLine(e) !== "decline")
        return false;
      return true;
    });
    if (events.length === 0) continue;
    out.push({ ...run, events });
  }
  return out;
}

// ---- Parsing -----------------------------------------------------------------

export function parseNotifyLine(line: string): NotifyEvent | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t);
    if (!o || typeof o.id !== "string" || typeof o.message !== "string")
      return null;
    if (o.level !== "info" && o.level !== "warn" && o.level !== "error")
      return null;
    return o as NotifyEvent;
  } catch {
    return null;
  }
}

// ---- Pagination --------------------------------------------------------------
//
// RUNS per page, not lines: the row is a run, so the pager counts rows. The
// clampPage/pageCount arithmetic itself is the Audit page's (lib/audit-actions.ts) —
// one implementation, reused, rather than a second copy that rounds differently.
export const NOTIFY_RUN_PAGE_SIZE = 25;
