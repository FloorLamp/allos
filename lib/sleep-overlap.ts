import { instantMs, windowsOverlap } from "./metric-window-overlap";

// THE SAME-ORIGIN OVERLAPPING SLEEP SESSION RULE (issue #3628), pure half.
//
// WHY IT EXISTS. After a device zone change Health Connect can hold the SAME Fitbit
// night twice: a first write whose instants were derived under the old zone, and a
// corrected write a day later under the new one. `metric_samples` keys sleep on
// `started_at`, so the re-timed session is a new natural key rather than a correction,
// and the phantom becomes a whole extra "night" — `mainSleepSession` elects it for its
// own wake-day and SRI, the stage strip and the digest all read it.
//
// THE DATA DECIDES, AND ARRIVAL ORDER IS NOT DATA ABOUT SLEEP. Every earlier version of
// this rule ranked the pair by which push inserted which — a `metric_samples.id`
// watermark, or `pushed_at`. Both were refuted: the exporter re-sends a session on every
// push for 48 h and the re-send is an `ON CONFLICT DO UPDATE`, so after the corrective
// push BOTH rows carry the same stamp and nothing ranks them; and a newest-first or
// date-chunked backfill delivers the pair in the losing order, where a position rule
// deletes the real night. `docs/internals/integrations-sync.md` states "freshness NEVER
// from arrival order" without a scope, and this rule needs no exemption from it: nothing
// below reads which row arrived first.
//
// WHAT DECIDES IS THE DEVICE'S OWN HEART RATE. A person is not at 78 bpm asleep. On the
// prod pair the phantom window averaged 78 and the real one 58, against a 68 bpm awake
// reference — the evidence that identified the phantom by hand, promoted to the rule
// (owner ruling, 2026-08-31). A window is CORROBORATED when the heart rate the device
// recorded inside it is below what that same device recorded while the person was awake
// nearby. One corroborated window collapses the pair; NEITHER or BOTH deletes nothing
// and the pair is left for a person to resolve in Data → Review.
//
// IT MUST EARN A PERMANENT DELETION, because it is one. `removeImportTombstone` is
// reachable only from the undo of a captured user delete (lib/undo-delete-db.ts), so
// nothing withdraws a tombstone an ingest collapse wrote: no re-sync, re-pair or
// re-import brings back a night this rule takes. So every term below is a REFUSAL, and
// the standard is deliberately higher than "which looks more like sleep":
//
//   * BOTH windows must be observed, not just the winner. A night whose heart rate has
//     not arrived yet (the watch batches into the phone independently of the exporter's
//     push — measured single pushes carried 324, 195, 183, 165 and 164 minutes at once,
//     and 9% carry none) would otherwise read as "not corroborated" and be deleted by a
//     phantom that happens to sit on an evening. Requiring both closes that outright.
//   * The reference is the person's OWN awake heart rate, not a bpm constant. There is
//     no threshold here to be wrong for an athlete or for someone with a fever.
//   * EXACTLY ONE may be corroborated. That is what makes a weak comparison safe: a
//     phantom sitting on a genuinely restful span is corroborated TOO, and two
//     corroborated windows delete nothing. Every way the comparison can be too generous
//     resolves toward keeping both rows.
//
// A pair left standing is visible — two nights where there was one, and Data → Review
// says so — and a person can delete either row in Data → Manage. A night this rule
// deletes wrongly is gone.

// The four metrics a sleep session's breakdown is filed under. ONE list: the collapse
// reads it to find the stage rows that go with a deleted session, and the re-time
// (#5021) reads it to find the ones that move with a corrected one. Two spellings of
// "which rows are this night's stages" could disagree, and the row a disagreement
// stranded would belong to a night that no longer exists at those instants.
export const SLEEP_STAGE_METRICS = [
  "sleep_deep_min",
  "sleep_rem_min",
  "sleep_light_min",
  "sleep_awake_min",
] as const;

/** One stored `sleep_min` row, in the columns this rule reads. */
export interface SleepSessionRow {
  id: number;
  /** The metric the row is filed under: `sleep_min` for a session, `sleep_*_min` for a stage. */
  metric: string;
  /**
   * The profile-local wake day the parser filed this row under. A session's stages are
   * pinned to their SESSION's wake day, which is the only parentage the schema carries.
   */
  date: string;
  started_at: string;
  ended_at: string;
  /** The package that wrote it. NULL is UNKNOWN, never "the same as another NULL". */
  origin: string | null;
  /** The #133 user-edit lock. NULL on rows written before migration 115. */
  edited: number | null;
}

/** One `hr_minutes` row: a canonical UTC minute and that minute's mean bpm. */
export interface HeartRateMinute {
  ts: string;
  bpm: number;
}

