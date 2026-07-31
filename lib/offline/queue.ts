// Pure, dependency-free core for the offline write queue (issue #28). This module
// is CLIENT-SAFE and DB-FREE: it defines the queued-intent shapes shared by the
// browser (components/OfflineQueueProvider) and the replay endpoint
// (app/api/offline-replay), plus the small decision helpers that decide when to
// enqueue, how to classify a replay result, and which entries to drop. Kept pure
// so it's unit-tested in lib/__tests__ (the IndexedDB glue lives in
// lib/offline/queue-db.ts, and the server writes in lib/offline/writes.ts).
//
// SCOPE: only these idempotent quick-log flows are queueable — a dose confirm, a
// dose SKIP (issue #232), a body-metric quick-add, a vitals quick-add, and the
// daily mood check-in (issue #992, idempotent per day).
// Anything with server-derived state stays online-only. Payloads carry the
// CAPTURED raw fields + date so a late replay lands on the day the user logged it
// (issue #28, point 5), never the replay date.

// Type-only (fully erased at build, so this module stays runtime-dependency-free):
// the dose write cores' typed answer, which the replay disposition below maps onto
// the queue's own vocabulary.
import type { DoseTakenOutcome } from "@/lib/types";

export type FlowKind = "dose" | "skip-dose" | "body-metric" | "vitals" | "mood";

export const FLOW_KINDS: readonly FlowKind[] = [
  "dose",
  "skip-dose",
  "body-metric",
  "vitals",
  "mood",
];

// A dose confirm ("dose") is a SET-TO-TAKEN intent and a dose skip ("skip-dose",
// issue #232) is a SET-TO-SKIPPED intent — neither is a toggle: replaying inserts
// the per-(dose,date) log if absent and is otherwise a no-op, so a queued tap can
// never flip a resolved dose back off (or overwrite the other resolution). Both
// share this payload; `flow` discriminates which write core applies. The date is
// the client's local date at capture time.
export interface DosePayload {
  doseId: number;
  // The instant the user actually TAPPED (ISO), captured at tap and stamped onto the
  // log's given_at when the replay lands (#1427) — a dose taken in a hospital waiting
  // room at 08:12 must not read as taken at 19:40 when the phone finds signal again.
  // The server VALIDATES it (lib/dose-log-window's resolveQueuedTakenAt) and falls
  // back to the replay instant when it's unusable. OPTIONAL: absent on an intent
  // queued before this shipped, and unused by "skip-dose" (a skip records no intake).
  clientTakenAt?: string;
}

// Body-metric quick-add — the raw display-unit fields exactly as the form submits
// them, plus the weight unit captured at enqueue time so replay converts to kg the
// same way the online action would (the user's pref could change before reconnect).
export interface BodyMetricPayload {
  weight: string;
  weightUnit: "kg" | "lb";
  bodyFatPct: string | null;
  restingHr: string | null;
  notes: string | null;
}

// Vitals quick-add — the raw form fields; normalization/validation happen on the
// server via the same pure normalizeVitalsInput the online action uses.
export interface VitalsPayload {
  systolic: string | null;
  diastolic: string | null;
  glucose: string | null;
  glucoseUnit: string | null;
  spo2: string | null;
  temperature: string | null;
  tempUnit: string | null;
  sleepHours: string | null;
  hrv: string | null;
  // The optional "HH:MM" reading time a temperature carries for the fever curve
  // (#800/#843) — captured so a replayed reading keeps its clock time.
  temperatureTime?: string | null;
  // The three #158 functional-fitness markers. OPTIONAL since #1486: they left the
  // daily measurements form for the guided Fitness check (assessment cadence), so a
  // NEW queued intent never carries them — but an intent queued before the upgrade
  // still sits in IndexedDB, and the replay must keep accepting it. The server core
  // (insertVitals) is unchanged and still stores them under the same canonical
  // names, so an old queued entry replays exactly as it would have.
  gripStrength?: string | null;
  chairStand?: string | null;
  balance?: string | null;
}

