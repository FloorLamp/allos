// The eating-time and dose-time correction taps (issues #2019, #2020) — the DB half.
//
// Four button families, two domains, ONE flow, because the two ledgers have the same
// shape: an immutable audit stamp for when the tap landed, and a correctable instant for
// when the thing actually happened.
//
//   foodtime   / dosetime    — a −Nh chip; re-stamps the burst and answers from the write.
//   foodtimeat / dosetimeat  — the 🕐 drill-down: `open`, an absolute `HH:MM`, or `back`.
//
// ── EVERY REFUSAL IS SPOKEN ──────────────────────────────────────────────────
//
// The markDoseTaken contract, all the way down. A chip whose burst has aged out of the
// ledger, a picker hour that is no longer offered, a token minted for a profile that does
// not share this chat: each writes NOTHING and says so. A silent ack would read as
// success, and on the dose side "success" means the redose window has been told something
// about a controlled medication.
//
// ── DIRECTION OF SAFETY (#2020) ──────────────────────────────────────────────
//
// A correction of a late tap only ever moves the administration instant EARLIER, which
// can only make the computed freshness of a dose SHORTER — the PRN redose window becomes
// more conservative, never less. That is the safe direction, and it is a property of the
// offer set (chips are −Nh; picker hours are all in the past), not of a check here.

import { getProfilesByTelegramChatId, getTimezone } from "../settings";
import { now as clockNow } from "../clock";
import {
  burstFrom,
  burstsForMessage,
  chipTarget,
  isBurstFresh,
  isOfferedHour,
  offeredHourInstant,
  type CorrectionBurst,
  type CorrectionDay,
  type CorrectionAtToken,
  type CorrectionChipToken,
  type TapEvent,
} from "../correction-time";
import { correctionMessageBinding } from "./message-pointers";
import {
  restampFoodEventsCore,
  type FoodRestampOutcome,
} from "../food-log-write";
import {
  restampPracticeLogsCore,
  type PracticeRestampOutcome,
} from "../practice-log";
import {
  buildPracticeCorrectionRebuild,
  offeredPracticeTargets,
} from "./practices";
import {
  getRecentDoseTaps,
  getRecentPracticeTaps,
  restampDoseLogsCore,
  type DoseRestampOutcome,
} from "../queries";
import {
  keyboardDoseFootprint,
  replacementWithTitle,
  resolveTapProfile,
  OUTDATED_MESSAGE_TEXT,
  type InlineKeyboard,
  type TapWrote,
} from "./callback-data";
import {
  correctionActions,
  correctionBodyStatement,
  correctionPickerActions,
  type CorrectionPrefixes,
  DOSE_TIME_PREFIXES,
  FOOD_TIME_PREFIXES,
  PRACTICE_TIME_PREFIXES,
} from "./correction-rows";
import { plainBody } from "./rich-text";
import { buildFoodNudge, consentedFoodTaps } from "./food";
import { keyboardChatOrigin, withChatOrigin } from "./chat-origin";
import { FOOD_NUDGE_WINDOWS, type FoodNudgeWindow } from "./food-format";
import { countVisibleFoodButtons } from "./food-format";
import { renderDoseSession, slotSessionForKeyboard } from "./intake";

import { answerCallbackQuery } from "./telegram-api";
import { closeMessage, rebuildMessage } from "./telegram";
import type { TelegramCallbackQuery } from "./telegram-api";
import type { NotificationAction, NotificationMessage } from "./types";
import { GLYPH } from "./glyphs";

// Everything a correction tap needs before it can do anything: who is acting, where the
// message is, and the burst the token anchors on — re-derived from the LEDGER, never
// remembered from the keyboard that rendered it.
interface Resolved {
  profileId: number;
  chatId: number | string;
  messageId: number;
  rows: InlineKeyboard;
  burst: CorrectionBurst;
  now: Date;
  tz: string;
  // The live message's own text, so a CLOSE can keep its title (#2875). Only the practice
  // path reads it — its rebuild is the one that can legitimately come back with nothing.
  text?: string;
  // The tap-time binding predicate (#3092 follow-up), built once here and consulted at
  // BOTH doors: `resolve` applies it for the spoken refusal, and every write path hands
  // it to its core to re-evaluate INSIDE the write transaction. The `await` between the
  // two doors is a real gap — a concurrent handler's synchronous pointer delete
  // (`closeMessage` → `forgetMessagePointerAt`, `dropMessagePointer`) landing in it
  // flips the anchor's provenance to null and re-merges it with taps this message never
  // showed — and the in-transaction evaluation is what closes it: the predicate reads
  // `notify_messages` at write time, against the burst the transaction itself derived.
  stillBound: (burst: CorrectionBurst) => boolean;
}

