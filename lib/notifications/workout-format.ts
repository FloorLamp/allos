// Pure formatting for the Telegram workout reminder (#221) — no DB/network, so it
// stays unit-testable and shares the exact next-workout result the dashboard and
// Training overview render. The DB-reading gather + core call live in
// ./recommend (recommendWorkout); ./workouts wires the two together.

import { suggestTitle, type MuscleRegion } from "../lifts";
import { frequencyScopeLabel } from "../goals";
import {
  workoutAcknowledgmentLine,
  type BehindTargetPace,
} from "../effort-class";
import type { OrderedBehindTarget } from "../workout-recommendation";
import type { NotificationAction, NotificationMessage } from "./types";
import { bold, joinBody, richFrom, type MessageBody } from "./rich-text";

export interface WorkoutRecommendation {
  focus: MuscleRegion[];
  exercises: string[];
  // The SECOND session this recommendation names (#2016). When the routine is behind on
  // both a strength target and a cardio one, the core returns two routine-gap items and
  // the message used to render only the strength half — dropping a fully-formed cardio
  // recommendation (its activity already picked, weather-parked options already excluded)
  // while still marking its target. Owner ruling: name both. The engine has decided both
  // sessions are owed; the reader chooses, the message reports.
  //
  // Strength leads — it carries the exercise list and the how-to deep link — and this is
  // one line. Null when no cardio target is behind, which leaves the message byte-for-byte
  // what it was.
  cardio?: {
    // The activity `pickOldestCardio` chose. Null when nothing qualifies (no recent
    // cardio history, or every candidate is weather-parked), which renders the generic
    // "log a cardio session" rather than inventing one.
    activity: string | null;
    count: number;
    perWeek: number;
  } | null;
  // Weather-parking disclosures for today (#1724/#2002) — the SAME lines the dashboard
  // card and the Training overview render through `contextNotes`, formatted once in
  // lib/weather-training. The nudge used to render none of them, so an outdoor ride
  // quietly became a stationary bike with no explanation on the one surface whose own
  // comments promised the disclosure. Empty/absent on any ordinary day.
  parkedNotes?: string[];
  // The behind weekly targets, ALREADY ordered and marked by the pure core (#1709):
  // the target that drove today's suggestion leads, the rest follow by deficit. Kept
  // structured to here so the formatter can relate the list to the recommendation —
  // flattening it upstream is exactly what disconnected the two halves.
  behind: OrderedBehindTarget[];
  // Recovery/celebration awareness carried from the unified coaching engine (#221),
  // so the reminder can note a rest day or an on-track week instead of blindly
  // pushing a workout. Null when the top-line recommendation isn't rest/on-track.
  // `also` carries any CONCURRENT under-recovery signals (#1148) — the same set the
  // dashboard card shows — so the nudge names every firing reason, not just the top.
  rest: { title: string; detail: string; also?: string[] } | null;
  onTrack: { title: string; detail: string } | null;
  // Today's routine day label (#740), when an active routine resolved a session
  // ("Push", "Pull", …). Titles the nudge ("🏋️ Push day: …") so the reminder names
  // the actual sequence day. Null / absent ⇒ the prior habit-derived title.
  sessionLabel?: string | null;
  // The routine's mesocycle says today is a deload week (#741). The nudge KEEPS
  // firing (it isn't suppressed) but SOFTENS: it names the deload so a lighter
  // session reads as on-plan, not as falling behind. Absent / false ⇒ no note.
  deloadWeek?: boolean;
  // The same-day acknowledgment (#1672): what was already trained today, and the pace
  // fact that justifies pushing anyway. Present ONLY when the nudge is firing on a
  // trained day — on every other day the message is unchanged.
  acknowledge?: {
    session: string;
    forcedBy: BehindTargetPace | null;
  } | null;
  // The tight-week recovery override (#1673): today's suggestion asks for a region that
  // is still inside its recovery window, because the week can no longer be met without
  // it. The line states BOTH facts ("Back was Saturday — 1/2 with today left."), so the
  // nudge never reads as having forgotten Saturday's session. Absent on every ordinary
  // day (loose weeks yield the rest reframe instead).
  recoveryOverride?: string | null;
}