// Mood check-in (issue #992) — the captured raw fields of the daily wellbeing
// tap/expand. Idempotent PER DAY on the server's UNIQUE(profile_id, date) upsert:
// replaying the same intent (or a later same-day one) updates the day's single
// row, never duplicates it. Validation happens server-side via the same pure
// normalizeMoodInput the online action uses.
export interface MoodPayload {
  valence: number;
  energy: number | null;
  anxiety: number | null;
  factors: string[];
  note: string | null;
}

export type IntentPayload =
  DosePayload | BodyMetricPayload | VitalsPayload | MoodPayload;

// The maximum number of intents accepted (server) and sent (client) per replay POST
// — the SINGLE source of truth for both sides so they can never disagree (issue
// #604). The replay route rejects a larger batch with 413; the client chunks the
// queue into POSTs of at most this size so a long offline stretch of 200+ intents
// drains across several requests instead of dead-ending on a permanent 413. The
// per-intent `replayed_keys` idempotency ledger makes partial batches safe to send.
export const MAX_INTENTS = 200;

// Split a queue into ordered chunks of at most `size` (default MAX_INTENTS),
// preserving order — N intents yield ceil(N/size) chunks (issue #604). Pure so the
// chunking math is unit-tested; the client iterates the chunks, POSTing each until
// the queue drains or a chunk fails.
export function chunkIntents<T>(
  items: readonly T[],
  size: number = MAX_INTENTS
): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error("chunkIntents: size must be a positive integer");
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// One queued write. `key` is the client-generated idempotency key (a uuid) the
// server records in `replayed_keys` to guarantee exactly-once. `date` is the
// captured local date (YYYY-MM-DD) the write lands on; `capturedAt` is the full
// client timestamp (diagnostics only). `flow` discriminates the payload.
export interface QueuedIntent {
  key: string;
  flow: FlowKind;
  date: string;
  capturedAt: string;
  payload: IntentPayload;
  // The profile the write was CAPTURED under — stamped at enqueue time from the
  // active profile (issue #599). Replay applies the write to THIS profile (verifying
  // the login still has write access to it), never to whatever profile happens to be
  // active at flush time — so a caregiver's B-vitals can never land on A after a
  // profile switch or a re-login. OPTIONAL only for backward compatibility: an intent
  // queued before this field shipped has no profileId, and the replay route falls
  // back to the active profile for those legacy entries (there's no other profile to
  // attribute them to). Every intent built by buildIntent going forward carries it.
  profileId?: number;
  // How many times a flush reached the server and got a retryable "error" for this
  // intent (issue #475 point 3). Absent/0 on a fresh enqueue. Once it hits
  // MAX_REPLAY_ATTEMPTS the intent is reclassified as rejected (moved to the
  // dead-letter store) so a permanently-erroring entry can't sit behind the amber
  // badge forever with no explanation.
  attempts?: number;
}

// A uuid for the idempotency key. Prefers crypto.randomUUID (all evergreen
// browsers + Node 24); falls back to a random-hex composition where it's absent so
// the queue never throws in an exotic runtime.
export function newIdempotencyKey(): string {
  const c: Crypto | undefined =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as Crypto | undefined)
      : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback: RFC-4122-ish v4 from Math.random (only reached without WebCrypto).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Build a fully-formed intent from a flow + captured date + payload + the profile it
// was captured under (issue #599). Stamped with a fresh idempotency key and the
// capture timestamp. `now` is injectable for tests.
export function buildIntent(
  flow: FlowKind,
  date: string,
  payload: IntentPayload,
  profileId: number,
  now: Date = new Date()
): QueuedIntent {
  return {
    key: newIdempotencyKey(),
    flow,
    date,
    capturedAt: now.toISOString(),
    payload,
    profileId,
    attempts: 0,
  };
}

// The browser's local date as YYYY-MM-DD — the capture date for a dose confirm,
// which (unlike the body/vitals forms) has no date field. `now` is injectable.
export function localDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// The outcome the server reports for a single replayed intent.
//   done      — write applied for the first time
//   duplicate — key already in replayed_keys (a prior flush won the race); no-op
//   rejected  — payload failed server-side validation; will NEVER succeed
//   error     — transient server failure; keep and retry on the next flush
export type ReplayStatus = "done" | "duplicate" | "rejected" | "error";

