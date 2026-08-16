// The pace-aware WELLNESS-PRACTICE reminder (issue #1259 phase 2). Coaching-tier and
// BUS-GATED like every calm nudge: it nags ONLY when a practice target is behind its
// weekly floor (the workout-nudge pattern, #221) — quiet when on track, SILENT at/above
// the ceiling (a dose-limited practice is never pushed toward MORE) — and holds a target
// whose `practice:<id>` Upcoming twin is dismissed/snoozed (dismiss once, silence
// everywhere, #227). NEVER safety-tier (a missed red-light session is not a missed
// medication). Each behind practice gets an inline "Done ✅" button that logs a session
// through the shared write core; the button carries ids only and is consumed on tap.
//
// One PROGRESS computation (#221): getFrequencyTargetProgress — which folds range
// semantics via frequencyRangeState — is the single ledger this nudge and the Upcoming
// row both read, so a shortfall shown on the page and one pushed here can never
// disagree about the numbers.
//
// Their GATES deliberately differ since #2579, and the difference is the doctrine:
//   • This send: practice / !met / !atCeiling / pace "behind". A push has to be worth
//     interrupting for, so being under a floor you are still on pace for is not
//     enough — #1259's anti-nudge rationale, which #2579 explicitly left standing for
//     sends and coaching surfaces.
//   • The Upcoming row (practiceItems): practice / !met / !atCeiling. That page is the
//     planning LEDGER and completeness is its charter, so an on-pace shortfall still
//     renders there — on a page the user opened, which is not contact.
// The system may reduce contact unilaterally, never increase it: widening the ledger
// left this gate exactly where it was.
//
// RHYTHM RETIMING (#2188): when a behind practice has an inferred weekly rhythm
// (inferPracticeSchedule — the workout-schedule shape over practice_logs), the
// nudge additionally WAITS for the practice's next predicted day and typical hour
// instead of firing at the first waking tick of the flip day. The decision is the
// pure practiceNudgeReleased (lib/practice.ts); the tick passes the moment via
// `timing`. Predicted ≠ due (#1505): retiming only ever DELAYS a send the pace
// ledger already justified — a caller that passes no timing (manual mode, the
// legacy tests) gets the untimed gather unchanged, and a practice with no pattern
// behaves byte-for-byte like today under either call shape. The bus gate, the
// per-day marker (owned by the tick) and the ceiling silence are untouched.

import {
  getFrequencyTargetProgress,
  getPracticeCorrectionBursts,
  inferPracticeSchedule,
} from "../queries";
import { now as clockNow } from "../clock";
import { getNotifySchedule, getPublicUrl, getTimezone } from "../settings";
import { minuteOfDayInTz, weekdayInTz } from "../date";
import { correctionMessageBinding } from "./message-pointers";
import {
  correctableBursts,
  correctionActions,
  correctionBodyStatement,
  correctionOffScopeStatement,
  correctionPickerActions,
  correctionPickerTitle,
  PRACTICE_TIME_PREFIXES,
} from "./correction-rows";
import {
  offeredHours,
  type CorrectionBurst,
  type CorrectionDay,
} from "../correction-time";
import { getFindingSuppressions } from "../queries/upcoming";
import { isSuppressed } from "../upcoming-suppress";
import {
  practiceSignalKey,
  practiceCadenceText,
  practiceNudgeReleased,
  practiceRhythmDaysText,
} from "../practice";
import { today as todayFor } from "../db";
import { collectRightSizeCandidates } from "../rule-findings";
import {
  parsePracticeDoneCallback,
  parsePracticeLogCallback,
  practiceDoneCallback,
  practiceLogCallback,
  rightSizeLowerCallback,
  type InlineKeyboard,
} from "./callback-data";
import { PRACTICES_HREF } from "../hrefs";
import type { NotificationAction, NotificationMessage } from "./types";
import { GLYPH } from "./glyphs";

// Cap the buttons so the keyboard stays tappable; the rest still reads in the body.
const MAX_PRACTICE_BUTTONS = 4;

// The tick's moment, threaded into the gather so each behind practice's rhythm can
// hold it for a predicted day (#2188). The week half of the moment
// (daysLeftInWindow) comes from each target's own progress row, not from here.
export interface PracticeNudgeTiming {
  weekday: number; // profile-local today, 0=Sun … 6=Sat
  minuteOfDay: number; // profile-local minute of day
  wakingStartHour: number;
  wakingEndHour: number;
}