// Render a WorkoutRecommendation as the Telegram message. Split out from the
// DB-reading path so the cross-surface consistency test can drive it with the
// same next-workout result the dashboard/overview render.
//
// `deepLinkBase` (the instance's public URL) enables the "How to" deep-link
// button to the lead exercise's detail panel (#734). Two-way principle: it's a
// URL button — it carries the exercise NAME and deep-links, never a mutation.
// Empty base (unset public URL / unit tests) ⇒ no button.
export function formatWorkoutReminder(
  rec: WorkoutRecommendation | null,
  deepLinkBase = ""
): NotificationMessage | null {
  if (!rec) return null;

  // An active routine names the day explicitly ("Push"); otherwise fall back to the
  // habit-derived title from the exercise list.
  const focusLabel = rec.sessionLabel
    ? `${rec.sessionLabel} day`
    : rec.exercises.length
      ? suggestTitle(rec.exercises) // "Push day" / "Chest workout" / "Full body workout"
      : rec.focus.join(" / ");

  // The lead exercise's how-to guide, as a deep-link button to the Analyze panel
  // (#734). Only when a public URL is configured and a lead lift exists.
  const base = deepLinkBase.replace(/\/$/, "");
  const primary = rec.exercises[0];
  const guideActions: NotificationAction[] =
    base && primary
      ? [
          {
            label: `📖 How to: ${primary}`,
            url: `${base}/training?tab=analyze&kind=strength&exercise=${encodeURIComponent(
              primary
            )}`,
          },
        ]
      : [];

  // Deload-week softening (#741): the nudge still fires, but names the deload so a
  // lighter week reads as on-plan rather than as falling behind.
  const deloadNote = rec.deloadWeek
    ? "Deload week — keep it light and let fatigue clear."
    : null;

  // Recovery override: a rest day reframes the nudge; the workout suggestion, if
  // any, becomes a "when you're ready" footnote rather than the headline. The cardio
  // half (#2016) and the weather disclosure (#2002) stay out of this branch on purpose:
  // the rest reframe already demotes the whole suggestion to a footnote, and naming a
  // second owed session — or explaining which activity today's conditions displaced —
  // would push on the one day the message has decided not to.
  if (rec.rest) {
    const lines: string[] = [rec.rest.detail];
    // Concurrent under-recovery signals (#1148): name the rest so a snooze can't bury
    // a signal the user never saw — the same "Also: …" line the dashboard card shows.
    if (rec.rest.also?.length) lines.push(`Also: ${rec.rest.also.join("; ")}.`);
    if (deloadNote) lines.push(deloadNote);
    if (rec.exercises.length)
      lines.push(`When you're ready: ${rec.exercises.join(", ")}`);
    else if (rec.focus.length)
      lines.push(`When you're ready: ${rec.focus.join(", ")}`);
    return {
      title: `🛌 ${rec.rest.title}`,
      body: lines.join("\n"),
      kind: "workout",
      ...(guideActions.length ? { actions: guideActions } : {}),
    };
  }

  const lines: string[] = [];
  // LEAD WITH WHAT THEY DID (#1672, the workout-presence copy standard): when the nudge
  // fires on a day that already saw a session, the message opens with it. Without this
  // the push read as "the app didn't notice my workout".
  const ackLine = workoutAcknowledgmentLine(rec.acknowledge ?? null);
  if (ackLine) lines.push(ackLine);
  // Same posture one step out (#1673 decision 4): when pace overrides a region's
  // recovery window, say what was trained and why today still counts.
  if (rec.recoveryOverride) lines.push(rec.recoveryOverride);
  if (deloadNote) lines.push(deloadNote);
  if (rec.exercises.length)
    lines.push(`Suggested: ${rec.exercises.join(", ")}`);
  else if (rec.focus.length) lines.push(`Focus: ${rec.focus.join(", ")}`);
  // The cardio half the message used to drop (#2016) — one line, after the strength
  // slate that leads. When only cardio is behind, this line IS the message.
  const cardioLine = cardioSessionLine(rec.cardio ?? null);
  if (cardioLine) lines.push(cardioLine);
  // Weather parking, disclosed here exactly as the dashboard discloses it (#2002).
  // Placed with the suggestion because that is what it explains: the ride is missing
  // from today's pick, and this says why and what took its slot.
  for (const note of rec.parkedNotes ?? []) lines.push(note);
  if (rec.onTrack) lines.push(rec.onTrack.detail);
  // The acknowledgment headline, when it fired, has already stated one behind target
  // AND its pace in words. Repeating it in the list two lines down is the same fact
  // twice in a four-line message (#1822 item 3), so the list is asked to skip it — the
  // ONE place that knows what the headline said. Everything else keeps its `← today`.
  const behindLine = behindThisWeekLine(
    rec.behind,
    ackLine ? (rec.acknowledge?.forcedBy ?? null) : null
  );

  return {
    title: rec.onTrack
      ? `✅ ${rec.onTrack.title}`
      : focusLabel
        ? `🏋️ Today's workout — ${focusLabel}`
        : "🏋️ Today's workout",
    body: joinBody([lines.join("\n"), behindLine], "\n"),
    kind: "workout",
    ...(guideActions.length ? { actions: guideActions } : {}),
  };
}