export interface ReplayResult {
  key: string;
  status: ReplayStatus;
  // Optional coarse reason for a `rejected` status, set by the replay route so the
  // client can tell the user WHY an entry couldn't be applied (issue #475).
  reason?: string;
}

// A settled intent is one that must be removed from the LIVE queue: it either
// applied (done), was already applied (duplicate), or can never apply (rejected).
// Only `error` (transient) is retried, so it stays queued. NOTE: a `rejected` entry
// leaves the live queue but is NOT discarded — planFlushDisposition moves it to the
// dead-letter store so the user can review/re-enter it (issue #475).
export function isSettled(status: ReplayStatus): boolean {
  return status === "done" || status === "duplicate" || status === "rejected";
}

// Given the per-intent results of a replay POST, the idempotency keys to delete
// from IndexedDB. Unknown/missing keys are left queued (fail safe).
export function settledKeys(results: readonly ReplayResult[]): string[] {
  return results.filter((r) => isSettled(r.status)).map((r) => r.key);
}

// After this many flushes that reached the server and returned a retryable "error"
// for the SAME intent, give up and reclassify it as rejected (issue #475 point 3).
export const MAX_REPLAY_ATTEMPTS = 5;

// A permanently-undeliverable entry, preserved for the user to review and re-enter
// (issue #475). It carries the FULL original intent — so every captured field the
// user tried to log survives the drop — plus a human reason and when we gave up.
export interface RejectedEntry {
  intent: QueuedIntent;
  reason: string;
  rejectedAt: string;
}

// The disposition of one flush: which live-queue keys to delete, which intents to
// re-persist with a bumped attempt count, which entries to park in the dead-letter
// store, and how many actually synced. Pure so the client is a thin applier and the
// whole policy is unit-tested (issue #475). `resultByKey` ignores results for keys
// no longer in the queue (fail-safe) and intents with no matching result (kept).
export interface FlushDisposition {
  syncedCount: number; // done + duplicate — the "Synced N" success toast count
  deleteKeys: string[]; // remove from the LIVE queue (synced + rejected + exhausted)
  rejected: RejectedEntry[]; // move into the dead-letter store (server-rejected + exhausted)
  retry: QueuedIntent[]; // re-put with attempts incremented (still under the cap)
}

const DEFAULT_REJECT_REASON = "The server couldn't apply this entry.";

export function planFlushDisposition(
  intents: readonly QueuedIntent[],
  results: readonly ReplayResult[],
  now: Date = new Date()
): FlushDisposition {
  const byKey = new Map(intents.map((i) => [i.key, i]));
  const rejectedAt = now.toISOString();
  const disposition: FlushDisposition = {
    syncedCount: 0,
    deleteKeys: [],
    rejected: [],
    retry: [],
  };
  for (const r of results) {
    const intent = byKey.get(r.key);
    if (r.status === "done" || r.status === "duplicate") {
      disposition.syncedCount++;
      disposition.deleteKeys.push(r.key);
      continue;
    }
    if (r.status === "rejected") {
      disposition.deleteKeys.push(r.key);
      // A truly shapeless intent may have no matching live row; still record the
      // key delete above, and only park it when we have the payload to preserve.
      if (intent) {
        disposition.rejected.push({
          intent,
          reason: r.reason || DEFAULT_REJECT_REASON,
          rejectedAt,
        });
      }
      continue;
    }
    // status === "error" — transient. Bump the attempt count; give up past the cap.
    if (!intent) continue; // no live row to retry — leave whatever's there
    const attempts = (intent.attempts ?? 0) + 1;
    if (attempts >= MAX_REPLAY_ATTEMPTS) {
      disposition.deleteKeys.push(intent.key);
      disposition.rejected.push({
        intent: { ...intent, attempts },
        reason: `Couldn't be applied after ${attempts} attempts.`,
        rejectedAt,
      });
    } else {
      disposition.retry.push({ ...intent, attempts });
    }
  }
  return disposition;
}