// Refusals, each naming what actually happened. "This burst is gone" is the common one
// and it is not an error: the correction window is an hour, and an hour is exactly how
// long the chat kept offering it.
//
// THE DEAD END NAMES THE WAY OUT (#3010). The chat is a trailing edit for a fresh burst;
// the app's own sheet edits a whole week. A refusal that does not say so leaves the user
// with nothing, which is how "last evening's dinner cannot be corrected the next morning"
// became a report rather than a preference. Each domain declares its surface on
// `CorrectionPrefixes.appSurface`, so the sentence is one phrasing per domain and not one
// per refusal site.
const lapsedText = (p: CorrectionPrefixes) =>
  `Too late to correct that here — the times are older than an hour. Fix it in ${p.appSurface}.`;
const NO_BURST_TEXT =
  "Couldn't find those entries any more — nothing was changed.";
const unofferedText = (p: CorrectionPrefixes) =>
  `That time isn't on offer any more — nothing was changed. Fix it in ${p.appSurface}.`;
// The floor (#2206). Repeat chip taps compose, so they have to stop somewhere; the chips
// come off the keyboard at that point, and a tap that still arrives (a stale keyboard, or
// a second tap racing a first past the edge) is REFUSED rather than clamped — a clamp
// would confirm a time nobody chose. It names the picker, which is what an answer that
// far back is for.
const OUT_OF_RANGE_TEXT =
  "That's as far back as the chips go — tap the row for an exact time.";
// The binding, re-checked at TAP time (#3092 follow-up). Provenance is mutable between
// render and tap: the pointer prune/close lifecycle deletes `notify_messages` rows
// routinely, and `ON DELETE SET NULL` flips the ledger rows that message stamped to
// unattributed — so by tap time the burst a token anchors on can have merged into the
// null partition with taps this message never showed (a web one-tap logged since), and
// a chip that wrote through it would restamp an administration from a message that
// never mentioned it. #2264's rule fails CLOSED: a message may only CORRECT a burst it
// may SHOW, decided by the same two functions the render used, and a tap the binding
// refuses writes nothing and says so.
const notBoundText = (p: CorrectionPrefixes) =>
  `This message can't correct those entries any more — nothing was changed. Fix it in ${p.appSurface}.`;

// The binding predicate, built ONCE per tap and consulted at both doors — see
// `Resolved.stillBound`. Exported for the DB tier, which pins the write-transaction
// door by deleting the pointer after the handler door has already passed.
export function correctionWriteBinding(
  profileId: number,
  prefixes: CorrectionPrefixes,
  chatId: number | string,
  messageId: number
): (burst: CorrectionBurst) => boolean {
  return (burst) =>
    burstsForMessage(
      [burst],
      correctionMessageBinding(profileId, prefixes.kind, { chatId, messageId })
    ).length > 0;
}

