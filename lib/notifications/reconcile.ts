// Tick-time message reconciliation — the DB half (issue #1779).
//
// One sweep per profile per tick. It walks the live message pointers, asks each
// message's owning family which of its buttons are no longer actionable, and applies
// the pure decision from ./reconcile-core.
//
// ── THE ONE RULE EVERY FAMILY OBEYS ──────────────────────────────────────────
//
// A predicate here may only report what the LEDGER says. It never invents resolution
// and it never consults the findings-suppression bus: an Upcoming dismissal is a
// display choice and must never close a safety message (that separation is the whole
// reason "dose reminders are never silenced by suppression" survives this feature).
// Closing a dose reminder because the dose was actually logged is state-driven, not
// dismissal-driven — the dueness is genuinely gone.
//
// ── NO SECOND MODEL, NO SECOND RENDERER ──────────────────────────────────────
//
// Each predicate reads the SAME computation that composed the send: `collectWindowDoses`
// for a dose session, `behindPractices` for a practice shortfall, `getWorkoutPresence`
// for a live draft. The one family that re-RENDERS (food, whose button labels carry the
// counts) calls the same `buildFoodNudge` the send called, then edits only if the render
// actually differs — so an unchanged tick still performs zero Telegram calls.
//
// ── EDITS, NEVER SENDS ───────────────────────────────────────────────────────
//
// Everything below goes through `closeMessage` / `updateMessageKeyboard` /
// `rebuildMessage` on the chokepoint. Telegram does not notify on an edit, no new row
// appears in the chat, the phone stays silent. Reconciliation only ever REDUCES what a
// chat claims, which is the direction the contact-consent rule allows unilaterally.

import { today } from "../db";
import { createLogger } from "../log";
import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getFrequencyTargetProgress,
} from "../queries";
import { getMoodOnDate } from "../queries/mood";
import { getSymptomDaysInRange } from "../queries/symptoms";
import { getRefillRates } from "../queries/intake/refill";
import { assessProfilePreventive } from "../queries/upcoming/preventive";
import {
  daysOfSupplyLeft,
  isLowSupply,
  DEFAULT_LOW_SUPPLY_DAYS,
} from "../refill";
import { getProfileFoodTelegram, getUserAge } from "../settings";
import { getWorkoutPresence } from "../queries/presence";
import { collectWindowDoses, slotSessionForKeyboard } from "./supplements";
import {
  renderMergedIntakeMessage,
  type IntakeSendSlot,
} from "./supplement-format";
import { buildFoodNudge } from "./food";
import { FOOD_NUDGE_WINDOWS, type FoodNudgeWindow } from "./food-format";
import { getIntakeItemObligation } from "../queries/intake/adherence";
import {
  decideReconcile,
  keyboardTokens,
  RECONCILE_CLOSING,
  stripTokens,
  tokenPrefix,
} from "./reconcile-core";
import {
  inertTokens,
  owningFamily,
  type ReconcileFamily,
} from "./reconcile-registry";
import {
  dropMessagePointer,
  liveMessagePointers,
  pruneMessagePointers,
  updateMessagePointerKeyboard,
  type MessagePointer,
} from "./message-pointers";
import { messageKeyboard } from "./telegram-render";
import {
  closeMessage,
  rebuildMessage,
  updateMessageKeyboard,
} from "./telegram";
import type { NotificationMessage } from "./types";

const log = createLogger("notify");

// ---- Family predicates -----------------------------------------------------

interface FamilyReconciler {
  // The tokens on this keyboard whose tap is no longer actionable.
  dead(
    profileId: number,
    tokens: readonly string[],
    p: MessagePointer
  ): Set<string>;
  // Optional whole-message re-render from CURRENT state, used instead of
  // button-stripping. Returning null means "there is no message left to show".
  rebuild?(
    profileId: number,
    tokens: readonly string[],
    p: MessagePointer
  ): NotificationMessage | null;
}

function fields(token: string): string[] {
  return token.split(":");
}

