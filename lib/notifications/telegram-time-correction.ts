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

import { today } from "../db";
import {
  getProfilesByTelegramChatId,
  getTimezone,
  getUserAge,
} from "../settings";
import { now as clockNow } from "../clock";
import {
  burstFrom,
  chipTarget,
  isBurstFresh,
  isOfferedHour,
  statedHourInstant,
  type CorrectionBurst,
  type CorrectionAtToken,
  type CorrectionChipToken,
  type TapEvent,
} from "../correction-time";
import {
  restampFoodEventsCore,
  type FoodRestampOutcome,
} from "../food-log-write";
import {
  getDoseCorrectionBursts,
  getRecentDoseTaps,
  getRecentFoodTaps,
  restampDoseLogsCore,
  type DoseRestampOutcome,
} from "../queries";
import {
  keyboardDoseFootprint,
  resolveTapProfile,
  OUTDATED_MESSAGE_TEXT,
  type InlineKeyboard,
} from "./callback-data";
import {
  correctionActions,
  correctionPickerActions,
  DOSE_TIME_PREFIXES,
  FOOD_TIME_PREFIXES,
} from "./correction-rows";
import { buildFoodNudge } from "./food";
import { FOOD_NUDGE_WINDOWS, type FoodNudgeWindow } from "./food-format";
import { countVisibleFoodButtons } from "./food-format";
import { slotSessionForKeyboard } from "./supplements";
import { renderMergedIntakeMessage } from "./supplement-format";
import { answerCallbackQuery } from "./telegram-api";
import { rebuildMessage } from "./telegram";
import type { TelegramCallbackQuery } from "./telegram-api";
import type { NotificationAction, NotificationMessage } from "./types";

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
}

// Refusals, each naming what actually happened. "This burst is gone" is the common one
// and it is not an error: the correction window is an hour, and an hour is exactly how
// long the chat kept offering it.
const LAPSED_TEXT =
  "Too late to correct that here — the times are older than an hour. Fix it in the app.";
const NO_BURST_TEXT =
  "Couldn't find those entries any more — nothing was changed.";
const UNOFFERED_TEXT =
  "That time isn't on offer any more — nothing was changed.";
// The floor (#2206). Repeat chip taps compose, so they have to stop somewhere; the chips
// come off the keyboard at that point, and a tap that still arrives (a stale keyboard, or
// a second tap racing a first past the edge) is REFUSED rather than clamped — a clamp
// would confirm a time nobody chose. It names the picker, which is what an answer that
// far back is for.
const OUT_OF_RANGE_TEXT =
  "That's as far back as the chips go — tap the row for an exact time.";

async function resolve(
  cq: TelegramCallbackQuery,
  token: { profileId: number; fromId: number },
  taps: (profileId: number, now: Date) => TapEvent[]
): Promise<Resolved | null> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (profileId == null || chatId == null || messageId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return null;
  }
  const now = clockNow();
  const burst = burstFrom(taps(profileId, now), token.fromId);
  if (!burst) {
    await answerCallbackQuery(cq.id, NO_BURST_TEXT);
    return null;
  }
  // The SAME freshness predicate the renderer applied, so a chat can never show a chip
  // the handler would refuse and can never refuse one it is still showing.
  if (!isBurstFresh(burst, now)) {
    await answerCallbackQuery(cq.id, LAPSED_TEXT);
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
  picker?: CorrectionBurst
): NotificationMessage | null {
  let window: FoodNudgeWindow | null = null;
  let date: string | null = null;
  for (const row of rows) {
    for (const btn of row) {
      const d = btn.callback_data;
      if (typeof d !== "string") continue;
      const f = d.split(":");
      if (f[0] !== "food" && f[0] !== "foodprotein") continue;
      if (FOOD_NUDGE_WINDOWS.includes(f[2] as FoodNudgeWindow)) {
        window = f[2] as FoodNudgeWindow;
        date = f[3] ?? null;
      }
    }
  }
  if (!window || !date) return null;
  return buildFoodNudge(
    profileId,
    window,
    date,
    countVisibleFoodButtons(rows) || undefined,
    { now, ...(picker ? { picker } : {}) }
  );
}

async function rebuildFood(
  r: Resolved,
  picker?: CorrectionBurst
): Promise<void> {
  const rebuilt = foodRebuild(r.profileId, r.rows, r.now, picker);
  if (rebuilt)
    await rebuildMessage(r.profileId, r.chatId, r.messageId, rebuilt);
}

// A chip on a food burst. Re-stamps every row of the burst from the instant it CURRENTLY
// stands at (#2206 — so a second tap goes further rather than landing where the first one
// did), keeping the burst's internal spread, and moves the serving's day + counter with it
// when the correction crosses local midnight.
export async function handleFoodTimeChip(
  cq: TelegramCallbackQuery,
  token: CorrectionChipToken
): Promise<void> {
  const r = await resolve(cq, token, getRecentFoodTaps);
  if (!r) return;
  const outcome = restampFoodEventsCore(r.profileId, token.fromId, (row) =>
    chipTarget(row, token.minutesBack, r.now)
  );
  await answerCallbackQuery(cq.id, foodRestampOutcomeText(outcome));
  await rebuildFood(r);
}

// The toast for a chip or picker write, from what the write ACTUALLY did — never an
// unconditional confirm, because every one of these branches can happen.
function foodRestampOutcomeText(
  outcome: FoodRestampOutcome,
  hhmm?: string
): string {
  if (outcome.kind === "no-burst") return NO_BURST_TEXT;
  if (outcome.kind === "out-of-range") return OUT_OF_RANGE_TEXT;
  return foodRestampText(outcome.count, outcome.movedDays, hhmm);
}