// A short human description of what an intent tried to log, for the review list —
// the user needs to recognise which entry was dropped so they can re-enter it. Only
// the flow + captured date (no per-field PHI beyond what the user already sees).
export function describeIntent(intent: QueuedIntent): string {
  const label: Record<FlowKind, string> = {
    dose: "Dose logged",
    "skip-dose": "Dose skipped",
    "body-metric": "Body metric",
    vitals: "Vitals",
    mood: "Mood check-in",
  };
  return `${label[intent.flow]} · ${intent.date}`;
}

// ── dose replay: honoring the typed outcome (#1427) ──────────────────────────
//
// The queued dose flows replay through the SAME write cores every other confirm path
// uses (markDoseTaken / markDoseSkipped), which answer with a typed DoseTakenOutcome
// rather than a boolean — precisely so a tap on a dose that has since been retired,
// or whose item was paused, is never acknowledged as "Logged" (the two-way principle,
// `docs/internals/supplements.md`). A replay is exactly that situation with a longer
// gap, so the outcome must reach the USER: this maps it onto the queue's own
// disposition vocabulary, and every refusal carries the reason the dead-letter panel
// shows.
//
//   • logged / skipped                  → done (the write landed)
//   • the SAME resolution already stands → done, idempotently. A confirm that finds
//     the dose already taken is already-done, not a duplicate log — the whole point
//     of a set-to intent.
//   • the OTHER resolution stands        → rejected. A queued ✅ must not be reported
//     as applied when the day is recorded as skipped (and vice versa); the set-to
//     intent deliberately doesn't overwrite, so the honest answer is "we couldn't
//     apply this", with the payload preserved for review (#280 + #475).
//   • stale-dose / inactive              → rejected with the real reason.
//
// Pure, so the whole mapping is unit-tested rather than inferred from the route.
export function classifyDoseReplay(
  flow: "dose" | "skip-dose",
  outcome: DoseTakenOutcome
): { status: "done" | "rejected"; reason?: string } {
  const taking = flow === "dose";
  switch (outcome) {
    case "logged":
    case "skipped":
      return { status: "done" };
    case "already-taken":
      return taking
        ? { status: "done" }
        : {
            status: "rejected",
            reason:
              "This dose is already recorded as taken, so the offline skip wasn't applied.",
          };
    case "already-skipped":
      return taking
        ? {
            status: "rejected",
            reason:
              "This dose is already recorded as skipped, so the offline confirm wasn't applied.",
          }
        : { status: "done" };
    case "inactive":
      return {
        status: "rejected",
        reason: taking
          ? "This item is paused, so the dose wasn't logged."
          : "This item is paused, so the skip wasn't recorded.",
      };
    case "stale-dose":
    default:
      return {
        status: "rejected",
        reason:
          "This dose is no longer on the schedule (it was removed or changed), so it couldn't be saved.",
      };
  }
}

// The refusal shown when a queued dose entry sat unsent past the dose-log date window
// — the write cores bound how far a log may land from the profile's today (#614), so
// a very stale queue entry can't silently backdate a medication record. Split out from
// the generic stale-dose reason because the remedy is different: the dose still
// exists, it's the ENTRY that's too old, and the medication's dose history is where a
// deliberate retro entry belongs.
export const STALE_QUEUED_DOSE_REASON =
  "This dose entry is too old to log automatically. Re-enter it from the medication's dose history.";

// Is this HTTP status the "session expired / not authorized" signal? On it the
// flush keeps EVERY entry queued and prompts the user to log in — a queued write is
// never dropped just because the cookie lapsed while offline (issue #28 constraint).
export function isAuthFailure(httpStatus: number): boolean {
  return httpStatus === 401 || httpStatus === 403;
}

// Should a failed submit be queued for later rather than surfaced as an error?
// True only when the browser reports itself offline OR the write threw a network
// error (fetch/action rejects with a TypeError when the connection is down). A
// genuine server-side rejection while ONLINE is a real error the form should show.
export function shouldQueueOffline(online: boolean, err: unknown): boolean {
  if (!online) return true;
  // A dropped connection surfaces as a TypeError ("Failed to fetch") from fetch and
  // from a Server Action's underlying fetch; treat that as offline too, since
  // navigator.onLine can lag the actual link state.
  return err instanceof TypeError;
}