// Doses resolved (taken OR deliberately skipped — #232: a skip resolves like a take)
// for one profile-date, memoized per sweep call so a message with twelve buttons reads
// the ledger once.
function resolvedDoseIds(profileId: number, date: string): Set<number> {
  const out = new Set<number>(getTakenDoseIds(profileId, date));
  for (const id of getSkippedDoseIds(profileId, date)) out.add(id);
  return out;
}

// ── intake-dose ──────────────────────────────────────────────────────────────
// take/skip: `take:<profileId>:<doseId>:<suppId>:<date>`
// all:       `all:<profileId>:<slot>:<date>`
// demote:    `demote:<profileId>:<itemId>:<date>`
const intakeDose: FamilyReconciler = {
  dead(profileId, tokens) {
    const dead = new Set<string>();
    const byDate = new Map<string, Set<number>>();
    const resolvedFor = (date: string) => {
      let s = byDate.get(date);
      if (!s) {
        s = resolvedDoseIds(profileId, date);
        byDate.set(date, s);
      }
      return s;
    };
    for (const t of tokens) {
      const f = fields(t);
      if (f[0] === "take" || f[0] === "skip") {
        const doseId = Number(f[2]);
        const date = f[4];
        if (doseId && date && resolvedFor(date).has(doseId)) dead.add(t);
      } else if (f[0] === "all") {
        // "✅ All (N)" is dead once every dose in that slot is resolved — read through
        // the SAME collectWindowDoses the send and the tap rebuild use.
        const slot = f[2] as IntakeSendSlot;
        const date = f[3];
        if (!slot || !date) continue;
        const entries = collectWindowDoses(profileId, slot, date);
        if (entries.length > 0 && entries.every((e) => e.taken || e.skipped))
          dead.add(t);
      } else if (f[0] === "demote") {
        // The ⤓ May suggestion is moot once the item IS `may` — the same
        // already-demoted refusal its own typed outcome would answer with.
        const itemId = Number(f[2]);
        if (itemId && getIntakeItemObligation(profileId, itemId) === "may")
          dead.add(t);
      }
    }
    return dead;
  },
  // Rebuild through the identical computation the TAP rebuild uses
  // (slotSessionForKeyboard → renderMergedIntakeMessage), so a partially reconciled
  // reminder is byte-identical to what tapping the same doses would have produced.
  rebuild(profileId, tokens) {
    const doseIds: number[] = [];
    const slots: IntakeSendSlot[] = [];
    let date: string | null = null;
    for (const t of tokens) {
      const f = fields(t);
      if (f[0] === "take" || f[0] === "skip") {
        if (Number(f[2])) doseIds.push(Number(f[2]));
        date ??= f[4] ?? null;
      } else if (f[0] === "all") {
        slots.push(f[2] as IntakeSendSlot);
        date ??= f[3] ?? null;
      }
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
  },
};

// ── escalation ───────────────────────────────────────────────────────────────
// `esctake|escskip|escack:<profileId>:<doseId>:<suppId>:<date>`
// The safety tier's sharpest case: a caregiver's chat must not keep claiming a dose
// was missed after it was confirmed anywhere.
const escalation: FamilyReconciler = {
  dead(profileId, tokens) {
    const dead = new Set<string>();
    const byDate = new Map<string, Set<number>>();
    for (const t of tokens) {
      const f = fields(t);
      if (!f[0].startsWith("esc")) continue;
      const doseId = Number(f[2]);
      const date = f[4];
      if (!doseId || !date) continue;
      let resolved = byDate.get(date);
      if (!resolved) {
        resolved = resolvedDoseIds(profileId, date);
        byDate.set(date, resolved);
      }
      if (resolved.has(doseId)) dead.add(t);
    }
    return dead;
  },
};

// ── household-round ──────────────────────────────────────────────────────────
// `hh:<receiver>:<member>:<doseId>:<itemId>:<date>` — one button per member, each
// resolving independently. The canonical PARTIAL case: two of three confirmed leaves
// one live button and removes the other two.
const householdRound: FamilyReconciler = {
  dead(_profileId, tokens) {
    const dead = new Set<string>();
    const byMemberDate = new Map<string, Set<number>>();
    for (const t of tokens) {
      const f = fields(t);
      if (f[0] !== "hh") continue;
      const memberId = Number(f[2]);
      const doseId = Number(f[3]);
      const date = f[5];
      if (!memberId || !doseId || !date) continue;
      const key = `${memberId}:${date}`;
      let resolved = byMemberDate.get(key);
      if (!resolved) {
        // Scoped to the MEMBER, whose ledger the button confirms against — never the
        // receiving profile's.
        resolved = resolvedDoseIds(memberId, date);
        byMemberDate.set(key, resolved);
      }
      if (resolved.has(doseId)) dead.add(t);
    }
    return dead;
  },
};

// ── food (class 2: additive) ─────────────────────────────────────────────────
// The buttons never lie — another serving is always loggable — but their labels carry
// the day's counts ("Leafy greens (2)") and the body carries the tally. So this family
// kills nothing and instead RE-RENDERS from the same builder; the sweep edits only when
// the render actually differs from what was delivered.
const food: FamilyReconciler = {
  dead() {
    return new Set<string>();
  },
  rebuild(profileId, tokens) {
    for (const t of tokens) {
      const f = fields(t);
      if (f[0] !== "food" && f[0] !== "foodprotein") continue;
      const window = f[2] as FoodNudgeWindow;
      const date = f[3];
      if (!FOOD_NUDGE_WINDOWS.includes(window) || !date) continue;
      return buildFoodNudge(profileId, window, date);
    }
    return null;
  },
};

// ── food-optin (class 3: decision) ───────────────────────────────────────────
// `foodoptin:<profileId>:<yes|no>` — the first-connection prompt. Once food logging is
// on, the choice it offers no longer exists.
const foodOptIn: FamilyReconciler = {
  dead(profileId, tokens) {
    if (!getProfileFoodTelegram(profileId)) return new Set<string>();
    return new Set(tokens.filter((t) => fields(t)[0] === "foodoptin"));
  },
};

// ── preventive ───────────────────────────────────────────────────────────────
// `pvdone|pvna|pvlater:<profileId>:<ruleKey>` — dead once the rule is no longer due
// (marked done, recorded by a real result, or declared not applicable in the app).
const preventive: FamilyReconciler = {
  dead(profileId, tokens) {
    const rules = tokens
      .map(fields)
      .filter((f) => f[0].startsWith("pv"))
      .map((f) => f.slice(2).join(":"));
    if (rules.length === 0) return new Set<string>();
    const summary = assessProfilePreventive(profileId, today(profileId));
    // `actionable` is the due/overdue slice — the exact set the nudge is composed
    // from, so "no longer actionable" means the same thing on both sides.
    const stillDue = new Set(summary.actionable.map((a) => a.key));
    return new Set(
      tokens.filter((t) => {
        const f = fields(t);
        if (!f[0].startsWith("pv")) return false;
        return !stillDue.has(f.slice(2).join(":"));
      })
    );
  },
};

// ── refill ───────────────────────────────────────────────────────────────────
// `rfsnooze:<profileId>:<itemId>` — dead once the shortage is over (the refill was
// logged in the app), read through the same daysOfSupplyLeft/isLowSupply pair the
// nudge itself is composed from.
const refill: FamilyReconciler = {
  dead(profileId, tokens) {
    const wanted = tokens.filter((t) => fields(t)[0] === "rfsnooze");
    if (wanted.length === 0) return new Set<string>();
    const rates = getRefillRates(profileId);
    const lowIds = new Set<number>();
    for (const s of getSupplements(profileId)) {
      if (!s.active || s.quantity_on_hand == null) continue;
      const daysLeft = daysOfSupplyLeft(
        s.quantity_on_hand,
        s.qty_per_dose,
        rates.get(s.id)?.dosesPerDay ?? 0
      );
      if (isLowSupply(daysLeft, DEFAULT_LOW_SUPPLY_DAYS)) lowIds.add(s.id);
    }
    return new Set(wanted.filter((t) => !lowIds.has(Number(fields(t)[2]))));
  },
};

// ── symptom ──────────────────────────────────────────────────────────────────
// `symp:<profileId>:<slug>` opens a severity picker; `symsev:<profileId>:<sev>:<slug>`
// logs it. Both are dead once that symptom is logged for the message's day in the app.
const symptom: FamilyReconciler = {
  dead(profileId, tokens, p) {
    const days = getSymptomDaysInRange(profileId, p.date, p.date, 20);
    const logged = new Set(
      days.flatMap((d) => d.symptoms.map((s) => s.symptom.toLowerCase()))
    );
    if (logged.size === 0) return new Set<string>();
    return new Set(
      tokens.filter((t) => {
        const f = fields(t);
        const slug =
          f[0] === "symp" ? f[2] : f[0] === "symsev" ? f[3] : undefined;
        return (
          slug != null && logged.has(slug.replace(/_/g, " ").toLowerCase())
        );
      })
    );
  },
};

// ── mood ─────────────────────────────────────────────────────────────────────
// `mood:<profileId>:<valence>:<date>` and `moodkeep:<profileId>:<date>` — both answered
// once the day's check-in exists, whichever surface logged it.
const mood: FamilyReconciler = {
  dead(profileId, tokens) {
    const dead = new Set<string>();
    const byDate = new Map<string, boolean>();
    for (const t of tokens) {
      const f = fields(t);
      const date = f[0] === "mood" ? f[3] : f[0] === "moodkeep" ? f[2] : null;
      if (!date) continue;
      let logged = byDate.get(date);
      if (logged === undefined) {
        logged = getMoodOnDate(profileId, date) != null;
        byDate.set(date, logged);
      }
      if (logged) dead.add(t);
    }
    return dead;
  },
};

// ── workout-draft ────────────────────────────────────────────────────────────
// `wofinish|wodiscard:<profileId>:<activityId>` — dead once that draft is no longer the
// live session (finished or discarded in the app), read through the SAME presence
// computation the nudge is gated on.
const workoutDraft: FamilyReconciler = {
  dead(profileId, tokens) {
    const presence = getWorkoutPresence(profileId);
    return new Set(
      tokens.filter((t) => {
        const f = fields(t);
        if (f[0] !== "wofinish" && f[0] !== "wodiscard") return false;
        const activityId = Number(f[2]);
        if (!activityId) return false;
        return !(
          presence.state === "active" && presence.activityId === activityId
        );
      })
    );
  },
};

// ── practice ─────────────────────────────────────────────────────────────────
// `pdone:<profileId>:<targetId>:<nonce>` — dead once the target is no longer behind
// (a session logged in the app), read through the SAME frequency-target progress the
// nudge is composed from. Deliberately NOT `behindPractices`, which also applies the
// suppression bus: a DISMISSAL must never close a message, only real progress may.
const practice: FamilyReconciler = {
  dead(profileId, tokens) {
    const wanted = tokens.filter((t) => fields(t)[0] === "pdone");
    if (wanted.length === 0) return new Set<string>();
    const behind = new Set(
      getFrequencyTargetProgress(profileId)
        .filter((p) => !p.met && !p.atCeiling && p.pace === "behind")
        .map((p) => p.target.id)
    );
    return new Set(wanted.filter((t) => !behind.has(Number(fields(t)[2]))));
  },
};

// Exhaustive by TYPE: adding a family to the registry without a reconciler here is a
// compile error, which is the other half of the completeness guard.
const FAMILIES: Record<ReconcileFamily, FamilyReconciler> = {
  "intake-dose": intakeDose,
  escalation,
  "household-round": householdRound,
  food,
  "food-optin": foodOptIn,
  preventive,
  refill,
  symptom,
  mood,
  "workout-draft": workoutDraft,
  practice,
};

// ---- The sweep -------------------------------------------------------------

export interface ReconcileResult {
  // Pointers examined this pass.
  examined: number;
  // Telegram edit calls actually made. The IDEMPOTENCE PIN: a steady state reconciles
  // to zero, which is what keeps this off the rate limiter.
  edited: number;
  closed: number;
  dropped: number;
  pruned: number;
}

// Reconcile every live message for one profile. Best-effort throughout: a failed edit
// (message deleted, chat gone, past Telegram's edit horizon) drops the pointer and
// moves on — a reconcile failure must never fail a tick that has reminders to deliver.
export async function reconcileProfileMessages(
  profileId: number
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    examined: 0,
    edited: 0,
    closed: 0,
    dropped: 0,
    pruned: 0,
  };
  result.pruned = pruneMessagePointers(profileId);
  const td = today(profileId);

  for (const pointer of liveMessagePointers(profileId)) {
    result.examined++;
    const tokens = keyboardTokens(pointer.keyboard);
    const inert = inertTokens(tokens, tokenPrefix);
    const family = owningFamily(tokens, tokenPrefix);
    const reconciler = family ? FAMILIES[family] : null;

    // An UNKNOWN or claim-less keyboard is left exactly as it is (outside rollover):
    // failing safe means never closing a message nobody has reasoned about.
    const dead = reconciler
      ? reconciler.dead(profileId, tokens, pointer)
      : new Set<string>();

    const decision = decideReconcile({
      keyboard: pointer.keyboard,
      dead,
      inert,
      rolledOver: pointer.date < td,
    });

    try {
      if (decision.action === "none") {
        // The additive class still re-renders: its buttons never die, but their
        // labels carry counts that do. The edit is gated on the render actually
        // differing, so a quiet tick stays at zero calls.
        if (await maybeRerender(profileId, pointer, tokens, reconciler))
          result.edited++;
        continue;
      }
      if (decision.action === "close") {
        await closeMessage(
          pointer.chatId,
          pointer.messageId,
          RECONCILE_CLOSING[decision.reason]
        );
        dropMessagePointer(profileId, pointer.id);
        result.closed++;
        continue;
      }
      if (decision.action === "strip-all") {
        await updateMessageKeyboard(
          pointer.chatId,
          pointer.messageId,
          decision.keyboard
        );
        updateMessagePointerKeyboard(profileId, pointer.id, decision.keyboard);
        result.edited++;
        continue;
      }
      // Partial resolution. A family with a rebuilder re-renders the whole message
      // from current state (the same computation the tap rebuild runs); everything
      // else has exactly the dead buttons removed.
      const rebuilt = reconciler?.rebuild?.(profileId, tokens, pointer) ?? null;
      if (rebuilt) {
        await rebuildMessage(
          profileId,
          pointer.chatId,
          pointer.messageId,
          rebuilt
        );
        updateMessagePointerKeyboard(
          profileId,
          pointer.id,
          messageKeyboard(rebuilt)
        );
      } else {
        await updateMessageKeyboard(
          pointer.chatId,
          pointer.messageId,
          decision.keyboard
        );
        updateMessagePointerKeyboard(profileId, pointer.id, decision.keyboard);
      }
      result.edited++;
    } catch (e) {
      // A dead pointer: Telegram refuses edits on a deleted message, a chat the bot
      // was removed from, or a message past its edit horizon. Nothing is recoverable,
      // so forget it rather than retry forever.
      log.info("message reconcile failed (pointer dropped)", {
        profile: profileId,
        chat: pointer.chatId,
        err: e instanceof Error ? e.message : String(e),
      });
      dropMessagePointer(profileId, pointer.id);
      result.dropped++;
    }
  }
  return result;
}

// The additive-class re-render. Returns whether an edit was actually made — the render
// is compared against the DELIVERED keyboard, so an unchanged nudge performs no call.
async function maybeRerender(
  profileId: number,
  pointer: MessagePointer,
  tokens: readonly string[],
  reconciler: FamilyReconciler | null
): Promise<boolean> {
  if (!reconciler?.rebuild) return false;
  // Only the families whose buttons never die re-render from the "none" branch; a
  // family with real dead tokens has already been handled by the decision above.
  const rebuilt = reconciler.rebuild(profileId, tokens, pointer);
  if (!rebuilt) return false;
  const next = messageKeyboard(rebuilt);
  if (JSON.stringify(next) === JSON.stringify(pointer.keyboard)) return false;
  await rebuildMessage(profileId, pointer.chatId, pointer.messageId, rebuilt);
  updateMessagePointerKeyboard(profileId, pointer.id, next);
  return true;
}

// Re-exported for the DB tier's assertions and the tick's logging.
export { stripTokens };
