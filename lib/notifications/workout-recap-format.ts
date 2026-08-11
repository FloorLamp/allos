// Pure composition for the recap-led post-workout finish nudge (issue #924) — no
// DB/network, so it stays unit-testable and the DB gather + dispatch in
// ./workout-presence wire it up. The #921 finish nudge (the due post-workout
// supplement doses) is unchanged; this only PREPENDS the session recap line and
// makes a recap-only finish still send.
//
// Composition rule:
//   • recap line — gated by its own per-profile toggle (workout-recap kind, on by
//     default) AND by there being something to recap: real strength work
//     (recapNudgeLine) or, for a SOURCED row with no sets, the facts the import
//     itself carries (importedRecapLine, #2272);
//   • supplement section — the existing dose reminder, gated by dueness;
//   • the #2272 type ask — a line and buttons APPENDED when the finishing row is
//     `unclassified`, riding whatever is already going out and never sending alone;
//   • either of the first two alone still sends; both absent ⇒ no send.

import type { NotificationAction, NotificationMessage } from "./types";
import { joinBody } from "./rich-text";
import { formatRecapLine, type Recap } from "../session-recap";
import { frequencyScopeLabel } from "../frequency-targets";
import {
  SESSION_ADVANCEABLE_SCOPE_KINDS,
  sessionAdvancesScope,
  type SessionCadenceFacts,
} from "../cadence";
import { fmtDistance } from "../units";
import type { ActivityType } from "../types/training";
import { activityTypeAskCallback } from "./callback-data";
import { formatMessageLine } from "./message-line";
import { GLYPH } from "./glyphs";

// The workout-affectable frequency scopes (#1122): the target kinds a lifting/cardio
// session can actually advance. `food_group` (a nutrition scope, #580) and
// `mobility_region` (a recovery scope, #840) are EXCLUDED from a *workout* recap — a
// barbell session structurally can't move veg-servings or mobility days, so grading
// them here is what made the old line read "0 of 4" ("your workout didn't count").
// `substance` (a weekly cap, #998) is already excluded upstream by
// `getFrequencyTargetProgress`.
//
// DERIVED from the advance rules (#2439) rather than hand-listed: a scope is
// workout-affectable exactly when a session's own facts can advance it, so the
// narrowing and the per-session test are one declaration and cannot drift.
const WORKOUT_RECAP_SCOPE_KINDS: ReadonlySet<string> = new Set(
  SESSION_ADVANCEABLE_SCOPE_KINDS
);

// The minimal shape the recap line reads from a `getFrequencyTargetProgress` row —
// scope identity (to filter + label), the paced count, and the met flag. Structurally
// a subset of `FrequencyTargetProgress`, so the caller passes that array directly.
export interface WeeklyRecapTarget {
  target: { scope_kind: string; scope_value: string };
  count: number;
  per_week: number;
  met: boolean;
}

// The weekly-status line the recap message gains (issue #981 §3, corrected by #1122 and
// #2439): riding INSIDE the congratulatory finish message where its tone is natural.
// Three fixes over the original "N of M met" tally:
//   1. SCOPE to workout-affectable targets — a workout recap never grades food/mobility
//      habits a lifting session can't move (that's how it showed "0 of 4").
//   2. PACE, not met-count — lead with the target this session ADVANCED but hasn't yet
//      completed ("Legs — 1 of 2 this week, one more to go"), using each target's count
//      rather than the all-or-nothing `met`, so a session that rarely *completes* a
//      2–4×/week goal still reads as progress. Acknowledge the session; don't tally
//      unfinished weekly goals.
//   3. ABOUT THIS SESSION (#2439). Points 1 and 2 were written but not implemented: the
//      rollup is profile-wide and nothing tied it to the finishing activity, so the line
//      led with the closest-to-done target ANYWHERE — "Chest — 1 of 2 this week" printed
//      under "Afternoon Walk done · 33 min · 1.42 km", crediting a walk with a barbell
//      session two days earlier and then nudging toward a chest day it had not touched.
//      A target this session did not advance is now not eligible to lead, which is what
//      the comment claimed all along.
// The underlying rollup stays the ONE computation (`getFrequencyTargetProgress`, #221);
// this is a workout-scoped FORMATTER over it, and `sessionAdvancesScope` is the ONE
// membership rule (`lib/cadence.ts`), the same one `cadenceCounts` counts by. Null when
// there are no workout targets, when this session advanced none of them, or when the one
// it advanced is neither in progress nor part of a fully met week.
export function weeklyRemainingLine(
  routine: readonly WeeklyRecapTarget[],
  session: SessionCadenceFacts
): string | null {
  const workout = routine.filter((t) =>
    WORKOUT_RECAP_SCOPE_KINDS.has(t.target.scope_kind)
  );
  if (workout.length === 0) return null;

  // What THIS session put on the board. A session that advanced nothing gets no weekly
  // line at all — its recap line stands alone rather than borrowing another session's
  // progress for a congratulation.
  const advanced = workout.filter((t) =>
    sessionAdvancesScope(
      { kind: t.target.scope_kind, value: t.target.scope_value },
      session
    )
  );
  if (advanced.length === 0) return null;

  // Lead with the closest-to-done target the session advanced but hasn't completed.
  // `count >= 1` still earns its place: a session dated outside the current window
  // (a late-night import landing in last week) advances the scope but not this week.
  const inProgress = advanced
    .filter((t) => !t.met && t.count >= 1)
    .sort((a, b) => a.per_week - a.count - (b.per_week - b.count));
  if (inProgress.length > 0) {
    const t = inProgress[0];
    const remaining = t.per_week - t.count;
    const tail = remaining === 1 ? "one more to go" : `${remaining} more to go`;
    const label = frequencyScopeLabel(
      t.target.scope_kind,
      t.target.scope_value
    );
    return formatMessageLine({
      head: label,
      notes: [`${t.count} of ${t.per_week} this week, ${tail}.`],
    });
  }

  // Nothing in progress: a calm celebratory line when every workout target is met,
  // else silence (don't tally the untouched goals as "0 of N"). The claim is about the
  // WEEK, so it reads every workout target rather than only the advanced ones — but it
  // is still reachable only from a session that advanced one, so it lands as a
  // consequence of what just happened rather than as a bulletin about someone's week.
  if (workout.every((t) => t.met)) return "All weekly targets met — nice work.";
  return null;
}