// A behind, non-suppressed practice target ready to nudge — the gather the builder
// formats and the (test-visible) decision surface.
export interface BehindPractice {
  targetId: number;
  name: string;
  count: number;
  floor: number;
  ceiling: number | null;
  // The practice's inferred rhythm days for the "usually Mon/Wed/Fri" line —
  // null when no pattern exists (#558: the line then says nothing about days).
  rhythmDays?: number[] | null;
}

// Gather the profile's behind, non-suppressed practice targets (the bus-gated pace
// decision), rhythm-retimed when `timing` is supplied (#2188). Exported so the
// DB-tier builder test can assert the decision directly.
export function behindPractices(
  profileId: number,
  timing?: PracticeNudgeTiming
): BehindPractice[] {
  const suppressions = getFindingSuppressions(profileId);
  const today = todayFor(profileId);
  return getFrequencyTargetProgress(profileId)
    .filter((p) => p.target.scope_kind === "practice")
    .filter((p) => !p.met && !p.atCeiling && p.pace === "behind")
    .filter((p) => {
      // Bus gate: a dismissed/snoozed Upcoming twin holds the push too.
      const rec = suppressions.get(practiceSignalKey(p.target.id));
      return !(rec != null && isSuppressed(rec, today));
    })
    .map((p) => {
      const rhythm = inferPracticeSchedule(profileId, p.target.scope_value);
      return {
        item: {
          targetId: p.target.id,
          name: p.target.scope_value,
          count: p.count,
          floor: p.per_week,
          ceiling: p.per_week_max,
          rhythmDays: rhythm.hasPattern ? rhythm.weekdays : null,
        },
        // Rhythm retiming, per practice: released now, or held for a predicted
        // day later this week. Without a timing (manual mode) nothing is held.
        released:
          timing == null ||
          practiceNudgeReleased(rhythm, {
            ...timing,
            daysLeftInWindow: p.daysLeftInWindow,
          }),
      };
    })
    .filter((entry) => entry.released)
    .map((entry) => entry.item);
}

// ── THE ON-DEMAND LIST (`/practice`, issue #1895) ────────────────────────────
//
// Telegram has offered one-tap practice logging since #1259, but ONLY when the pace
// nudge happened to arrive — a practice you are on track with, or one whose nudge
// scrolled away, had no door from the chat at all. This is that door.
//
// It is NOT `buildPracticeReminder` with the filters removed, and the difference is the
// point: the nudge exists because the SYSTEM decided a target is behind (bus-gated,
// ceiling-silent, rhythm-retimed), while this exists because the USER asked. So the
// list carries every tracked practice — including the ones already met, which is what
// makes it a logger rather than a second nag — and none of the nudge's ride-alongs: no
// right-size offer, no shortfall framing that nobody asked for. Contact is unchanged;
// this adds a reply to a message the user sent, never a send.
//
// One computation all the same (#221): the progress rows and the per-practice line are
// the same `getFrequencyTargetProgress` + `practiceShortfallLine` the nudge and the
// Wellness card read, and the button is the same `practiceDoneCallback` the nudge mints
// and `handlePracticeDoneTap` consumes.
export function buildPracticeList(
  profileId: number,
  nonce: string = Date.now().toString(36)
): NotificationMessage | null {
  const rows = getFrequencyTargetProgress(profileId)
    .filter((p) => p.target.scope_kind === "practice")
    .map((p) => ({
      targetId: p.target.id,
      name: p.target.scope_value,
      count: p.count,
      floor: p.per_week,
      ceiling: p.per_week_max,
      // No rhythm line here: "usually Mon/Wed/Fri" answers "when does this normally
      // happen", which is a nudge's question. The user is holding the phone.
      rhythmDays: null,
    }));
  if (rows.length === 0) return null;

  const shown = rows.slice(0, MAX_PRACTICE_BUTTONS);
  const dropped = rows.length - shown.length;
  return {
    title: `${GLYPH.practice} Log a practice`,
    body:
      shown
        .map((b) => `${GLYPH.bullet} ${practiceShortfallLine(b)}`)
        .join("\n") +
      (dropped > 0
        ? `\n${GLYPH.caution} +${dropped} more — open the app to log the rest.`
        : ""),
    actions: shown.map((b) => ({
      label: `${GLYPH.done} ${b.name}`,
      data: practiceLogCallback(profileId, b.targetId, nonce),
    })),
    kind: "practice-list",
  };
}