async function resolve(
  cq: TelegramCallbackQuery,
  token: { profileId: number; fromId: number },
  taps: (profileId: number, now: Date) => TapEvent[],
  // The domain, for the refusals that name where the answer belongs (#3010).
  prefixes: CorrectionPrefixes,
  // Whether this domain's refusals must be DISMISSED rather than glanced at. True for
  // doses (nothing was written to a medication ledger and the reader has to know) and
  // false for food, where a missed toast costs a serving's timestamp.
  alert = false
): Promise<Resolved | null> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (profileId == null || chatId == null || messageId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT, { alert });
    return null;
  }
  const now = clockNow();
  const burst = burstFrom(taps(profileId, now), token.fromId);
  if (!burst) {
    await answerCallbackQuery(cq.id, NO_BURST_TEXT, { alert });
    return null;
  }
  // The SAME freshness predicate the renderer applied, so a chat can never show a chip
  // the handler would refuse and can never refuse one it is still showing. Freshness is
  // one of the two bounds on an offer; the other belongs to the DOMAIN — a day-keyed
  // store refuses an answer that crosses local midnight, and the renderer drops exactly
  // those offers through the same `chipOffers` / `offeredHours` computation each handler
  // below admits with (#2875).
  if (!isBurstFresh(burst, now)) {
    await answerCallbackQuery(cq.id, lapsedText(prefixes), { alert });
    return null;
  }
  // The SAME binding rule the renderer applied, re-derived at tap time — see
  // `notBoundText`. Checked for every step, the pure keyboard edits included: opening
  // the picker on a burst this message may no longer show would render offers whose
  // writes this same check is about to refuse. The write cores evaluate the same
  // predicate AGAIN inside their transaction — see `Resolved.stillBound`.
  const stillBound = correctionWriteBinding(
    profileId,
    prefixes,
    chatId,
    messageId
  );
  if (!stillBound(burst)) {
    await answerCallbackQuery(cq.id, notBoundText(prefixes), { alert });
    return null;
  }
  return {
    profileId,
    chatId,
    messageId,
    rows,
    burst,
    now,
    tz: getTimezone(profileId),
    stillBound,
    ...(typeof cq.message?.text === "string" ? { text: cq.message.text } : {}),
  };
}

// ---- Food (#2019) ----------------------------------------------------------

// The nudge a food correction message should be rebuilt as. The window and day come off
// the LIVE keyboard's surviving `food:` tokens — the picker deliberately keeps them, so
// even mid-drill-down the message still says which nudge it is. A keyboard with none
// (a token replayed onto some other message) falls back to the profile's current day,
// which is the only honest answer left.
function foodRebuild(
  profileId: number,
  rows: InlineKeyboard,
  now: Date,
  // The message being rebuilt (#2264), so the correction rows stay bound to it.
  ref: { chatId: string | number; messageId: number },
  picker?: CorrectionBurst,
  pickerLevel: CorrectionDay = "today"
): NotificationMessage | null {
  let window: FoodNudgeWindow | null = null;
  let date: string | null = null;
  for (const row of rows) {
    for (const btn of row) {
      const d = btn.callback_data;
      if (typeof d !== "string") continue;
      // The token may carry an origin marker in a segment of its own (#3087), so the
      // window is found by ASKING which field is a window rather than by counting to
      // one — a fixed index silently read the profile id the day the marker landed.
      const f = d.split(":");
      if (f[0] !== "food" && f[0] !== "foodprotein") continue;
      const at = f.findIndex((seg) =>
        FOOD_NUDGE_WINDOWS.includes(seg as FoodNudgeWindow)
      );
      if (at > 0) {
        window = f[at] as FoodNudgeWindow;
        date = f[at + 1] ?? null;
      }
    }
  }
  if (!window || !date) return null;
  return withChatOrigin(
    buildFoodNudge(
      profileId,
      window,
      date,
      countVisibleFoodButtons(rows) || undefined,
      { now, ref, ...(picker ? { picker, pickerLevel } : {}) }
    ),
    keyboardChatOrigin(rows)
  );
}

async function rebuildFood(
  r: Resolved,
  picker?: CorrectionBurst,
  level: CorrectionDay = "today"
): Promise<void> {
  const rebuilt = foodRebuild(
    r.profileId,
    r.rows,
    r.now,
    { chatId: r.chatId, messageId: r.messageId },
    picker,
    level
  );
  if (rebuilt)
    await rebuildMessage(r.profileId, r.chatId, r.messageId, rebuilt);
}

// DID THE RESTAMP WRITE (#3933)? All three domains answer the same shape: every refusal
// — no burst, out of range, not bound to this message, a practice hour that crosses the
// day — leaves the ledger exactly as it was, so only `restamped` earns the tap-time
// sweep. One predicate rather than three, because the six handlers below differ in
// nothing but their domain.
function restamped(
  outcome: FoodRestampOutcome | DoseRestampOutcome | PracticeRestampOutcome,
  profileId: number
): TapWrote {
  return outcome.kind === "restamped" ? profileId : undefined;
}

