// Pure, dependency-free core for the offline write queue (issue #28). This module
// is CLIENT-SAFE and DB-FREE: it defines the queued-intent shapes shared by the
// browser (components/OfflineQueueProvider) and the replay endpoint
// (app/api/offline-replay), plus the small decision helpers that decide when to
// enqueue, how to classify a replay result, and which entries to drop. Kept pure
// so it's unit-tested in lib/__tests__ (the IndexedDB glue lives in
// lib/offline/queue-db.ts, and the server writes in lib/offline/writes.ts).
//
// SCOPE: only these idempotent quick-log flows are queueable — a dose confirm, a
// dose SKIP (issue #232), a body-metric quick-add, a vitals quick-add, the daily
// mood check-in (issue #992, idempotent per day), a workout SESSION logged
// entirely offline ("set" — #28's original "add set" ask, landed by #1596), a
// food quick-add ("food", #1596: a one-serving food-group tap or a protein-grams
// tap), and a mobility move tapped ON ("mobility", #2130: set semantics per
// (profile, date, move)).
// Anything with server-derived state stays online-only. The COVERAGE RECORD
// below (#2130) is this scope sentence with teeth: every ONE_TAP_AFFORDANCES
// entry is either mapped to its flow or excluded with a written argument, and
// the mapping is type-checked. Payloads carry the
// CAPTURED raw fields + date so a late replay lands on the day the user logged it
// (issue #28, point 5), never the replay date.
//
// DELIBERATE EXCLUSIONS (#1596 — documented here so they're policy, not ambient):
//   • Editing an activity that already has a SERVER row is not queueable. The
//     training log's persistence model is create-then-update against a
//     server-created row id, with wholesale set replacement on every save — a
//     replayed stale update would be a destructive overwrite of state that may
//     have moved (another device, an integration re-ingest), not a capture. So
//     the "set" flow queues only a session the server NEVER saw (the form closed
//     offline before its first save could create the row): that whole session is
//     pure captured fields — the client's own set ordering is the submitted array
//     order, exactly what the online path derives set_number from. Mid-session
//     edits to an already-created row are covered by the form's own retrying
//     auto-save plus the #1699 local draft, not the queue.
//   • The food/protein "−" undo taps are not queueable. An undo is a DECREMENT
//     against whatever total stands at replay time, not a capture of raw fields;
//     replaying one against state that changed while offline could remove a
//     serving the user never saw. Only the additive "+" taps queue; an offline
//     "−" still fails honestly at the surface.

// Type-only (fully erased at build, so this module stays runtime-dependency-free):
// the dose write cores' typed answer and the activity save core's typed answer,
// which the replay dispositions below map onto the queue's own vocabulary — plus
// the one-tap registry's key unions, which the coverage record below is checked
// against.
import type { DoseTakenOutcome, SaveActivityOutcome } from "@/lib/types";
import type { IdempotentTap, OneTapAffordance } from "@/lib/one-tap";
// The two runtime imports, and both keep the contract: lib/sw-update.ts and
// lib/loggable-domains.ts are themselves pure and dependency-free (client-safe,
// DB-free). The stale-action signature is sw-update's knowledge — deployment
// skew's Server Action half — and the argued-exclusion brand is the #2130
// registry vocabulary's.
import { isStaleActionError } from "@/lib/sw-update";
import { arguedExclusion, type ArguedExclusion } from "@/lib/loggable-domains";

export type FlowKind =
  | "dose"
  | "skip-dose"
  | "body-metric"
  | "vitals"
  | "mood"
  | "set"
  | "food"
  | "mobility";

export const FLOW_KINDS: readonly FlowKind[] = [
  "dose",
  "skip-dose",
  "body-metric",
  "vitals",
  "mood",
  "set",
  "food",
  "mobility",
];