// The cardio half of a two-session day (#2016): "Plus a cardio session — Run, 1/2 this
// week." One line by design — strength leads because it carries the exercise list and
// the deep-linked how-to button, while this states the session and the pace that owes it.
// Names the chosen activity only when the picker actually chose one; with none, the line
// still reports the owed session rather than inventing an activity. Null ⇒ nothing to add.
export function cardioSessionLine(
  cardio: WorkoutRecommendation["cardio"]
): string | null {
  if (!cardio) return null;
  const named = cardio.activity ? `${cardio.activity}, ` : "";
  return `Plus a cardio session — ${named}${cardio.count}/${cardio.perWeek} this week.`;
}

// The marker on the target that drove today's suggestion (#1709). BOTH forms, by
// owner decision: the `← today` suffix always (it renders identically on every channel
// and reads naturally in-app) plus bold where markup is supported, degrading cleanly to
// the suffix alone on Web Push / Home Assistant.
//
// #1822 item 3 AMENDS that ruling, narrowly and by the owner's own filing: "the suffix
// always" was decided for a list standing beside a recommendation, not for a list
// repeating the message's own opening sentence. When the acknowledgment headline has
// ALREADY named a target and its pace ("Trained today — Chest is 1/2 with only today
// left"), that target is dropped from the Behind list rather than restated two lines
// later with an arrow pointing at the same fact. The suffix is untouched everywhere
// else: any message whose headline does not name the driver renders exactly as before.
export const BEHIND_DRIVER_SUFFIX = " ← today";

// A target's scope identity — the pair the acknowledgment and the behind list agree on
// (both carry the frequency target's `scope_kind`/`scope_value` verbatim). Compared
// rather than the rendered label so the dedup can't be broken by a labeling change.
export interface BehindScopeRef {
  scopeKind: string;
  scopeValue: string;
}

function sameScope(a: BehindScopeRef, b: BehindScopeRef): boolean {
  return a.scopeKind === b.scopeKind && a.scopeValue === b.scopeValue;
}