// The recap line for the nudge, or null when the toggle is off or there's nothing
// worth recapping. A finish with no strength working sets (a pure-cardio/import
// row) yields no recap line — the nudge then behaves exactly as it did pre-#924
// (dose-only), so a promptly-synced run can't spam a "run done" note.
export function recapNudgeLine(
  recap: Recap | null,
  enabled: boolean
): string | null {
  if (!enabled || !recap) return null;
  if (recap.totalWorkingSets === 0) return null;
  // THE DETAILED FORM (#2172). The chat has no recap card under the line — the line is
  // the whole message — so this is the surface that needs the progress fact and the
  // named, quantified target rollup. Same formatter, one verbosity option: the in-app
  // card title keeps the compact form because every fact is rendered below it.
  const line = formatRecapLine(recap, { detail: true });
  return line || null;
}

// ---- The IMPORTED finish's own recap line (#2272) ----

// The facts an IMPORTED session actually carries. No strength fields on purpose:
// an imported row has no `exercise_sets`, so volume, PRs and target verdicts are
// things the app does not know about it and must not imply.
export interface ImportedSessionFacts {
  title: string;
  /** Active minutes (the pace/volume source), or the elapsed span when that is all there is. */
  durationMin: number | null;
  distanceKm: number | null;
  avgHr: number | null;
  maxHr: number | null;
  relativeEffort: number | null;
}

// The recap line for a session that was IMPORTED rather than logged in the app.
//
// `getSessionRecap` is honest about a sourced row — no sets means no volume and no
// PRs — but `recapNudgeLine` then declines the whole line on `totalWorkingSets === 0`,
// so an imported finish said NOTHING. Measured on a real profile: every post-workout
// marker ever written belonged to a manual strength session with logged sets, and no
// imported activity had ever produced a recap. Presence detection was never the
// problem; the message simply had nothing to say. This gives it the facts the import
// DID carry, in the same `A · B · C` shape as the strength line, with no volume, PR
// or target language anywhere in it.
//
// Null when the import carries no fact beyond its own existence — "Workout done" on
// its own is not worth a push.
export function importedRecapLine(facts: ImportedSessionFacts): string | null {
  const segs: string[] = [];
  if (facts.durationMin != null && facts.durationMin > 0)
    segs.push(`${facts.durationMin} min`);
  if (facts.distanceKm != null && facts.distanceKm > 0)
    // Canonical km, the notification unit policy (a chat has no login-unit context),
    // through the shared formatter — the same call the digest's activity line makes.
    segs.push(fmtDistance(facts.distanceKm, "km"));
  if (facts.avgHr != null && facts.avgHr > 0) {
    const max =
      facts.maxHr != null && facts.maxHr > 0
        ? ` (max ${Math.round(facts.maxHr)})`
        : "";
    segs.push(`avg HR ${Math.round(facts.avgHr)}${max}`);
  } else if (facts.maxHr != null && facts.maxHr > 0) {
    segs.push(`max HR ${Math.round(facts.maxHr)}`);
  }
  if (facts.relativeEffort != null && facts.relativeEffort > 0)
    segs.push(`effort ${Math.round(facts.relativeEffort)}`);
  if (segs.length === 0) return null;
  const lead = facts.title.trim() || "Workout";
  return [`${lead} done`, ...segs].join(" · ");
}

// ---- The finish message's own title (#2439) ----