/** A pair that cannot both be real, with the instants already read once. */
export interface SleepOverlapPair<T extends SleepSessionRow = SleepSessionRow> {
  a: T;
  b: T;
  aStartMs: number;
  aEndMs: number;
  bStartMs: number;
  bEndMs: number;
}

/**
 * The pairs of stored sessions that cannot both be real.
 *
 * SAME ORIGIN, OVERLAPPING, DIFFERENT KEYS. One person, recorded by one package, cannot
 * be asleep in two overlapping sessions — so an overlap inside an origin is a re-write.
 * A NULL origin is UNKNOWN and is never treated as shared: two packages that set no
 * `metadata.data_origin` both parse to NULL, and pairing them would let one device's
 * session delete another's. The #1191 fragmented night is untouched by construction —
 * fragments are separated by an awake gap, so they do not overlap.
 */
export function sleepOverlapPairs<T extends SleepSessionRow>(
  sessions: readonly T[]
): SleepOverlapPair<T>[] {
  const pairs: SleepOverlapPair<T>[] = [];
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i];
      const b = sessions[j];
      if (a.origin === null || b.origin === null || a.origin !== b.origin)
        continue;
      if (a.started_at === b.started_at) continue;
      const aStartMs = instantMs(a.started_at);
      const aEndMs = instantMs(a.ended_at);
      const bStartMs = instantMs(b.started_at);
      const bEndMs = instantMs(b.ended_at);
      if (
        aStartMs === null ||
        aEndMs === null ||
        bStartMs === null ||
        bEndMs === null
      )
        continue;
      if (!windowsOverlap(a.started_at, a.ended_at, b.started_at, b.ended_at))
        continue;
      pairs.push({ a, b, aStartMs, aEndMs, bStartMs, bEndMs });
    }
  }
  return pairs;
}

/** What the device recorded inside one claimed window. */
export interface HeartRateObservation {
  /** Minutes carrying a reading. */
  covered: number;
  /** Their mean bpm, or null when there are none. */
  meanBpm: number | null;
  /**
   * The longest stretch of the window with no reading at all, in ms — measured from the
   * window's own start and to its own end, so a night whose heart rate has only half
   * arrived shows the missing half rather than a tidy mean over the half that did.
   */
  longestGapMs: number;
}

/**
 * Read one window against the minutes that fall inside it.
 *
 * `minutes` may cover more than the window; only the ones inside `[startMs, endMs)` count.
 */
export function observeHeartRate(
  startMs: number,
  endMs: number,
  minutes: readonly HeartRateMinute[]
): HeartRateObservation {
  if (endMs <= startMs) return { covered: 0, meanBpm: null, longestGapMs: 0 };
  const inside = minutes
    .map((m) => ({ ms: instantMs(m.ts), bpm: m.bpm }))
    .filter(
      (m): m is { ms: number; bpm: number } =>
        m.ms !== null && m.ms >= startMs && m.ms < endMs
    )
    .sort((x, y) => x.ms - y.ms);
  if (inside.length === 0)
    return { covered: 0, meanBpm: null, longestGapMs: endMs - startMs };
  let longestGapMs = inside[0].ms - startMs;
  for (let i = 1; i < inside.length; i++) {
    const gap = inside[i].ms - inside[i - 1].ms;
    if (gap > longestGapMs) longestGapMs = gap;
  }
  const tail = endMs - inside[inside.length - 1].ms;
  if (tail > longestGapMs) longestGapMs = tail;
  const sum = inside.reduce((acc, m) => acc + m.bpm, 0);
  return { covered: inside.length, meanBpm: sum / inside.length, longestGapMs };
}

/**
 * Was this window OBSERVED — is there enough heart rate inside it to say anything at all?
 *
 * `dipToleranceMs` IS THE DECLARED ONE, not a number picked here: the Health Connect
 * `heart-rate` stream declares `quiet.dipToleranceMin` (150 min) as the silence a worn
 * device may show before the stream counts as stopped, measured off a bimodal gap
 * distribution with an empty valley at 2.1–2.5 h. A window carrying a longer hole than
 * that was not continuously observed, so a mean over what did arrive is a claim about a
 * fragment.
 */
export function windowObserved(
  observation: HeartRateObservation,
  dipToleranceMs: number
): boolean {
  return (
    observation.meanBpm !== null && observation.longestGapMs <= dipToleranceMs
  );
}

/**
 * Does an observed window read as sleep?
 *
 * `referenceBpm` is the person's own awake mean over the surrounding span. STRICTLY
 * BELOW, with no margin: see the header — a margin would only shift which side of
 * "exactly one" a borderline pair falls on, and both sides of that are handled, while a
 * margin invented here would be a bpm constant applying to everybody.
 */
export function corroboratesSleep(
  observation: HeartRateObservation,
  referenceBpm: number
): boolean {
  return observation.meanBpm !== null && observation.meanBpm < referenceBpm;
}