// "Back 0/2 ← today, Chest 1/2, Lower body 1/2, Cardio 1/2" — the list in the order the
// core decided, with the driving target marked. Null when nothing is behind.
//
// `alreadyStated` is the target the message's own headline has already spelled out with
// its pace, when there is one (#1822 item 3). It is filtered out, so a four-line message
// states one fact once; with nothing else behind, the whole line falls away. Omit it (or
// pass null) and the list is byte-for-byte the pre-#1822 rendering.
export function behindThisWeekLine(
  behind: readonly OrderedBehindTarget[],
  alreadyStated?: BehindScopeRef | null
): MessageBody | null {
  const remaining = alreadyStated
    ? behind.filter((t) => !sameScope(t, alreadyStated))
    : behind;
  if (remaining.length === 0) return null;
  const parts: (string | ReturnType<typeof bold>)[] = ["Behind this week: "];
  remaining.forEach((t, i) => {
    if (i > 0) parts.push(", ");
    const label = `${frequencyScopeLabel(t.scopeKind, t.scopeValue)} ${t.count}/${t.perWeek}`;
    parts.push(t.driving ? bold(`${label}${BEHIND_DRIVER_SUFFIX}`) : label);
  });
  return richFrom(parts);
}

// The digest's ONE-LINE workout preview (#1712 §2). Formatted from the SAME
// WorkoutRecommendation the dedicated nudge renders, so a 7am heads-up and the
// actionable prompt later cannot disagree — they format one computation (#221).
//
// Rest and on-track states REFRAME the line exactly as they reframe the nudge (never a
// blind "train today" on a rest day), and a recommendation with nothing to say yields
// null so the digest simply omits the line.
//
// SECTION-AWARE FRAMING (#1819 item 3). The standalone "Today:" prefix is correct
// wherever the line stands on its own; under the morning digest's **Today** heading it
// restated the heading ("Today / 🏋️ Today: Strength session — …"). So the formatter
// gains a BARE variant rather than the digest growing its own copy: same computation,
// same states, only the framing moves. `standalone` defaults to true so every existing
// caller is unchanged.
export function digestWorkoutLine(
  rec: WorkoutRecommendation | null,
  opts: { standalone?: boolean } = {}
): string | null {
  if (!rec) return null;
  const lead = opts.standalone === false ? "" : "Today: ";
  if (rec.rest) return `🛌 ${lead}${rec.rest.title}`;
  if (rec.onTrack) return `✅ ${lead}${rec.onTrack.title}`;
  // THE HEAD IS NAMED FROM THE EXERCISES, exactly as the nudge names it 190 lines up
  // (#2012). It used to pass `rec.focus` — a `MuscleRegion[]`, not exercise names —
  // into `suggestTitle`, which resolves each string through `liftInfo` and ends in a
  // loose substring match: "Back" is contained in "back squat", so a back day was
  // titled "Legs workout", and every other region resolved to nothing and fell into
  // the generic "Strength session" the guard here was written to avoid. `MuscleRegion`
  // is a string union, so `MuscleRegion[]` is assignable to `string[]` and the compiler
  // could not see it.
  //
  // The two surfaces are SUPPOSED to agree (this function's header, #221): for one
  // recommendation the nudge titled "Pull day" from the exercises while the preview
  // titled "Legs workout" from the focus. They now read the same argument.
  //
  // The `.length` guard stays and is now load-bearing: `suggestTitle([])` returns the
  // generic "Strength session", which is right for the nudge's TITLE but would put a
  // contentless line in the digest — so the preview asks for a resolved routine day or
  // a real exercise slate before naming one.
  const head =
    rec.sessionLabel ??
    (rec.exercises.length ? suggestTitle(rec.exercises) : null);
  const exercises = rec.exercises.slice(0, 3).join(", ");
  // The preview names the SAME sessions the nudge names (#2016) — letting the 7am
  // heads-up and the actionable prompt disagree about how many sessions are owed is
  // exactly the #221 failure this file's header warns about. Compactly, since the
  // digest's line is one line: a suffix, and only when a cardio session is genuinely
  // named — never as decoration.
  const plusCardio = rec.cardio ? " + cardio" : "";
  if (!head && !exercises)
    return rec.cardio ? `🏋️ ${lead}Cardio session` : null;
  const deload = rec.deloadWeek ? " (deload week)" : "";
  return exercises
    ? `🏋️ ${lead}${head ? `${head} — ` : ""}${exercises}${plusCardio}${deload}`
    : `🏋️ ${lead}${head}${plusCardio}${deload}`;
}