// One practice's shortfall as a VERDICT rather than a bare ratio (#1722 item 5b) —
// the workout recap's shape: the numbers, then what they mean. "Meditation — 2 of 3
// this week, one more to go." Silent about the next step when the remainder isn't a
// simple count (a range target's ceiling is the calm "that's plenty" case, which the
// gather has already excluded). When a rhythm exists the line also NAMES it
// ("usually Mon/Wed/Fri") — data, not advice (#2188); no pattern names nothing.
export function practiceShortfallLine(b: BehindPractice): string {
  const remaining = Math.max(0, b.floor - b.count);
  const next =
    remaining === 1
      ? ", one more to go"
      : remaining > 1
        ? `, ${remaining} more to go`
        : "";
  // The FLOOR is the number the shortfall is measured against; a range target's
  // ceiling is the calm "that's plenty" case the gather has already excluded, so
  // naming it here would read as a second, competing goal.
  const rhythm =
    b.rhythmDays != null && b.rhythmDays.length > 0
      ? ` (${practiceRhythmDaysText(b.rhythmDays)})`
      : "";
  return `${b.name} — ${b.count} of ${b.floor} this week${next}${rhythm}`;
}

// Build the practice reminder, or null when nothing is behind (or all behind targets are
// suppressed, or — under a supplied `timing` — every behind target's rhythm is holding
// for a predicted day, #2188). A per-render nonce distinguishes redelivered callbacks;
// the write core's own semantics own the actual double-log guard, and the button is
// consumed on tap.
export function buildPracticeReminder(
  profileId: number,
  nonce: string = Date.now().toString(36),
  deepLinkBase = "",
  timing?: PracticeNudgeTiming
): NotificationMessage | null {
  const behind = behindPractices(profileId, timing);
  if (behind.length === 0) return null;

  // RIGHT-SIZING RIDE-ALONG (#1670). A practice whose shortfall has been chronic —
  // every one of the last four completed weeks under the floor — gets one extra button
  // on the message this nudge was already sending, offering the cadence actually kept.
  // No message exists because of a suggestion; this only decorates one that fires for
  // its own reasons (the ride-the-nag rule).
  //
  // Deliberately NOT bus-gated, unlike the nudge itself: an in-app dismiss means "keep
  // asking me about this practice", which is a statement about the CARD, not about
  // whether the offer to shrink the commitment should exist on a message that is being
  // sent anyway. The button is governed by detection state alone (#1505's posture).
  const rightSizeFloor = new Map<number, number>();
  for (const c of collectRightSizeCandidates(profileId, todayFor(profileId)))
    if (c.domain === "practice" && c.suggestedFloor != null)
      rightSizeFloor.set(c.targetId, c.suggestedFloor);

  // Per-item lines adopt the recap's VERDICT shape (#1722 item 5b): numbers, then
  // what they mean and what's next — never a bare ratio. Silent about the next step
  // when there is nothing true to say.
  const lines = behind.map(
    (b) => `${GLYPH.bullet} ${practiceShortfallLine(b)}`
  );
  const actions: NotificationAction[] = [];
  for (const b of behind.slice(0, MAX_PRACTICE_BUTTONS)) {
    actions.push({
      label: `${GLYPH.done} ${b.name}`,
      data: practiceDoneCallback(profileId, b.targetId, nonce),
    });
    const floor = rightSizeFloor.get(b.targetId);
    if (floor != null)
      actions.push({
        label: `⤓ ${b.name} → ${floor}×/wk`,
        data: rightSizeLowerCallback(profileId, b.targetId),
      });
  }
  // A deep link so the message works on EVERY channel (#1718). Web Push and Home
  // Assistant strip the "✅ Done" buttons, and the old body then told those users to
  // "tap when you've done a session" — an instruction to tap nothing. The link is the
  // affordance that survives everywhere; the line that named the buttons is gone,
  // because on Telegram it merely restated the adjacent `✅ Meditation` button.
  const base = deepLinkBase.replace(/\/$/, "");
  if (base) {
    actions.push({
      label: "Open practices →",
      url: `${base}${PRACTICES_HREF}`,
    });
  }

  // OVERFLOW DISCLOSURE (#1722 item 5a). Past the button cap the extra practices were
  // listed in the body with no way to act and no disclosure that buttons had been
  // dropped. The transport's own overflow phrasing, applied at the builder level where
  // the drop actually happens.
  const dropped = Math.max(0, behind.length - MAX_PRACTICE_BUTTONS);
  const overflowNote =
    dropped > 0
      ? `\n${GLYPH.caution} +${dropped} more — open the app to act on the rest.`
      : "";

  return {
    title: `${GLYPH.practice} Practice check-in`,
    body:
      behind.length === 1
        ? `${practiceShortfallLine(behind[0])}${overflowNote}`
        : `A few practices are behind this week:\n${lines.join("\n")}${overflowNote}`,
    actions,
    kind: "practice",
  };
}