// ── THE COVERAGE RECORD (#2130) ──────────────────────────────────────────────
//
// The queue's scope sentence above and the DELIBERATE EXCLUSIONS block were
// policy prose with no tooth: nothing connected them to `ONE_TAP_AFFORDANCES`,
// so three one-tap surfaces (substance units, practice sessions, mobility moves
// — the last DECLARED idempotent, the queue's own stated admission criterion)
// were simply unmentioned. This record is the declare-or-argue fix, type-checked
// rather than scanned because both sides are const-asserted registries (#2130
// owner direction): every one-tap affordance maps to the flow that captures it
// or to an `arguedExclusion(...)` whose reason is structurally required. A new
// affordance — idempotent or otherwise — fails `tsc` here until someone decides.
//
// Proven on the defect: with the pre-#2130 tree's nine affordances plus the two
// #2130 adds, this record without the `substance-unit`, `practice-session`,
// `mobility-move`, `mood-valence` and `period-lifecycle` rows fails typecheck
// with "Property '<id>' is missing in type ..." — exactly the audit's gap list.
//
// `IdempotentTap` (derived in lib/one-tap.ts) is the owner-specified minimum —
// `Record<IdempotentTap, FlowKind | ArguedExclusion>` — and the record covers
// the full `OneTapAffordance` axis, which subsumes it; the compile-time check
// below pins that the idempotent half stays a subset of what's declared here.
export const OFFLINE_QUEUE_COVERAGE = {
  "food-serving": "food",
  "protein-grams": "food",
  // The one-tap DOSE resolutions ride two flows: "dose" (set-to-taken) and
  // "skip-dose" (set-to-skipped); the affordance's row names the confirm flow.
  "dose-status": "dose",
  "mood-valence": "mood",
  // #2130: declared idempotent — the queue's own admission criterion — so it is
  // a member. The ON tap (set-add) queues; the OFF tap stays online-only under
  // the existing "−" exclusion above (a removal replayed against state that
  // moved could drop a move re-added from another device — not a capture).
  "mobility-move": "mobility",
  "substance-unit": arguedExclusion(
    "The tap's own feedback is server-derived: the card renders the week count and the #998 cap verdict beside the button, and a queued unit would leave that safety readout silently understating until replay. The queue's scope line — anything with server-derived state stays online-only — applies to the surface, not just the write."
  ),
  "practice-session": arguedExclusion(
    "Cadenced, not idempotent: the #2007 layer-3 re-log confirm asks a same-DAY question from the server-known session count, which an offline capture cannot answer honestly — a replay could double-log a day already logged from another device with no confirm ever shown."
  ),
  "prn-dose": arguedExclusion(
    "A PRN administration arms the #798 redose window from its recorded_at — the safety-relevant instant (#2020). The control renders that advisory from server state at tap time; offline it would be stale, and a queued administration would guard nothing until replay. Deliberately online-only."
  ),
  "symptom-severity": arguedExclusion(
    "Deferred to #1860, which owns the symptom quick-log's offline story; deciding it here would preempt that issue's scope (#2130 excludes it by name)."
  ),
  "medication-refill": arguedExclusion(
    "A refill is stock arithmetic against the server's current supply plus the #1893 recency confirm — an increment applied to a total that may have moved, the same class as the excluded food '−' decrement, not a capture of raw fields."
  ),
  "period-lifecycle": arguedExclusion(
    "A lifecycle write rendered from server state (#1892): the offer's verb is only valid against the state that produced it, and the write core's typed refusals need fresh state to refuse honestly. Replaying start/end against state that moved is the destructive-overwrite class the queue's scope comment excludes."
  ),
} as const satisfies Record<OneTapAffordance, FlowKind | ArguedExclusion> &
  Record<IdempotentTap, FlowKind | ArguedExclusion>;