// A chip on a food burst. Re-stamps every row of the burst from the instant it CURRENTLY
// stands at (#2206 — so a second tap goes further rather than landing where the first one
// did), keeping the burst's internal spread, and moves the serving's day + counter with it
// when the correction crosses local midnight.
export async function handleFoodTimeChip(
  cq: TelegramCallbackQuery,
  token: CorrectionChipToken
): Promise<TapWrote> {
  const r = await resolve(cq, token, consentedFoodTaps, FOOD_TIME_PREFIXES);
  if (!r) return;
  const outcome = restampFoodEventsCore(
    r.profileId,
    token.fromId,
    (row) => chipTarget(row, token.minutesBack, r.now),
    r.stillBound
  );
  await answerCallbackQuery(cq.id, foodRestampOutcomeText(outcome));
  await rebuildFood(r);
  return restamped(outcome, r.profileId);
}

// The toast for a chip or picker write, from what the write ACTUALLY did — never an
// unconditional confirm, because every one of these branches can happen.
function foodRestampOutcomeText(
  outcome: FoodRestampOutcome,
  hhmm?: string
): string {
  if (outcome.kind === "no-burst") return NO_BURST_TEXT;
  if (outcome.kind === "out-of-range") return OUT_OF_RANGE_TEXT;
  if (outcome.kind === "not-bound") return notBoundText(FOOD_TIME_PREFIXES);
  return foodRestampText(outcome.count, outcome.movedDays, hhmm);
}

// The 🕐 drill-down on a food burst: open the absolute-hour picker, apply a chosen hour,
// or come back to the untouched nudge.
export async function handleFoodTimeAt(
  cq: TelegramCallbackQuery,
  token: CorrectionAtToken
): Promise<TapWrote> {
  const r = await resolve(cq, token, consentedFoodTaps, FOOD_TIME_PREFIXES);
  if (!r) return;
  // `open` and `back` WRITE NOTHING — they swap the picker in and out — so the ack
  // precedes the edit (#2418's ordering rule, the same one the offer tail follows).
  if (token.step.kind === "open") {
    await answerCallbackQuery(cq.id);
    await rebuildFood(r, r.burst);
    return;
  }
  if (token.step.kind === "prev") {
    await answerCallbackQuery(cq.id);
    await rebuildFood(r, r.burst, "prev");
    return;
  }
  if (token.step.kind === "back") {
    await answerCallbackQuery(cq.id);
    await rebuildFood(r);
    return;
  }
  const hhmm = token.step.hhmm;
  // WHICH (day, hour) pairs are legal is a function of the current time and of the burst,
  // so it is decided here from the same computation that rendered the keyboard — a stale
  // picker offering 06:00 five hours later must not stamp it, and a token carrying a
  // FORGED day marker is refused for the same reason and by the same call (#3010).
  const instant = isOfferedHour(
    hhmm,
    r.burst,
    r.now,
    r.tz,
    FOOD_TIME_PREFIXES.dayKeyed,
    token.step.day,
    // The day the token NAMES, compared against the day level two is showing now — a
    // `p:` token minted before local midnight names a day that has rolled, and
    // resolving it against the new clock would stamp an instant 24 hours later than
    // the button said (#3010).
    token.step.date ?? null
  )
    ? offeredHourInstant(hhmm, token.step.day, r.now, r.tz)
    : null;
  if (!instant) {
    await answerCallbackQuery(cq.id, unofferedText(FOOD_TIME_PREFIXES));
    return;
  }
  const outcome = restampFoodEventsCore(
    r.profileId,
    token.fromId,
    () => instant,
    r.stillBound
  );
  await answerCallbackQuery(cq.id, foodRestampOutcomeText(outcome, hhmm));
  await rebuildFood(r);
  return restamped(outcome, r.profileId);
}

