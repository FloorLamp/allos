// OPENING THE QUICK LOGGER WITH NO SERVER (#3416). Pure, CLIENT-SAFE and DB-FREE.
//
// The sheet's forms take their props from `loadQuickEntry`, a Server Action, which a
// dead connection rejects. This module is what the sheet can answer FROM INSTEAD, in
// two layers the host (components/QuickEntryProvider.tsx) tries in order:
//
//   1. LAST-GOOD — the result of an earlier successful open in this page's life, held
//      in memory and keyed by the #5211 day-context key plus the form. A reopen renders
//      it at once and revalidates behind it.
//   2. THE DEVICE'S OWN COPY — the #2908 read snapshots (dose schedule, practice week)
//      mapped onto the form's payload with the queue's pending intents folded in, and
//      for the two declared flows with no snapshot kind (mood, stool) what the device
//      itself knows: the day, and its own queued taps. Everything else is a miss, and
//      the host renders the retry state.
//
// THE KEY IS A CACHE KEY, NEVER A RECORD KEY (#5211 clause 5). Every entry stores its
// parts beside the key; a key that no longer matches — a new day, a new reach shape —
// is a miss the next open refetches, not a loss. Nothing durable is identified by it.
//
// NO SECOND STORE. Layer 1 is memory (the host is mounted for the page's life) and
// layer 2 reads the snapshot and intent stores that already exist — nothing here
// writes a byte to the device.

import type { QuickEntryData } from "@/app/(app)/quick-entry-actions";
import {
  dayContextKey,
  type DayContextKey,
  type DayContextParts,
} from "@/lib/day-context-key";
import { shiftDateStr } from "@/lib/date";
import { isWithinReach } from "@/lib/log-manifest";
import { MOOD_LOG_DATE_WINDOW_DAYS, moodBackfillLabel } from "@/lib/mood";
import type { MoodPayload, QueuedIntent } from "@/lib/offline/queue";
import {
  intentBelongsToProfile,
  overlayDoseSchedule,
  overlayPracticeWeek,
  type AnySnapshot,
  type SnapshotEnvelope,
  type SnapshotKind,
} from "@/lib/offline/snapshots";
import type { TrackedPractice } from "@/lib/queries/wellness";
import type { QuickEntryForm } from "@/lib/quick-log";

// ── Layer 1: last-good ───────────────────────────────────────────────────────

export interface LastGoodEntry {
  readonly parts: DayContextParts;
  readonly form: QuickEntryForm;
  readonly data: QuickEntryData;
  readonly fetchedAt: Date;
}

// Module state rather than a ref inside the host, for one reason: the device wipe
// (components/device-wipe.ts) has to reach it. Logout, a revoked session and a
// profile switch all drop it — the same boundary the read snapshots have.
const lastGood = new Map<DayContextKey, Map<QuickEntryForm, LastGoodEntry>>();

// THE STORE'S GENERATION, and why clearing it is not enough on its own.
//
// Module state outlives the host, which is the point of putting it here — and it is
// also what makes the wipe a race. The wipe fires at the BEGINNING of a sign-out and
// the document stays mounted and interactive for the whole round trip, so a gather
// that started before Log out and answers after it would walk straight past
// `clearLastGood` and write the previous identity's payload back into the cleared
// store. First writer wipes, second writer restores — components/ProfileSwitchWatcher
// names that shape, lib/offline/write-gate.ts is the durable answer to it, and this is
// the same answer one layer in: a write CARRIES the generation it was issued under
// (`captureLastGoodToken`, taken before the work) and lands only while that is still
// the generation the store is on.
//
// The scope is right for what it guards: this map is one document's memory, so a
// generation in the same memory covers exactly it. What a generation alone cannot see
// is a gather that STARTS after the wipe (the session is still alive for the rest of
// the round trip and answers it), so the host also empties the store on every mount —
// sign-out is a client navigation, not a document load, and the next sign-in mounts a
// new host in the SAME document. Neither half is the whole fence.
let generation = 0;

/** The generation a write must still be at to land. Opaque; mint it here. */
export type LastGoodToken = number & { readonly __lastGood: unique symbol };

/** Captured BEFORE the work, and spent by `rememberLastGood` when it comes back. */
export function captureLastGoodToken(): LastGoodToken {
  return generation as LastGoodToken;
}

/**
 * Hold `data` as the last good answer for this context — if the store is still on the
 * generation `token` was cut at. A stale token means a wipe or an identity change
 * happened while this answer was in flight, and the answer belongs to the store that
 * was cleared, not to this one.
 *
 * The token is REQUIRED and comes first: a caller that cannot say which generation its
 * payload was gathered under is exactly the caller that must not write (the rule
 * `putSnapshots` states for the durable half).
 */