// A dose confirm ("dose") is a SET-TO-TAKEN intent and a dose skip ("skip-dose",
// issue #232) is a SET-TO-SKIPPED intent — neither is a toggle: replaying inserts
// the per-(dose,date) log if absent and is otherwise a no-op, so a queued tap can
// never flip a resolved dose back off (or overwrite the other resolution). Both
// share this payload; `flow` discriminates which write core applies. The date is
// the client's local date at capture time.
export interface DosePayload {
  doseId: number;
  // The instant the user actually TAPPED (ISO), captured at tap and stamped onto the
  // log's recorded_at when the replay lands (#1427) — a dose taken in a hospital waiting
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
  // The sitting's stated instant (#2235): ISO instant, or null for the form's
  // explicitly-empty Time. Absent on intents queued before the field existed —
  // replay then makes no statement about time at all. Validated server-side by
  // the same acceptance gate the online path runs; never trusted.
  occurredAt?: string | null;
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
  // The sitting's stated instant (#2154) — the ONE WhenControl time the form
  // posts for the whole submission, generalizing the retired per-measure
  // `temperatureTime` rather than growing siblings per vital. ISO instant, or
  // null for the form's explicitly-empty Time. Absent on intents queued before
  // the fold — replay then falls back to the legacy fields below. Validated
  // server-side by the same acceptance gate the online path runs; never trusted.
  occurredAt?: string | null;
  // LEGACY: the per-measure "HH:MM" times the pre-fold form captured — the
  // temperature's fever-curve time (#800/#843) and the peak-flow blow time
  // (#1850). A NEW intent never carries them; an intent queued before the fold
  // still sits in IndexedDB, and the replay keeps accepting both so its stated
  // times survive (insertVitals maps them at the boundary).
  temperatureTime?: string | null;
  // Peak expiratory flow (#1850). OPTIONAL for the same backward-compatibility
  // reason as the fitness markers below: an intent queued before it shipped
  // carries neither, and the server core treats an absent field exactly as an
  // unfilled one.
  peakFlow?: string | null;
  peakFlowTime?: string | null;
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

// Workout session logged entirely offline (#1596, landing #28's "add set"). The
// payload is the EXACT string fields the activity form submits to saveActivity —
// captured verbatim from the form's own FormData at close time, so the replay
// rebuilds the identical request and runs the identical write core
// (lib/activity-write.ts::saveActivityCore) with zero re-encoding drift. The sets
// ride inside `fields.sets` (the form's JSON array, whose order IS the set order),
// and `fields.weight_unit` carries the unit each load was captured in (#630).
// CREATE-ONLY by construction: the capture never includes `id` or `profile_id`
// (the replay strips them again, belt-and-braces), so a replayed intent can only
// insert a new session on the intent's stamped profile — never retarget an
// existing row. See the scope comment's exclusion note.
//
// REPLAYS AS A COMPLETED SESSION: the capture fires on the editor's CLOSE path,
// so the intent's own capturedAt is the moment the session ended — and the
// replay (lib/offline/writes.ts::applySetIntent) stamps it as the row's end_time
// when the captured fields carry a start but no end/duration. Without that, the
// replayed row would be the live-draft signature (started, unended,
// duration-less) and workout presence (#921) would resurrect it as an ACTIVE
// workout at reconnect — the app-wide dock and the stale-workout nag, hours
// after the user walked away.
export interface SetPayload {
  fields: Record<string, string>;
}

// Food quick-add (#1596) — the two additive one-tap logging controls that share
// this flow, discriminated by `entry`:
//   "serving" — one serving of a food-group (the FoodLogBar "+" tap): `groupKey`
//               is the catalog slug, `mealSlot` the meal window active at tap
//               (asserted at replay like the Telegram nudge's baked-in slot).
//   "protein" — N grams of direct protein (the ProteinQuickAdd "+" tap): `grams`.
// The intent's own `capturedAt` doubles as the tap instant for the
// food_log_events frecency ledger, so a late replay ranks in the slot the user
// actually tapped, not the reconnect slot.
export interface FoodPayload {
  entry: "serving" | "protein";
  groupKey: string | null;
  mealSlot: string | null;
  grams: number | null;
  // The EATING instant the user stated at tap time (#2053), ISO — a different fact from
  // `capturedAt`, which stays the tap stamp the frecency ledger ranks on. Carried as a
  // resolved instant rather than as the choice because there is no server to resolve
  // against while offline: "now" is the client's own clock, and an "earlier…" hour is the
  // instant the SERVER computed when it rendered that option, so a profile-local hour is
  // never converted in the browser.
  //
  // The replay VALIDATES it (acceptEatenAt) exactly as `resolveQueuedTakenAt` validates a
  // queued dose's tap instant, and for the same reason: it came off an untrusted client
  // wall clock, and an instant whose profile-local date isn't the row's own `date` would
  // make the serving contradict itself. An unusable value costs the statement, never the
  // serving. OPTIONAL: absent on an intent queued before this shipped, and absent —
  // overwhelmingly — whenever the user simply didn't state a time.
  eatenAt?: string | null;
}

// Mobility move tapped ON while offline (#2130 — the coverage record's newest
// member; `mobility-move` is declared idempotent in ONE_TAP_AFFORDANCES, the
// queue's own admission criterion). The payload is the captured raw fields: the
// move's catalog slug (the day rides the intent's own `date`). Set semantics on
// the server (logMobilityMoveCore ensures the move is present in that day's
// session), so a double flush or a re-tap replays to the same state. ON-direction
// only: the un-tap is a removal against whatever session stands at replay time,
// which is the documented "−" exclusion, not a capture.
export interface MobilityPayload {
  move: string;
}

export type IntentPayload =
  | DosePayload
  | BodyMetricPayload
  | VitalsPayload
  | MoodPayload
  | SetPayload
  | FoodPayload
  | MobilityPayload;

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
    set: "Workout session",
    food: "Food log",
    mobility: "Mobility move",
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

// ── set replay: honoring the typed outcome (#1596, the #1427 pattern) ─────────
//
// The queued workout session replays through the SAME write core the live form's
// auto-save uses (lib/activity-write.ts::saveActivityCore), which answers with a
// typed SaveActivityOutcome (#332) rather than a boolean — so a refusal reaches
// the dead-letter panel with the real reason, never a silent drop or a fake
// "synced". Pure, so the mapping is unit-tested rather than inferred from the
// route. "not-owned" is unreachable for a create-only intent (it carries no row
// id), but the mapping stays total so a future outcome can't fall through silent.
export function classifySetReplay(outcome: SaveActivityOutcome): {
  status: "done" | "rejected";
  reason?: string;
} {
  if (outcome.ok) return { status: "done" };
  switch (outcome.reason) {
    case "restricted":
      return {
        status: "rejected",
        reason:
          "Activity logging isn't available for this profile, so the workout wasn't saved.",
      };
    case "not-owned":
      return {
        status: "rejected",
        reason:
          "This workout doesn't belong to a profile you can write, so it wasn't saved.",
      };
    case "invalid":
    default:
      return {
        status: "rejected",
        reason:
          "The workout entry couldn't be validated (check the title and date), so it wasn't saved.",
      };
  }
}

// The tap instant a replayed food/protein intent should ledger under (#1596): the
// intent's own capturedAt when it parses to a real moment that isn't after `now`
// (client clocks drift), else the replay instant. Keeps the food_log_events
// frecency ranking honest — a Morning tap replayed at dinner still counts for
// Morning — without ever trusting a garbage or future timestamp.
export function resolveCapturedInstant(
  capturedAt: unknown,
  now: Date = new Date()
): string {
  if (typeof capturedAt === "string") {
    const t = new Date(capturedAt);
    if (Number.isFinite(t.getTime()) && t.getTime() <= now.getTime()) {
      return t.toISOString();
    }
  }
  return now.toISOString();
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
// True when the browser reports itself offline, when the write threw a network
// error (fetch/action rejects with a TypeError when the connection is down) — or
// when the action failed because THIS TAB'S BUILD is stale: a deploy invalidates
// every Server Action id an open tab holds, so each action POST fails until the
// tab reloads, and retrying in place cannot succeed. Surfacing that as an error
// loses the tap; queueing keeps it, because the replay route
// (app/api/offline-replay) is an ordinary route handler no deploy re-keys — the
// queued intent lands from this same stale tab (the sync/flush machinery) or from
// the reloaded one. A genuine server-side rejection while ONLINE remains a real
// error the form should show.
export function shouldQueueOffline(online: boolean, err: unknown): boolean {
  if (!online) return true;
  // A dropped connection surfaces as a TypeError ("Failed to fetch") from fetch and
  // from a Server Action's underlying fetch; treat that as offline too, since
  // navigator.onLine can lag the actual link state.
  if (err instanceof TypeError) return true;
  return isStaleActionError(err);
}