// The toast, from what the write ACTUALLY did. Names the re-dating explicitly: a serving
// silently moving to yesterday would otherwise look like it vanished from today's tally.
function foodRestampText(
  count: number,
  movedDays: number,
  hhmm?: string
): string {
  const what = count === 1 ? "1 serving" : `${count} servings`;
  const when = hhmm ? ` to ${hhmm}` : " back";
  const moved =
    movedDays > 0
      ? movedDays === count
        ? " — moved to yesterday"
        : ` — ${movedDays} moved to yesterday`
      : "";
  return `Eating time updated${when} for ${what}${moved} ${GLYPH.eventTime}`;
}

// ---- Doses (#2020) ---------------------------------------------------------

// The dose session a correction message should be rebuilt as. Harvested from the live
// keyboard first (a merged reminder spans several slots and all of them must come back),
// and — for a fully-confirmed session, whose keyboard has no dose buttons left — from the
// anchor LOG ROW's own dose and day, which the ledger still knows.
function doseRebuild(
  profileId: number,
  rows: InlineKeyboard,
  // The anchor log row's own dose + day, for the case the keyboard cannot answer: a
  // fully-confirmed session has no take/skip buttons left, so the ledger is the only
  // remaining record of which session this message is about. `slotSessionForKeyboard`
  // derives the SLOT from the dose id, so none is passed.
  anchor: { doseId: number; date: string } | null
): NotificationMessage | null {
  const footprint = keyboardDoseFootprint(rows);
  const doseIds = [...footprint.doseIds];
  const slots = [...footprint.slots];
  let date: string | null = null;
  for (const row of rows) {
    for (const btn of row) {
      const d = btn.callback_data;
      if (typeof d !== "string") continue;
      const f = d.split(":");
      if (f[0] === "take" || f[0] === "skip") date ??= f[4] ?? null;
      else if (f[0] === "all") date ??= f[3] ?? null;
    }
  }
  if (anchor) {
    if (anchor.doseId) doseIds.push(anchor.doseId);
    date ??= anchor.date;
  }
  if (!date) return null;
  const parts = slotSessionForKeyboard(profileId, doseIds, slots, date);
  if (parts.length === 0) return null;
  return renderDoseSession(profileId, parts, date);
}

// The anchor row's own dose + day, read back from the ledger.
//
// The chip and the picked hour take this from their restamp outcome. `open` and `back`
// WRITE NOTHING, so they have none — and a session whose doses are ALL confirmed renders
// no take/skip/All button at all (`renderWindowMessage` returns a bare summary once
// nothing is pending), so its keyboard carries the correction row and nothing else. With
// no anchor the rebuild then has no day to gather from, `doseRebuild` returns null, and
// the 🕐 button edits nothing while answering nothing — the one refusal this module does
// not speak, on the message the ordinary final confirm leaves behind. Same anchor the
// write paths pass, off the same ledger read the burst itself came from.
function doseAnchor(
  profileId: number,
  fromId: number,
  now: Date
): { doseId: number; date: string } | null {
  const row = getRecentDoseTaps(profileId, now).find((t) => t.id === fromId);
  return row ? { doseId: row.doseId, date: row.date } : null;
}

async function rebuildDose(
  r: Resolved,
  anchor: { doseId: number; date: string } | null,
  picker?: CorrectionBurst,
  level: CorrectionDay = "today"
): Promise<void> {
  const rebuilt = doseRebuild(r.profileId, r.rows, anchor);
  if (!rebuilt) return;
  // The correction ride-along is appended by the same builder the reminder itself uses,
  // so the picker and the chips ride the rebuilt message exactly as they rode the one
  // that was tapped — and once the burst is corrected, the BODY states the stored time
  // (#2264 bug 1) from the same computation every other dose render uses.
  const { actions, bursts } = doseCorrectionParts(r, picker, level);
  const statement = correctionBodyStatement(bursts, r.tz, r.now);
  await rebuildMessage(r.profileId, r.chatId, r.messageId, {
    ...rebuilt,
    ...(statement ? { body: `${plainBody(rebuilt.body)}\n${statement}` } : {}),
    actions: [...(rebuilt.actions ?? []), ...actions],
  });
}