export function rememberLastGood(
  token: LastGoodToken,
  parts: DayContextParts,
  form: QuickEntryForm,
  data: QuickEntryData,
  fetchedAt: Date = new Date()
): void {
  if (token !== generation) return;
  const key = dayContextKey(parts);
  const byForm = lastGood.get(key) ?? new Map<QuickEntryForm, LastGoodEntry>();
  byForm.set(form, { parts, form, data, fetchedAt });
  lastGood.set(key, byForm);
}

export function recallLastGood(
  parts: DayContextParts,
  form: QuickEntryForm
): LastGoodEntry | undefined {
  return lastGood.get(dayContextKey(parts))?.get(form);
}

/** Empty the store AND move the generation, so nothing in flight can refill it. */
export function clearLastGood(): void {
  lastGood.clear();
  generation += 1;
}

// ── Layer 2: the device's own copy ───────────────────────────────────────────

export interface OfflineQuickEntry {
  readonly data: QuickEntryData;
  // When the snapshot this was read from was captured, or null when the payload is
  // built from the device's own knowledge (its day and its queue) rather than from a
  // stored server read.
  readonly fetchedAt: string | null;
  // WHAT THE SHEET SAYS ABOUT THIS COPY, written here beside the payload it describes
  // — where each omission is argued — rather than as one sentence at the host for all
  // four forms. With a `fetchedAt` it is the `why` half of the #2908 as-of line
  // ("As of 5 minutes ago — …"); without one it is the whole line, because a copy
  // built from the device's own knowledge has no capture instant to date.
  readonly says: string;
}

// The stored snapshot of `kind` that may stand in for the sheet's context, or null.
// Two questions, asked separately because they are different questions even where
// today's `SHEET_REACH` makes them coincide: may the sheet OFFER the snapshot's day at
// all (`isWithinReach`, the #5211 clause-4 door — never re-derived here), and is that
// day the one on screen (the clause-3 rule: a today payload never fills a yesterday
// form). A snapshot for another profile is a miss before either is asked.
function servingSnapshot<
  K extends SnapshotKind & ("dose-schedule" | "practice-week"),
>(
  snapshots: readonly AnySnapshot[],
  kind: K,
  parts: DayContextParts
): SnapshotEnvelope<K> | null {
  for (const env of snapshots) {
    if (env.kind !== kind || env.profileId !== parts.profileId) continue;
    const day = env.data.date;
    if (!isWithinReach(parts.reach, parts.day, day) || day !== parts.day)
      continue;
    return env as SnapshotEnvelope<K>;
  }
  return null;
}

// The whole as-of line for the two forms built from the device's OWN knowledge rather
// than a stored server read (mood, stool): there is no capture instant to date, and
// what bounds them is not age but reach — this device's day and its own queued taps.
const DEVICE_ONLY_LINE = "Offline — showing only what's queued on this device.";

/**
 * What the sheet can render for `form` with no server, or null when the honest
 * answer is the retry state.
 *
 * `actingProfileId` bounds the device-known layer: the queue captures under the acting
 * profile and refuses a cross-profile write, so a mood or stool form built for anyone
 * else would be a door onto a refusal. The snapshot layer needs no such bound — every
 * envelope is stamped with its profile and `servingSnapshot` matches on it.
 */