/** Why a pair was left standing instead of collapsed. */
export type SleepOverlapUndecided =
  | "edited" // the #133 lock holds one of the rows, or a stage of it
  | "unobserved" // one or both windows carry no usable heart rate
  | "both" // both read as sleep — a real second session, or a phantom on a restful span
  | "neither"; // neither reads as sleep — nothing here says which is the night

export type SleepOverlapVerdict<T extends SleepSessionRow> =
  | { kind: "collapse"; keep: T; drop: T }
  | { kind: "undecided"; reason: SleepOverlapUndecided };

/**
 * The whole decision for one pair, from two observations and one reference.
 *
 * The pair is read SYMMETRICALLY — swapping `a` and `b` swaps the verdict's fields and
 * changes nothing else — which is the property that keeps arrival order from reaching
 * this rule even indirectly.
 */
export function decideSleepOverlap<T extends SleepSessionRow>(
  pair: SleepOverlapPair<T>,
  observations: { a: HeartRateObservation; b: HeartRateObservation },
  referenceBpm: number | null,
  dipToleranceMs: number
): SleepOverlapVerdict<T> {
  const { a, b } = pair;
  if (a.edited || b.edited) return { kind: "undecided", reason: "edited" };
  // BOTH WINDOWS, OR NEITHER DECIDES ANYTHING. An unread window is not a window that
  // failed to look like sleep — the watch batches into the phone independently of the
  // exporter's push, so the corrected night routinely arrives before its own minutes do.
  // Asked one at a time this would delete a real night whose heart rate had not landed
  // yet, on the strength of a phantom sitting on an evening; asked together it cannot.
  if (
    referenceBpm === null ||
    !windowObserved(observations.a, dipToleranceMs) ||
    !windowObserved(observations.b, dipToleranceMs)
  )
    return { kind: "undecided", reason: "unobserved" };
  const aSleeps = corroboratesSleep(observations.a, referenceBpm);
  const bSleeps = corroboratesSleep(observations.b, referenceBpm);
  if (aSleeps && bSleeps) return { kind: "undecided", reason: "both" };
  if (aSleeps) return { kind: "collapse", keep: a, drop: b };
  if (bSleeps) return { kind: "collapse", keep: b, drop: a };
  // Both were read and neither is below the person's own awake mean. Nothing here says
  // which one is the night, and this rule does not guess.
  return { kind: "undecided", reason: "neither" };
}

/**
 * The stage rows that go with the session being deleted.
 *
 * THERE IS NO PARENTAGE COLUMN, BUT THERE IS ONE FACT: the parser pins every stage to its
 * SESSION's wake day (`date`), so a stage and its session always agree on that column
 * whatever the two windows do. On the defect this rule exists for, that alone separates
 * the two stage sets — the re-timed pair is filed under two different wake days, which is
 * the very signature of the bug — including inside the band where the windows overlap and
 * geometry cannot say anything. The rest is derived, and derived to fail toward KEEPING:
 *
 *   * the stage's MIDPOINT lies inside the loser's window. A midpoint is jitter-proof at
 *     both ends and needs no tolerance constant — the parser's own comment records a
 *     minute of scorer jitter at each end of a session, so containment would strand
 *     exactly those stages while a plain overlap test would claim its neighbours'.
 *   * and no OTHER session filed under that same wake day overlaps the stage. Only a
 *     session on a day can own a stage on that day, so this is the whole veto set — and
 *     it is what makes a stage that has escaped its own session safe: a genuine fragment's
 *     trailing awake stage still overlaps the fragment it came from, so it is never taken,
 *     however far its midpoint has drifted. Where the pair itself shares a wake day the
 *     survivor is in this set too, so the band's stages stay on both sides: a few minutes
 *     counted twice on a day that still has its night, rather than a minute deleted from
 *     the night being kept.
 *
 * Nothing here gates the COLLAPSE. An earlier version refused the whole thing when a
 * stage had two owners, which could only ever fire on finely-scored sessions — so the
 * rule acted almost exclusively on the coarsely-scored ones its safety machinery never
 * reached. Ownership is per stage now; the session decision is the heart rate's alone.
 */
export function stagesOwnedBy<T extends SleepSessionRow>(
  loser: { date: string; startMs: number; endMs: number },
  sessions: readonly SleepSessionRow[],
  stages: readonly T[]
): T[] {
  const sameDay = sessions.filter((s) => s.date === loser.date);
  return stages.filter((stage) => {
    if (stage.date !== loser.date) return false;
    const s = instantMs(stage.started_at);
    const e = instantMs(stage.ended_at);
    if (s === null || e === null || e <= s) return false;
    const mid = s + (e - s) / 2;
    if (mid < loser.startMs || mid >= loser.endMs) return false;
    return !sameDay.some((other) =>
      windowsOverlap(
        stage.started_at,
        stage.ended_at,
        other.started_at,
        other.ended_at
      )
    );
  });
}