// The dose message's own correction ride-along, from the SAME row builder the food nudge
// uses — the two domains differ only in prefix and in the picker's verb.
//
// The burst is RE-READ from the ledger rather than reused from `Resolved` (#2206). The
// resolve happened before the write, so reusing it would rebuild the row with the instant
// the correction just replaced — the chat asserting the value it had been asked to stop
// asserting. The food side gets this for free because `buildFoodNudge` re-queries; this
// is `resolve`'s own query, run again on the far side of the write.
//
// A burst the ledger no longer justifies renders NO row, rather than falling back to the
// one that was resolved: the row set is a query, and the one thing a rebuild may not do is
// restore a claim the write just retired.
function doseCorrectionParts(
  r: Resolved,
  picker?: CorrectionBurst,
  level: CorrectionDay = "today"
): { actions: NotificationAction[]; bursts: CorrectionBurst[] } {
  if (picker)
    return {
      actions: correctionPickerActions(
        DOSE_TIME_PREFIXES,
        r.profileId,
        picker,
        r.now,
        r.tz,
        level
      ),
      bursts: [picker],
    };
  const burst = burstFrom(
    getRecentDoseTaps(r.profileId, r.now),
    r.burst.fromId
  );
  // Re-attached only if the burst is still bound to THIS message (#2264): the row that
  // was just tapped rendered here, but a stale keyboard can carry a token for a burst
  // that belongs elsewhere, and a rebuild may not restore a claim the binding refuses.
  const bound = burst
    ? burstsForMessage(
        [burst],
        correctionMessageBinding(r.profileId, DOSE_TIME_PREFIXES.kind, {
          chatId: r.chatId,
          messageId: r.messageId,
        })
      )
    : [];
  return {
    actions:
      bound.length > 0
        ? correctionActions(DOSE_TIME_PREFIXES, r.profileId, bound, r.tz, r.now)
        : [],
    bursts: bound,
  };
}

export async function handleDoseTimeChip(
  cq: TelegramCallbackQuery,
  token: CorrectionChipToken
): Promise<TapWrote> {
  const r = await resolve(
    cq,
    token,
    getRecentDoseTaps,
    DOSE_TIME_PREFIXES,
    true
  );
  if (!r) return;
  const outcome = restampDoseLogsCore(
    r.profileId,
    token.fromId,
    (row) => chipTarget(row, token.minutesBack, r.now),
    r.stillBound
  );
  await answerCallbackQuery(cq.id, doseRestampText(outcome), {
    alert: doseRestampRefused(outcome),
  });
  await rebuildDose(r, anchorOf(outcome));
  return restamped(outcome, r.profileId);
}

export async function handleDoseTimeAt(
  cq: TelegramCallbackQuery,
  token: CorrectionAtToken
): Promise<TapWrote> {
  const r = await resolve(
    cq,
    token,
    getRecentDoseTaps,
    DOSE_TIME_PREFIXES,
    true
  );
  if (!r) return;
  // Pure keyboard edits, ack first (#2418).
  if (token.step.kind === "open") {
    await answerCallbackQuery(cq.id);
    await rebuildDose(r, doseAnchor(r.profileId, token.fromId, r.now), r.burst);
    return;
  }
  if (token.step.kind === "prev") {
    await answerCallbackQuery(cq.id);
    await rebuildDose(
      r,
      doseAnchor(r.profileId, token.fromId, r.now),
      r.burst,
      "prev"
    );
    return;
  }
  if (token.step.kind === "back") {
    await answerCallbackQuery(cq.id);
    await rebuildDose(r, doseAnchor(r.profileId, token.fromId, r.now));
    return;
  }
  const hhmm = token.step.hhmm;
  const instant = isOfferedHour(
    hhmm,
    r.burst,
    r.now,
    r.tz,
    DOSE_TIME_PREFIXES.dayKeyed,
    token.step.day,
    // The day the token NAMES, compared against the day level two is showing now — a
    // `p:` token minted before local midnight names a day that has rolled, and
    // resolving it against the new clock would stamp an instant 24 hours later than
    // the button said (#3010).
    token.step.date ?? null
  )
    ? offeredHourInstant(hhmm, token.step.day, r.now, r.tz)
    : null;
  if (!instant) {
    await answerCallbackQuery(cq.id, unofferedText(DOSE_TIME_PREFIXES), {
      alert: true,
    });
    return;
  }
  const outcome = restampDoseLogsCore(
    r.profileId,
    token.fromId,
    () => instant,
    r.stillBound
  );
  await answerCallbackQuery(cq.id, doseRestampText(outcome, hhmm), {
    alert: doseRestampRefused(outcome),
  });
  await rebuildDose(r, anchorOf(outcome));
  return restamped(outcome, r.profileId);
}