// ---- The time-correction ride-along (issue #2875) ---------------------------

// How a practice message names the correction affordance, and where its rows are bound.
// `ref` is the message being rendered (#2264) — a fresh send has none and is, by
// construction, about to be the newest live practice message in the chat.
export interface PracticeCorrectionContext {
  now?: Date;
  ref?: { chatId: string | number; messageId: number };
  // The burst whose absolute-hour picker is currently OPEN, if any. The drill-down
  // REPLACES the keyboard in place (the #859 `symp:` → `symsev:` shape) and `↩︎ Back`
  // rebuilds the message unchanged, so no server-side pending state exists.
  picker?: CorrectionBurst;
  // Which day level that drill-down is showing (#3010): the recent hours, or the
  // previous day's own.
  pickerLevel?: CorrectionDay;
  // WHICH ✓ BUTTONS THE MESSAGE MAY STILL SHOW, as target ids read off the LIVE
  // keyboard — the food nudge's rule for its expansion count (#1807), one domain over:
  // the keyboard the chat is holding is the only record of what the user can still see,
  // and a redraw may not put back an affordance a tap consumed.
  //
  // Without it a rebuild silently UNDID the consume. `handlePracticeDoneTap` documents
  // that it "CONSUMES the tapped button so a stale message can't double-log", and
  // re-deriving from live pace does not achieve that: a practice at 1 of 3 is still
  // behind after the session lands, so the ✓ came straight back with a fresh nonce.
  // (The handler was never replay-idempotent — three replayed callbacks log three
  // sessions on main too — so what this restores is the affordance, not replay safety.)
  //
  // Omitted means "there is no keyboard to read", which is what a fresh send is.
  offered?: ReadonlySet<number>;
  // The tick's moment, for the #2188 rhythm hold. Omitted means "re-derive it from the
  // profile's own waking window and `now`" — see `practiceNudgeTimingNow`.
  timing?: PracticeNudgeTiming;
}

// The #2188 moment for a REDRAW. The send gets the tick's own moment threaded in; a tap
// rebuild and a sweep have no tick, so they read the same three inputs the tick read —
// the profile's zone, its waking window, and now.
//
// A redraw that passed NO timing fell through to the untimed gather, which holds
// nothing — so a practice the timed send deliberately withheld for its predicted day
// reappeared, with a live ✅ button, the moment any other button on the message was
// tapped. A suppression the write path applied and the redraw did not is the same defect
// in both directions; this is the redraw learning the rule.
export function practiceNudgeTimingNow(
  profileId: number,
  now: Date
): PracticeNudgeTiming {
  const tz = getTimezone(profileId);
  const sched = getNotifySchedule(profileId);
  return {
    weekday: weekdayInTz(tz, now),
    minuteOfDay: minuteOfDayInTz(tz, now),
    wakingStartHour: sched.wakingStartHour,
    wakingEndHour: sched.wakingEndHour,
  };
}

// The target ids a live practice keyboard still offers a ✓ for. Both `pdone` (the nudge)
// and `plog` (the `/practice` list) shapes carry the target in the same field, so this
// reads whichever the message actually has.
export function offeredPracticeTargets(
  rows: InlineKeyboard
): ReadonlySet<number> {
  const out = new Set<number>();
  for (const row of rows)
    for (const btn of row) {
      const parsed =
        parsePracticeDoneCallback(btn.callback_data) ??
        parsePracticeLogCallback(btn.callback_data);
      if (parsed) out.add(parsed.targetId);
    }
  return out;
}