// The 🕐 drill-down on a food burst: open the absolute-hour picker, apply a chosen hour,
// or come back to the untouched nudge.
export async function handleFoodTimeAt(
  cq: TelegramCallbackQuery,
  token: CorrectionAtToken
): Promise<void> {
  const r = await resolve(cq, token, getRecentFoodTaps);
  if (!r) return;
  if (token.step.kind === "open") {
    await rebuildFood(r, r.burst);
    await answerCallbackQuery(cq.id);
    return;
  }
  if (token.step.kind === "back") {
    await rebuildFood(r);
    await answerCallbackQuery(cq.id);
    return;
  }
  const hhmm = token.step.hhmm;
  // WHICH hours are legal is a function of the current time, so it is decided here from
  // the same computation that rendered the keyboard — a stale picker offering 06:00 five
  // hours later must not stamp it.
  if (!isOfferedHour(hhmm, r.now, r.tz)) {
    await answerCallbackQuery(cq.id, UNOFFERED_TEXT);
    return;
  }
  const instant = statedHourInstant(hhmm, r.now, r.tz);
  const outcome = restampFoodEventsCore(
    r.profileId,
    token.fromId,
    () => instant
  );
  await answerCallbackQuery(cq.id, foodRestampOutcomeText(outcome, hhmm));
  await rebuildFood(r);
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
  return `Eating time updated${when} for ${what}${moved} 🕐`;
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
  return renderMergedIntakeMessage(
    profileId,
    parts,
    date,
    getUserAge(profileId)
  );
}

async function rebuildDose(
  r: Resolved,
  anchor: { doseId: number; date: string } | null,
  picker?: CorrectionBurst
): Promise<void> {
  const rebuilt = doseRebuild(r.profileId, r.rows, anchor);
  if (!rebuilt) return;
  // The correction ride-along is appended by the same builder the reminder itself uses,
  // so the picker and the chips ride the rebuilt message exactly as they rode the one
  // that was tapped.
  await rebuildMessage(r.profileId, r.chatId, r.messageId, {
    ...rebuilt,
    actions: [...(rebuilt.actions ?? []), ...doseCorrectionActions(r, picker)],
  });
}

// The dose message's own correction ride-along, from the SAME row builder the food nudge
// uses — the two domains differ only in prefix and in the picker's verb.
//
// The burst is RE-READ from the ledger rather than reused from `Resolved` (#2206). The
// resolve happened before the write, so reusing it would rebuild the row with the instant
// the correction just replaced — the chat asserting the value it had been asked to stop
// asserting. The food side gets this for free because `buildFoodNudge` re-queries; this
// is the same query, spelled here.
function doseCorrectionActions(
  r: Resolved,
  picker?: CorrectionBurst
): NotificationAction[] {
  if (picker)
    return correctionPickerActions(
      DOSE_TIME_PREFIXES,
      r.profileId,
      picker,
      r.now,
      r.tz
    );
  const burst =
    getDoseCorrectionBursts(r.profileId, r.now).find(
      (b) => b.fromId === r.burst.fromId
    ) ?? r.burst;
  return correctionActions(
    DOSE_TIME_PREFIXES,
    r.profileId,
    [burst],
    r.tz,
    r.now
  );
}

export async function handleDoseTimeChip(
  cq: TelegramCallbackQuery,
  token: CorrectionChipToken
): Promise<void> {
  const r = await resolve(cq, token, getRecentDoseTaps);
  if (!r) return;
  const outcome = restampDoseLogsCore(r.profileId, token.fromId, (row) =>
    chipTarget(row, token.minutesBack, r.now)
  );
  await answerCallbackQuery(cq.id, doseRestampText(outcome));
  await rebuildDose(r, anchorOf(outcome));
}

export async function handleDoseTimeAt(
  cq: TelegramCallbackQuery,
  token: CorrectionAtToken
): Promise<void> {
  const r = await resolve(cq, token, getRecentDoseTaps);
  if (!r) return;
  if (token.step.kind === "open") {
    await rebuildDose(r, null, r.burst);
    await answerCallbackQuery(cq.id);
    return;
  }
  if (token.step.kind === "back") {
    await rebuildDose(r, null);
    await answerCallbackQuery(cq.id);
    return;
  }
  const hhmm = token.step.hhmm;
  if (!isOfferedHour(hhmm, r.now, r.tz)) {
    await answerCallbackQuery(cq.id, UNOFFERED_TEXT);
    return;
  }
  const instant = statedHourInstant(hhmm, r.now, r.tz);
  const outcome = restampDoseLogsCore(r.profileId, token.fromId, () => instant);
  await answerCallbackQuery(cq.id, doseRestampText(outcome, hhmm));
  await rebuildDose(r, anchorOf(outcome));
}

function anchorOf(outcome: DoseRestampOutcome) {
  return outcome.kind === "restamped" ? outcome.anchor : null;
}

// The toast. It states the ADHERENCE DAY IS UNCHANGED whenever the correction crossed
// midnight, because that is the one place this differs from the food side and a silent
// difference is how a user learns to distrust the button: the dose's day belongs to the
// schedule that asked for it (#614), so only the administration instant moves.
function doseRestampText(outcome: DoseRestampOutcome, hhmm?: string): string {
  if (outcome.kind === "no-burst") return NO_BURST_TEXT;
  if (outcome.kind === "out-of-range") return OUT_OF_RANGE_TEXT;
  const what = outcome.count === 1 ? "1 dose" : `${outcome.count} doses`;
  const when = hhmm ? ` to ${hhmm}` : " back";
  const day = outcome.crossedMidnight
    ? " — the day it counts for is unchanged"
    : "";
  return `Intake time updated${when} for ${what}${day} 🕐`;
}

export { FOOD_TIME_PREFIXES, DOSE_TIME_PREFIXES };