function anchorOf(outcome: DoseRestampOutcome) {
  return outcome.kind === "restamped" ? outcome.anchor : null;
}

// A restamp that wrote nothing. The ledger is a medication one, so its refusal is
// dismissed rather than glanced at — same rule as the dose buttons themselves.
function doseRestampRefused(outcome: DoseRestampOutcome): boolean {
  return outcome.kind !== "restamped";
}

// The toast. It states the ADHERENCE DAY IS UNCHANGED whenever the correction crossed
// midnight, because that is the one place this differs from the food side and a silent
// difference is how a user learns to distrust the button: the dose's day belongs to the
// schedule that asked for it (#614), so only the administration instant moves.
function doseRestampText(outcome: DoseRestampOutcome, hhmm?: string): string {
  if (outcome.kind === "no-burst") return NO_BURST_TEXT;
  if (outcome.kind === "out-of-range") return OUT_OF_RANGE_TEXT;
  if (outcome.kind === "not-bound") return notBoundText(DOSE_TIME_PREFIXES);
  const what = outcome.count === 1 ? "1 dose" : `${outcome.count} doses`;
  const when = hhmm ? ` to ${hhmm}` : " back";
  const day = outcome.crossedMidnight
    ? " — the day it counts for is unchanged"
    : "";
  return `Intake time updated${when} for ${what}${day} ${GLYPH.eventTime}`;
}

export { FOOD_TIME_PREFIXES, DOSE_TIME_PREFIXES };

// ---- Practices (#2875) -----------------------------------------------------

// The third domain, and the one whose stored value is not an instant: a practice row
// carries a profile-local `date` plus an "HH:MM", so the write core composes and
// decomposes through the profile's timezone (#450) and REFUSES an answer that would
// land on another day — correcting a practice's DATE is the expanded form's job, and a
// silently clamped time would teach `modalHour()` an hour the session never happened at.
const CROSSES_DAY_TEXT =
  "That would move the session to another day — change the date in the app.";

// What a practice message is replaced with when the rebuild has nothing left: no practice
// behind, no burst the ledger still justifies, and so nothing to state. The tap's own
// answer was already spoken in the toast, so this only has to stop the message claiming
// anything further.
const NOTHING_LEFT_TEXT = "Nothing left to correct here.";

// Rebuild the practice nudge this correction rides, so the chips re-render from the
// LEDGER after every write (#221) rather than from whatever the last keyboard showed.
//
// The ✓ buttons are the one exception, and they come from the KEYBOARD: a chip tap must
// not hand back a "✅ Sauna" the done-tap already consumed, and live pace alone cannot
// tell the difference (a practice at 1 of 3 is still behind after its session lands).
//
// EVERY OUTCOME EDITS THE CHAT. A tap that changed the ledger and left the message alone
// is the worst of the three answers: the chip that was just used stays live, and the
// label above it goes on asserting the time the write replaced. So a null rebuild —
// which now means only "nothing to show and nothing to say" — CLOSES the message rather
// than falling out of the function. Doing nothing is not an option this path has.
async function rebuildPractice(
  r: Resolved,
  picker?: CorrectionBurst,
  level: CorrectionDay = "today"
): Promise<void> {
  const rebuilt = buildPracticeCorrectionRebuild(r.profileId, {
    now: r.now,
    ref: { chatId: r.chatId, messageId: r.messageId },
    offered: offeredPracticeTargets(r.rows),
    ...(picker ? { picker, pickerLevel: level } : {}),
  });
  if (rebuilt) {
    await rebuildMessage(r.profileId, r.chatId, r.messageId, rebuilt);
    return;
  }
  await closeMessage(
    r.profileId,
    r.chatId,
    r.messageId,
    replacementWithTitle(r.text, NOTHING_LEFT_TEXT)
  );
}