// The correction rows a practice message should carry right now, plus the body lines
// that go with them. Every piece here is the SHARED helper (#221) — `correctableBursts`,
// `correctionActions`, `correctionPickerActions`, `correctionBodyStatement` and
// `correctionOffScopeStatement` are domain-blind, and this passes them the practice
// prefixes and nothing else. There is no practice-shaped fork.
//
// THE DAY BOUND IS WHY THE SPLIT EXISTS (#2875). This domain's write core refuses an
// answer that lands on another local day, and the shared offer computation now knows it
// (`dayKeyed` on the prefixes), so a burst it can no longer answer for is NOT drawn as a
// keyboard whose every button is refused — it is stated once in the body, naming the app
// as where a session's date is changed. That is the render half of the same rule; before
// it, at 00:20 local every chip and every picker hour on this keyboard was dead.
// The hours the picker's TITLE speaks for — this level's, plus level two's while level
// one is showing, because the `Yesterday →` step is an answer the question has (#3010).
// Only its EMPTINESS is read, so the union needs no ordering or de-duplication.
function pickerTitleHours(
  burst: CorrectionBurst,
  now: Date,
  tz: string,
  level: CorrectionDay
): string[] {
  const dayKeyed = PRACTICE_TIME_PREFIXES.dayKeyed;
  return [
    ...offeredHours(burst, now, tz, dayKeyed, level),
    ...(level === "today"
      ? offeredHours(burst, now, tz, dayKeyed, "prev")
      : []),
  ];
}

function practiceCorrection(
  profileId: number,
  ctx: PracticeCorrectionContext | undefined
): { actions: NotificationAction[]; statement: string | null } {
  if (!ctx) return { actions: [], statement: null };
  const now = ctx.now ?? clockNow();
  const tz = getTimezone(profileId);
  const bursts = getPracticeCorrectionBursts(
    profileId,
    now,
    // Bound to the `practice` kind: the nudge is the only practice message these rows
    // ride, so an UNATTRIBUTED burst (a web quick-sheet tap) may ride the newest live
    // nudge and nothing else.
    correctionMessageBinding(profileId, "practice", ctx.ref ?? null)
  );
  if (bursts.length === 0) return { actions: [], statement: null };
  const { shown, offScope } = correctableBursts(
    PRACTICE_TIME_PREFIXES,
    bursts,
    now,
    tz
  );
  // An open picker replaces the chips rather than joining them, so the keyboard asks
  // one question at a time. A picker whose burst has since gone off scope reverts to the
  // chip rows, which is the same thing the sweep would render.
  const open = ctx.picker
    ? (shown.find((b) => b.fromId === ctx.picker?.fromId) ?? null)
    : null;
  const actions = open
    ? correctionPickerActions(
        PRACTICE_TIME_PREFIXES,
        profileId,
        open,
        now,
        tz,
        ctx.pickerLevel ?? "today"
      )
    : correctionActions(PRACTICE_TIME_PREFIXES, profileId, shown, tz, now);
  // The body says what the keyboard cannot: the picker's question while it is open (this
  // domain's verb, finally asked — and it states the empty case rather than presenting a
  // grid of nothing), the statement of record for a burst that moved, and one line for
  // every burst the chat may no longer touch.
  const lines = [
    open
      ? correctionPickerTitle(
          "when was this",
          open,
          tz,
          // BOTH LEVELS (#3010). The title states the EMPTY case, and a burst with
          // nothing on the recent hours but something on yesterday's — a session tapped
          // at 23:50 and corrected at 00:30 — is not empty: the `Yesterday →` step is
          // right there on the keyboard.
          pickerTitleHours(open, now, tz, ctx.pickerLevel ?? "today")
        )
      : // THE WHOLE BURST SET, not the offerable half. A statement of record is a claim
        // about what the LEDGER now holds, and the commonest way a burst goes off scope
        // is that the correction SUCCEEDED — a sauna moved back to 00:15 no longer has a
        // chip that stays on its day. Passing `shown` there dropped the one sentence
        // stating the new value in exactly the interaction that produced it, leaving a
        // toast saying "Session time updated" above a body saying only that moving it
        // would change its day. What may be OFFERED is bounded; what is RECORDED is not.
        correctionBodyStatement(bursts, tz),
    correctionOffScopeStatement(offScope, tz),
  ].filter((l): l is string => l != null);
  return { actions, statement: lines.length > 0 ? lines.join("\n") : null };
}