export function quickEntryOffline(
  form: QuickEntryForm,
  parts: DayContextParts,
  actingProfileId: number,
  snapshots: readonly AnySnapshot[],
  intents: readonly QueuedIntent[]
): OfflineQuickEntry | null {
  const mine = intents.filter((i) =>
    intentBelongsToProfile(i, parts.profileId)
  );
  switch (form) {
    case "dose": {
      const env = servingSnapshot(snapshots, "dose-schedule", parts);
      if (!env) return null;
      const pending = overlayDoseSchedule(
        env.data,
        mine,
        parts.profileId
      ).entries.filter((e) => e.status === "pending");
      return {
        says: "this device's copy of today. Earlier days need a connection.",
        fetchedAt: env.fetchedAt,
        data:
          pending.length === 0
            ? { form: "unavailable", message: "No doses are due right now." }
            : {
                form: "dose",
                today: parts.day,
                // The whole day's unresolved set, not the online arrived-slot slice:
                // the copy carries each dose's slot and no clock, and /offline shows
                // the same whole-day view. The as-of line above says what this is.
                doses: pending.map((e) => ({
                  doseId: e.doseId,
                  title: e.name,
                  detail: e.detail,
                  dueText: e.slot ?? "Today",
                })),
                // No PRN row: `prn-dose` is an argued exclusion of the offline queue
                // (lib/offline/queue.ts) — its redose advisory is server state.
                //
                // AND NO RECENT-PAST DAYS, argued the same way rather than left bare.
                // The switcher's other days are resolved server-side from `doseLogDays`
                // against the same gate the write cores use, and a `dose-schedule`
                // snapshot holds exactly ONE day: this one. A pill for yesterday over a
                // day this device has no rows for would open onto an empty list, which
                // reads as "nothing was due then" — the misreading the online payload's
                // own comment refuses. So the day switcher is not offered AND the
                // absence is said out loud on the as-of line below, because someone
                // who opened the sheet to log yesterday's forgotten dose otherwise
                // finds no way back and no reason why.
                pastDays: [],
              },
      };
    }
    case "practice": {
      const env = servingSnapshot(snapshots, "practice-week", parts);
      if (!env) return null;
      const week = overlayPracticeWeek(env.data, mine, parts.profileId);
      const practices: TrackedPractice[] = week.practices.map((p) => ({
        // Nothing in the sheet addresses the target row; the copy carries no id.
        targetId: 0,
        identity: p.identity,
        name: p.name,
        perWeek: p.perWeek,
        perWeekMax: null,
        countThisWeek: p.countThisWeek,
        atCeiling: false,
        // FACTS, NEVER VERDICTS (#2908 decision 5): the snapshot drops `pace` on
        // purpose, and "behind" needs the week's calendar, which it does not carry.
        // "met" is the one reading that is a fact (count against target); otherwise
        // the quiet default the badge shows whenever the lag is not informative.
        pace: p.countThisWeek >= p.perWeek ? "met" : "on-pace",
        todayCount: p.todayCount,
        previousDurationMin: null,
        liveSession: null,
      }));
      return {
        says: "this device's offline copy.",
        fetchedAt: env.fetchedAt,
        data: { form: "practice", today: parts.day, practices },
      };
    }
    case "mood": {
      if (parts.profileId !== actingProfileId) return null;
      // The #2128 chips, the same window the gather offers; a check-in this device
      // queued for one of those days shows on it (read-your-writes), the server's are
      // unknown until it can be asked.
      const days = Array.from(
        { length: MOOD_LOG_DATE_WINDOW_DAYS + 1 },
        (_, offset) => {
          const date =
            offset === 0 ? parts.day : shiftDateStr(parts.day, -offset);
          const queued = mine.findLast(
            (i) => i.flow === "mood" && i.date === date
          );
          const mood = queued ? (queued.payload as MoodPayload) : null;
          return {
            date,
            label: moodBackfillLabel(offset),
            mood: mood
              ? {
                  valence: mood.valence,
                  energy: mood.energy,
                  anxiety: mood.anxiety,
                  factors: mood.factors,
                  notes: mood.note,
                }
              : null,
          };
        }
      );
      // THE CALM SCALE IS ASKED OF WHAT THE DEVICE KNOWS, not hard-coded off.
      // `isAnxietyScaleRelevant` (#1313) resolves six server signals and this layer
      // has none of them — but its FIRST signal is continuity ("a profile that has
      // ever used the scale keeps it forever"), and the device holds one piece of that
      // evidence: a check-in it queued itself carrying a Calm rating. So a queued
      // rating keeps the row; with nothing queued the sheet cannot tell, and shows the
      // form a profile that never used the scale sees.
      //
      const showCalm = mine.some(
        (i) => i.flow === "mood" && (i.payload as MoodPayload).anxiety != null
      );
      // `dayUnseen` IS THE FENCE ON THE WRITE, and it is the same sentence as the Calm
      // row above one step further on. This copy knows only this device's own queued
      // taps, so a rating the SERVER holds for one of these days is unknown here and
      // the form opens empty for it — which would be harmless if a check-in only ever
      // added. It does not: `upsertMoodLog` replaces the day's row, so a one-tap face
      // over a day someone wrote a paragraph about this morning would replay a null
      // energy, a null Calm, no factors and no note over it. A null here means "not
      // asked on this device", never a person's answer, and the flag is how the form
      // says that to both write paths: carried on the queued payload and posted with
      // the online one, it makes the write MERGE — landing what it carries and
      // touching nothing it does not (`MoodWriteSight`, lib/offline/writes.ts).
      return {
        says: DEVICE_ONLY_LINE,
        fetchedAt: null,
        data: { form: "mood", days, showCalm, dayUnseen: true },
      };
    }
    case "stool": {
      if (parts.profileId !== actingProfileId) return null;
      return {
        says: DEVICE_ONLY_LINE,
        fetchedAt: null,
        data: {
          form: "stool",
          today: parts.day,
          // Only what this device queued for the day — the as-of line says so.
          todayCount: mine.filter(
            (i) => i.flow === "stool" && i.date === parts.day
          ).length,
        },
      };
    }
    // Food's snapshot (`food-tallies`) answers "have I logged that serving", not
    // "what may I log": the bar's ranked catalog, exclusions and meal windows are all
    // server-resolved per profile, and a bar over an invented order would be a
    // different surface, not this one offline. The rest have no offline story at all
    // (LOG_MANIFEST's `offline` column) or gather nothing worth standing in for.
    case "food":
    case "cycle":
    case "substance":
    case "symptom":
    case "document":
    case "measurements":
      return null;
  }
}