function practiceRestampOutcomeText(
  outcome: PracticeRestampOutcome,
  hhmm?: string
): string {
  if (outcome.kind === "no-burst") return NO_BURST_TEXT;
  if (outcome.kind === "out-of-range") return OUT_OF_RANGE_TEXT;
  if (outcome.kind === "crosses-day") return CROSSES_DAY_TEXT;
  if (outcome.kind === "not-bound") return notBoundText(PRACTICE_TIME_PREFIXES);
  const what = outcome.count === 1 ? "1 session" : `${outcome.count} sessions`;
  const when = hhmm ? ` to ${hhmm}` : " back";
  return `Session time updated${when} for ${what} ${GLYPH.eventTime}`;
}

// A chip on a practice burst. Re-stamps every row from the instant it CURRENTLY stands
// at (#2206), so a second tap goes further rather than landing where the first one did.
export async function handlePracticeTimeChip(
  cq: TelegramCallbackQuery,
  token: CorrectionChipToken
): Promise<TapWrote> {
  const r = await resolve(
    cq,
    token,
    getRecentPracticeTaps,
    PRACTICE_TIME_PREFIXES
  );
  if (!r) return;
  const outcome = restampPracticeLogsCore(
    r.profileId,
    token.fromId,
    (row) => chipTarget(row, token.minutesBack, r.now),
    r.stillBound
  );
  await answerCallbackQuery(cq.id, practiceRestampOutcomeText(outcome));
  await rebuildPractice(r);
  return restamped(outcome, r.profileId);
}

// The 🕐 drill-down on a practice burst: open the absolute-hour picker, apply a chosen
// hour, or come back to the untouched nudge.
export async function handlePracticeTimeAt(
  cq: TelegramCallbackQuery,
  token: CorrectionAtToken
): Promise<TapWrote> {
  const r = await resolve(
    cq,
    token,
    getRecentPracticeTaps,
    PRACTICE_TIME_PREFIXES
  );
  if (!r) return;
  // `open` and `back` WRITE NOTHING, so the ack precedes the edit (#2418's ordering).
  if (token.step.kind === "open") {
    await answerCallbackQuery(cq.id);
    await rebuildPractice(r, r.burst);
    return;
  }
  if (token.step.kind === "prev") {
    await answerCallbackQuery(cq.id);
    await rebuildPractice(r, r.burst, "prev");
    return;
  }
  if (token.step.kind === "back") {
    await answerCallbackQuery(cq.id);
    await rebuildPractice(r);
    return;
  }
  const hhmm = token.step.hhmm;
  // WHICH hours are legal is a function of the current time AND of the burst's own local
  // day, decided here from the same computation that rendered the keyboard — a stale
  // picker must not stamp 06:00 five hours later, and an hour THE DAY RULE resolves onto
  // yesterday is one this domain's write core would refuse, so the picker never offered
  // it and the handler never admits it (#2875).
  const instant = isOfferedHour(
    hhmm,
    r.burst,
    r.now,
    r.tz,
    PRACTICE_TIME_PREFIXES.dayKeyed,
    token.step.day,
    // The day the token NAMES, compared against the day level two is showing now — a
    // `p:` token minted before local midnight names a day that has rolled, and
    // resolving it against the new clock would stamp an instant 24 hours later than
    // the button said (#3010).
    token.step.date ?? null
  )
    ? offeredHourInstant(hhmm, token.step.day, r.now, r.tz)
    : null;
  if (!instant) {
    await answerCallbackQuery(cq.id, unofferedText(PRACTICE_TIME_PREFIXES));
    return;
  }
  const outcome = restampPracticeLogsCore(
    r.profileId,
    token.fromId,
    () => instant,
    r.stillBound
  );
  await answerCallbackQuery(cq.id, practiceRestampOutcomeText(outcome, hhmm));
  await rebuildPractice(r);
  return restamped(outcome, r.profileId);
}