// The pace nudge WITH its correction ride-along — the shape a rebuild after a tap
// renders, and the one the hourly sweep re-derives from.
//
// It answers even when NOTHING IS BEHIND ANY MORE, which `buildPracticeReminder` alone
// cannot: the common case is a single behind practice, and logging it clears the very
// shortfall that justified the message. Closing there would take the correction row
// down with it in exactly the case the feature exists for — the tap that just happened
// is the tap whose time might be wrong. So a cleared nudge with a live burst becomes a
// short confirmation carrying the chips.
//
// NULL MEANS ONE THING: THERE IS NOTHING TO SHOW AND NOTHING TO SAY, so close the
// message. It is the callers' whole contract with this builder, and both of them act on
// it — neither may leave a stale keyboard standing.
//
// It is stated that narrowly because the day bound made the other reading dangerous.
// Once a burst can go OFF SCOPE, "no actions" stopped meaning "nothing to show": the
// commonest way a practice burst loses its chips is that the correction SUCCEEDED, and
// the message then has a statement of record to make and a reason to give for the chips
// being gone. A builder that answered null there took the message down with it — the
// chat kept a stale time and a live chip after a write in one caller, and the surviving
// confirmation disappeared entirely in the other. So a STATEMENT alone is enough of a
// message: a buttonless confirmation that says what the ledger holds is the right
// answer, and it keeps the pointer alive for the sweep to close on its own clock.
//
// THE DEEP LINK IS DEFAULTED HERE, not left to the caller (#1718). `buildPracticeReminder`
// renders "Open practices →" only when it is handed a base, the send hands it
// `getPublicUrl()`, and every rebuild site handed it nothing — so the affordance that is
// meant to "survive everywhere" survived exactly until the first tap. The default is the
// same read every other builder in this directory makes for itself.
export function buildPracticeCorrectionRebuild(
  profileId: number,
  ctx: PracticeCorrectionContext,
  nonce: string = Date.now().toString(36),
  deepLinkBase: string = getPublicUrl()
): NotificationMessage | null {
  const now = ctx.now ?? clockNow();
  const { actions, statement } = practiceCorrection(profileId, { ...ctx, now });
  const base = buildPracticeReminder(
    profileId,
    nonce,
    deepLinkBase,
    ctx.timing ?? practiceNudgeTimingNow(profileId, now)
  );
  if (base) {
    // A ✓ the live keyboard no longer offers is one a tap consumed. Only the `pdone`
    // buttons are filtered: the ⤓ right-size offer and the deep link were never
    // consumed by a practice tap and are left exactly where the strip path left them.
    const kept = (base.actions ?? []).filter((a) => {
      if (!ctx.offered) return true;
      const parsed = parsePracticeDoneCallback(a.data);
      return parsed == null || ctx.offered.has(parsed.targetId);
    });
    const merged = [...kept, ...actions];
    // Every button is gone and no chip replaced it: a nudge is its buttons, so there is
    // no nudge left to render. It falls through to the confirmation shape rather than
    // returning here — if the correction has something to STATE, that sentence is the
    // message; if it has not, the fall-through answers null and the caller closes.
    if (merged.length > 0)
      return {
        ...base,
        body: statement ? `${base.body}\n${statement}` : base.body,
        actions: merged,
      };
  }
  if (actions.length === 0 && statement == null) return null;
  return {
    title: `${GLYPH.practice} Practice check-in`,
    // THE CONFIRMATION STILL CONFIRMS. The correction's sentence JOINS "Logged ✅"
    // rather than replacing it: this shape is what a ✓ tap leaves behind, and a message
    // whose only line explains why the time cannot be changed here has stopped
    // acknowledging the thing the user actually tapped.
    body: statement
      ? `Logged ${GLYPH.done}\n${statement}`
      : `Logged ${GLYPH.done}`,
    actions,
    kind: "practice",
  };
}