// WHAT FINISHED, named by the row's own type. The title was one hardcoded string —
// `🏋️ Workout complete` — from #924, when only a manual strength session with logged
// sets could ever produce a recap line. #2272 opened the same message to every import,
// correctly, and the barbell came along: a 33-minute, 1.42 km walk arrived titled
// "🏋️ Workout complete". The glyph vocabulary already had the per-discipline markers
// this needed.
//
// Two rules the map keeps:
//   • It states only what the row states. `unclassified` means the source did not say
//     (#2272), so it gets the generic training marker and a discipline-free word — the
//     same restraint `pickActivityIconKey` shows, and the message is carrying the ask
//     that fixes it.
//   • `recovery` is a session, not a workout, and it gets its own face rather than the
//     training marker: naming it one would tell a person their mobility work counted as
//     training load, which is the #840/#482 distinction the app keeps everywhere else.
//     "Mobility" is the app's own word for that surface.
// Exhaustive over `ActivityType` by the #2272 tuple discipline: a sixth type must
// answer here before it compiles.
const FINISH_TITLE: Record<ActivityType, string> = {
  strength: `${GLYPH.training} Workout complete`,
  cardio: `${GLYPH.cardio} Cardio complete`,
  sport: `${GLYPH.sport} Sport complete`,
  recovery: `${GLYPH.mobility} Mobility complete`,
  unclassified: `${GLYPH.training} Session complete`,
};

// The finish nudge's title for a row of this type. `null` — the row could not be read —
// takes the same generic answer as the stated absence: both mean "a session finished and
// nothing here knows which kind".
export function finishNudgeTitle(type: ActivityType | null): string {
  return type ? FINISH_TITLE[type] : FINISH_TITLE.unclassified;
}

// ---- The type ask (#2272) ----

// The three answers the ask offers. Deliberately NOT the full ActivityType set:
// `recovery` has its own surface, and `unclassified` is the question, not an answer.
export const ACTIVITY_TYPE_ASK_CHOICES = [
  { type: "strength", label: `${GLYPH.training} Strength` },
  { type: "cardio", label: `${GLYPH.cardio} Cardio` },
  { type: "sport", label: `${GLYPH.sport} Sport` },
] as const;

export type ActivityTypeAskChoice =
  (typeof ACTIVITY_TYPE_ASK_CHOICES)[number]["type"];

// The prompt sentence appended under the recap line when the finishing session is
// `unclassified` — the source recorded a workout but never said what it was, and the
// user is the only one who actually knows.
export const ACTIVITY_TYPE_ASK_PROMPT =
  "Your tracker didn't say what this was. What kind of session?";

// The inline buttons for the ask. IDs ONLY in the token (profile + activity, the
// profile as the resolve-against-chat cross-check, exactly like a dose tap), so the
// handler re-verifies ownership on write and a stale keyboard cannot assert anything.
export function activityTypeAskActions(
  profileId: number,
  activityId: number
): NotificationAction[] {
  return ACTIVITY_TYPE_ASK_CHOICES.map((c) => ({
    label: c.label,
    data: activityTypeAskCallback(profileId, activityId, c.type),
    row: "actype",
  }));
}

// The type ask's two halves, as the composition takes them: the prompt sentence that
// follows the recap line, and the inline buttons that answer it.
export interface FinishTypeAsk {
  prompt: string;
  actions: NotificationAction[];
}

// Compose the finish nudge: the recap line (when present) LEADS, then the due
// post-workout supplement section (the existing dose message) follows. Returns
// null when both are absent so the caller sends nothing (and doesn't burn the
// one-shot). The combined message keeps the dose message's kind ("dose") so its
// SAFETY-tier routing/actions are preserved AND its title, which names the dose
// condition rather than the session; a recap-only message is classified
// "workout-recap" for structured-channel routing and titled by `type` — what
// actually finished (#2439).
//
// It also carries the type ask (#2272) when the finishing session is `unclassified`
// — a LINE and BUTTONS on a message that was already going out, never a send of its
// own. That is the whole contact-consent posture: the system may reduce contact
// unilaterally, never increase it. With nothing to ride on there is no ask.
export function composeFinishNudge(
  recapLine: string | null,
  doseMessage: NotificationMessage | null,
  ask: FinishTypeAsk | null = null,
  type: ActivityType | null = null
): NotificationMessage | null {
  if (!recapLine && !doseMessage) return null;
  if (doseMessage) {
    // joinBody keeps a plain body plain and preserves the dose message's declared
    // emphasis (#1720) when it has any — never stringifies runs into "[object Object]".
    const merged =
      recapLine || ask
        ? joinBody([recapLine, doseMessage.body, ask?.prompt], "\n\n")
        : doseMessage.body;
    return {
      ...doseMessage,
      body: merged,
      actions: ask
        ? [...(doseMessage.actions ?? []), ...ask.actions]
        : doseMessage.actions,
    };
  }
  return {
    title: finishNudgeTitle(type),
    body: ask ? joinBody([recapLine!, ask.prompt], "\n\n") : recapLine!,
    ...(ask ? { actions: ask.actions } : {}),
    kind: "workout-recap",
  };
}
