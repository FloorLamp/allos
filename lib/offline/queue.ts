// Pure, dependency-free core for the offline write queue (issue #28). This module
// is CLIENT-SAFE and DB-FREE: it defines the queued-intent shapes shared by the
// browser (components/OfflineQueueProvider) and the replay endpoint
// (app/api/offline-replay), plus the small decision helpers that decide when to
// enqueue, how to classify a replay result, and which entries to drop. Kept pure
// so it's unit-tested in lib/__tests__ (the IndexedDB glue lives in
// lib/offline/queue-db.ts, and the server writes in lib/offline/writes.ts).
//
// SCOPE: only these idempotent quick-log flows are queueable — a dose confirm, a
// dose SKIP (issue #232), a body-metric quick-add, and a vitals quick-add.
// Anything with server-derived state stays online-only. Payloads carry the
// CAPTURED raw fields + date so a late replay lands on the day the user logged it
// (issue #28, point 5), never the replay date.

export type FlowKind = "dose" | "skip-dose" | "body-metric" | "vitals";

export const FLOW_KINDS: readonly FlowKind[] = [
  "dose",
  "skip-dose",
  "body-metric",
  "vitals",
];

// A dose confirm ("dose") is a SET-TO-TAKEN intent and a dose skip ("skip-dose",
// issue #232) is a SET-TO-SKIPPED intent — neither is a toggle: replaying inserts
// the per-(dose,date) log if absent and is otherwise a no-op, so a queued tap can
// never flip a resolved dose back off (or overwrite the other resolution). Both
// share this payload; `flow` discriminates which write core applies. The date is
// the client's local date at capture time.
export interface DosePayload {
  doseId: number;
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
}

export type IntentPayload = DosePayload | BodyMetricPayload | VitalsPayload;

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

// Build a fully-formed intent from a flow + captured date + payload. Stamped with a
// fresh idempotency key and the capture timestamp. `now` is injectable for tests.
export function buildIntent(
  flow: FlowKind,
  date: string,
  payload: IntentPayload,
  now: Date = new Date()
): QueuedIntent {
  return {
    key: newIdempotencyKey(),
    flow,
    date,
    capturedAt: now.toISOString(),
    payload,
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
}

// A settled intent is one that must be removed from the queue: it either applied
// (done), was already applied (duplicate), or can never apply (rejected). Only
// `error` (transient) is retried, so it stays queued.
export function isSettled(status: ReplayStatus): boolean {
  return status === "done" || status === "duplicate" || status === "rejected";
}

// Given the per-intent results of a replay POST, the idempotency keys to delete
// from IndexedDB. Unknown/missing keys are left queued (fail safe).
export function settledKeys(results: readonly ReplayResult[]): string[] {
  return results.filter((r) => isSettled(r.status)).map((r) => r.key);
}

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
