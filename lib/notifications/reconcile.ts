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
// ── NO SECOND DATE RULE EITHER (#2018) ───────────────────────────────────────
//
// The same discipline governs WHEN a button stops being actionable. The sweep does not
// decide how late a tap may land; it asks the guard the tap handler asks — `tapDateGuard`
// for the families whose token date is a guess at a user-owned fact, `isDoseDateAccepted`
// for the ones whose token date is a schedule fact the system itself established. The
// per-family answer is DECLARED in ./reconcile-registry (RECONCILE_DATE_GUARD) and
// resolved by `messageExpiry`; nothing here compares dates.
//
// ── NO SECOND MODEL, NO SECOND RENDERER ──────────────────────────────────────
//
// Each predicate reads the SAME computation that composed the send: `collectWindowDoses`
// for a dose session, `behindPractices` for a practice shortfall, `getWorkoutPresence`
// for a live draft. The one family that re-RENDERS (food, whose button labels carry the
// counts) calls the same `buildFoodNudge` the send called, then edits only if the render
// actually differs — so an unchanged tick still performs zero Telegram calls.
//
// ── OVERLAPPING TICKS ────────────────────────────────────────────────────────
//
// scripts/notify.ts already warns that an instance can end up with two schedulers (a
// compose poll sidecar plus a host crontab); two app replicas on one volume and a
// manual `notify` run during the hourly one produce the same overlap. This sweep does
// not assume the operator got that right. Each edit is CLAIMED with a compare-and-swap
// on the pointer's stored keyboard before any network call, so a second concurrent pass
// refuses the duplicate work instead of spending a second Bot API call on an identical
// result (#1788). See ./message-pointers.ts for the claim itself.
//
// ── EDITS, NEVER SENDS ───────────────────────────────────────────────────────
//
// Everything below goes through `closeMessage` / `updateMessageKeyboard` /
// `rebuildMessage` on the chokepoint. Telegram does not notify on an edit, no new row
// appears in the chat, the phone stays silent. Reconciliation only ever REDUCES what a
// chat claims, which is the direction the contact-consent rule allows unilaterally.

import { db, today } from "../db";
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
import {
  getProfileFoodTelegram,
  getProfileSetting,
  getUserAge,
  setProfileSetting,
} from "../settings";
import { getWorkoutPresence } from "../queries/presence";
import {
  collectWindowDoses,
  slotSessionForKeyboard,
  withDoseCorrections,
} from "./supplements";
import {
  renderMergedIntakeMessage,
  type IntakeSendSlot,
} from "./supplement-format";
import { buildFoodNudge } from "./food";
import { now as clockNow } from "../clock";
import { correctionTokenAnchor } from "../correction-time";
import {
  DOSE_TIME_PREFIXES,
  FOOD_TIME_PREFIXES,
  openPickerAnchor,
  type CorrectionPrefixes,
} from "./correction-rows";
import { getFoodCorrectionBursts } from "../queries";
import { getDoseCorrectionBursts } from "../queries/intake/adherence";
import {
  countVisibleFoodButtons,
  FOOD_NUDGE_WINDOWS,
  type FoodNudgeWindow,
} from "./food-format";
import { getIntakeItemObligation } from "../queries/intake/adherence";
import { buildDigest, renderDigestMessage } from "./digest";
import { gatherDigestInput } from "./digest-data";
import {
  digestDependencyStamp,
  DIGEST_REGATHER_FLOOR_MS,
} from "./digest-deps";
import {
  decideProseGather,
  decideReconcile,
  formatProseGatherRecord,
  keyboardTokens,
  messageBodyHash,
  parseProseGatherRecord,
  type ReconcileDecision,
  reconcileClosingText,
  stripTokens,
  tokenPrefix,
} from "./reconcile-core";
import {
  inertTokens,
  messageExpiry,
  owningFamily,
  proseReconcilerFor,
  type ProseReconciler,
  type ReconcileFamily,
} from "./reconcile-registry";
import {
  claimMessagePointerBody,
  claimMessagePointerClose,
  claimMessagePointerKeyboard,
  releaseMessagePointerBody,
  dropMessagePointer,
  liveMessagePointers,
  pruneMessagePointers,
  releaseMessagePointerKeyboard,
  restoreMessagePointer,
  type MessagePointer,
} from "./message-pointers";
import { classifyTelegramFailure } from "./telegram-error";
import { messageKeyboard } from "./telegram-render";
import {
  closeMessage,
  rebuildMessage,
  updateMessageKeyboard,
} from "./telegram";
import type { InlineKeyboard } from "./telegram-render";
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

// ── The time-correction ride-along, for BOTH families (#2019/#2020) ──────────
//
// A correction chip claims "these entries are still correctable here", and that stops
// being true an hour after the burst was tapped. Both families ask the SAME question of
// their own ledger, through the same freshness predicate the renderer used — so a chat
// can never show a chip the handler would refuse, and never refuse one it is showing.
//
// A dead correction token is what produces the ONE trailing edit per logging burst: the
// tick after the hour, the rows come off, and the next tick is back to zero calls.
function deadCorrectionTokens(
  tokens: readonly string[],
  prefixes: CorrectionPrefixes,
  freshAnchors: Set<number>
): Set<string> {
  const dead = new Set<string>();
  for (const t of tokens) {
    const anchor = correctionTokenAnchor(t, [prefixes.chip, prefixes.at]);
    if (anchor != null && !freshAnchors.has(anchor)) dead.add(t);
  }
  return dead;
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
    const dead = deadCorrectionTokens(
      tokens,
      DOSE_TIME_PREFIXES,
      new Set(
        getDoseCorrectionBursts(profileId, clockNow()).map((b) => b.fromId)
      )
    );
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
    // The correction ride-along rides the SWEEP's rebuild too (#2020), from the same
    // helper the send and both tap rebuilds use — otherwise the tick would edit the
    // chips off a keyboard the very next tap would put straight back, and the
    // zero-call steady state this sweep exists to hold would be gone.
    return withDoseCorrections(
      profileId,
      renderMergedIntakeMessage(profileId, parts, date, getUserAge(profileId)),
      {
        now: clockNow(),
        pickerAnchor: openPickerAnchor(tokens, DOSE_TIME_PREFIXES),
      }
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
//
// EXPANSION IS THE USER'S (#1807). The re-render must derive its visible count from the
// LIVE keyboard, exactly as the tap handlers do — the pointer's stored blob is the only
// record of what the chat is showing, and it is post-cap, so it is the same number
// `countVisibleFoodButtons` would read off a tap. Rebuilding at the default instead would
// let a tick silently COLLAPSE a keyboard the user expanded (and, once "Show less" exists,
// silently RE-EXPAND one they collapsed) — a unilateral change to what the user asked to
// see, with no tap behind it. Zero is the "no ranked buttons at all" reading; `|| undefined`
// hands that case back to the builder's own default rather than rendering an empty keyboard.
const food: FamilyReconciler = {
  // The quick-log buttons never die — another serving is always loggable — but the
  // correction chips riding beside them do, on their own hour-long clock (#2019).
  dead(profileId, tokens) {
    return deadCorrectionTokens(
      tokens,
      FOOD_TIME_PREFIXES,
      new Set(
        getFoodCorrectionBursts(profileId, clockNow()).map((b) => b.fromId)
      )
    );
  },
  rebuild(profileId, tokens, p) {
    for (const t of tokens) {
      const f = fields(t);
      if (f[0] !== "food" && f[0] !== "foodprotein") continue;
      const window = f[2] as FoodNudgeWindow;
      const date = f[3];
      if (!FOOD_NUDGE_WINDOWS.includes(window) || !date) continue;
      const visibleCount = countVisibleFoodButtons(p.keyboard) || undefined;
      const now = clockNow();
      // An OPEN eating-time picker is the user's current view, exactly as the expansion
      // is (#1807), so the rebuild preserves it rather than editing the question away
      // while it is being answered. It survives only while its burst is still fresh —
      // once it is not, the anchor is gone from the offer set and the plain nudge comes
      // back, which is how an ABANDONED picker gets closed by the ordinary sweep.
      const anchor = openPickerAnchor(tokens, FOOD_TIME_PREFIXES);
      const picker =
        anchor != null
          ? getFoodCorrectionBursts(profileId, now).find(
              (b) => b.fromId === anchor
            )
          : undefined;
      return buildFoodNudge(profileId, window, date, visibleCount, {
        now,
        ...(picker ? { picker } : {}),
      });
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

// ---- Prose-claim reconcilers (issue #1913 item 4) --------------------------
//
// The families above are keyboard-shaped: each answers "is this token still actionable?".
// A REPORT-shaped message makes its claims in sentences, and the morning digest is the
// app's most-read one — "Supplements: 8/9 taken — missed Glycine (2 days)" stood until
// the next morning after the user resolved it, which is #1779's harm pattern in prose.
//
// The rule is the one every other class obeys: NO SECOND RENDERER. Re-run the SAME
// builder the send ran, for the pointer's own date, and let the mechanical half decide
// whether anything changed.
type ProseRebuilder = (
  profileId: number,
  p: MessagePointer
) => NotificationMessage | null;

interface ProseClaim {
  rebuild: ProseRebuilder;
  // THE CHEAP PRE-CHECK (#2069): a fingerprint of the ledgers whose writes can move this
  // kind's claims, read before the rebuild is paid for. Null for a kind that declares
  // none, which then rebuilds every tick exactly as it did before.
  stamp: ((profileId: number) => string) | null;
  // How long a recorded gather may stand before the rebuild happens anyway, whatever the
  // stamp says. This is what lets a stamp be a curated accelerator rather than a
  // completeness claim — see ./digest-deps.
  floorMs: number;
  // The profile_settings key holding the last gather's record. A LITERAL per kind, never
  // composed from a variable: the send-marker scan (#2036) can only resolve literals, and
  // an unresolvable `notify_…` key is exactly the hole that registry exists to close.
  gatherKey: string;
}

const PROSE: Record<ProseReconciler, ProseClaim> = {
  digest: {
    // gatherDigestInput → buildDigest → renderDigestMessage: byte-for-byte the pipeline
    // runDigest performs, so a reconciled digest is exactly the message that would have
    // been sent had it been composed now. A day whose content has fallen away entirely
    // (buildDigest returns null) leaves the delivered report alone rather than blanking
    // it — reconciliation corrects claims, it does not delete a message the user read.
    rebuild: (profileId) =>
      withDigestProfileName(profileId, (name) => {
        const model = buildDigest(gatherDigestInput(profileId, name));
        return model ? renderDigestMessage(model) : null;
      }),
    stamp: digestDependencyStamp,
    floorMs: DIGEST_REGATHER_FLOOR_MS,
    gatherKey: "notify_digest_recon",
  },
};

// The profile's display name, which the digest title carries. Read here rather than
// stored on the pointer: a renamed profile should reconcile under its current name, and
// the title is re-derived by the same builder either way.
function withDigestProfileName(
  profileId: number,
  build: (name: string) => NotificationMessage | null
): NotificationMessage | null {
  const row = db
    .prepare("SELECT name FROM profiles WHERE id = ?")
    .get(profileId) as { name: string } | undefined;
  if (!row) return null;
  return build(row.name);
}

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
  // Pointers forgotten because the message is permanently unreachable (#1885).
  dropped: number;
  // Edits that failed TRANSIENTLY (#1885): the claim was released and the pointer left
  // exactly as it was found, so the next tick recomputes the same plan and retries.
  deferred: number;
  pruned: number;
  // Edits another overlapping tick had already claimed (#1788). Non-zero means two
  // reconcile passes are running against one profile — benign, and the whole point is
  // that the SECOND one costs no Telegram calls.
  skipped: number;
  // Pointers whose own reconciliation THREW (#2070) — a compute failure, not a transport
  // one, so nothing was assumed about the message and the pointer was left as found. The
  // sweep carried on to every remaining pointer; this is the count that says so, and it
  // is what the tick logs so a persistent per-profile build bug is visible rather than
  // silently starving that profile's stale-keyboard cleanup.
  failed: number;
}

// Reconcile every live message for one profile. Best-effort throughout: a failed edit
// never fails a tick that has reminders to deliver. What a failure MEANS is classified,
// not assumed (#1885) — a permanently dead message (deleted, chat gone, past Telegram's
// edit horizon) drops its pointer, while a transient one (rate limit, 5xx, network,
// timeout) releases the claim and leaves the pointer for the next tick.
export async function reconcileProfileMessages(
  profileId: number
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    examined: 0,
    edited: 0,
    closed: 0,
    dropped: 0,
    deferred: 0,
    pruned: 0,
    skipped: 0,
    failed: 0,
  };
  result.pruned = pruneMessagePointers(profileId);
  const td = today(profileId);

  for (const pointer of liveMessagePointers(profileId)) {
    result.examined++;
    // ── ONE POINTER'S FAILURE IS ONE POINTER'S FAILURE (#2070) ─────────────
    //
    // Everything a single pointer needs is inside this call, so a throw from any of it —
    // a reconciler predicate, a prose rebuild, a claim — stops HERE. It used to
    // propagate out of the sweep entirely, and because the digest is normally the
    // earliest-`sent_at` pointer of the day, a digest that could not be rebuilt for one
    // profile meant NO other pointer of that profile was examined that tick: a same-day
    // dose or escalation keyboard the ledger had already resolved kept its live "✅
    // Taken" button up, for as long as the build kept failing. A stale coaching nudge is
    // an annoyance; a live confirm button on a dose already taken is the prompt that
    // invites a double dose, and it must not be starved by an unrelated bug.
    //
    // WHAT THE FAILURE MEANS IS STILL CLASSIFIED, NEVER ASSUMED (#1885): this is a
    // COMPUTE failure, which says nothing whatsoever about whether the message is still
    // reachable, so the pointer is left exactly as it was found and the next tick tries
    // again. Only ./telegram-error's classification may forget a pointer.
    try {
      await reconcilePointer(profileId, pointer, td, result);
    } catch (e) {
      result.failed++;
      log.error("message reconcile failed for one pointer (sweep continues)", {
        profile: profileId,
        chat: pointer.chatId,
        kind: pointer.kind,
        err: e instanceof Error ? e : String(e),
      });
    }
  }
  return result;
}

// ONE live pointer, start to finish. Extracted from the sweep so the try/catch above can
// bound it (#2070); the logic is unchanged.
async function reconcilePointer(
  profileId: number,
  pointer: MessagePointer,
  td: string,
  result: ReconcileResult
): Promise<void> {
  // ── The prose-claim class (#1913 item 4) ──────────────────────────────
  //
  // Handled first and completely: a report's claims are its sentences, and the token
  // machinery below has nothing to say about them (every digest button is inert).
  const prose = proseReconcilerFor(pointer.kind);
  if (prose) {
    // DAY ROLLOVER DROPS THE POINTER, IT DOES NOT CLOSE THE MESSAGE. Yesterday's digest described
    // yesterday and is honest AS HISTORY; only the LIVE day's claims have to track
    // the ledger. Replacing the text would destroy a report the reader may
    // legitimately scroll back to, so the sweep simply stops tracking it.
    if (pointer.date !== td) {
      dropMessagePointer(profileId, pointer.id);
      result.dropped++;
      return;
    }
    await reconcileProse(profileId, pointer, PROSE[prose], result);
    return;
  }

  const tokens = keyboardTokens(pointer.keyboard);
  const inert = inertTokens(tokens, tokenPrefix);
  const family = owningFamily(tokens, tokenPrefix);
  const reconciler = family ? FAMILIES[family] : null;

  // An UNKNOWN or claim-less keyboard is left exactly as it is: failing safe means
  // never closing a message nobody has reasoned about.
  const dead = reconciler
    ? reconciler.dead(profileId, tokens, pointer)
    : new Set<string>();

  // HOW LATE this message may still be acted on is the FAMILY's answer, read off the
  // guard its own tap handler consults (#2018) — never a comparison re-derived here.
  // `pointer.date` is the send-time subject-local day, which is the date every dated
  // token on the keyboard carries, so it is the same (tokenDate, today) pair the
  // handler would evaluate on a tap.
  const decision = decideReconcile({
    keyboard: pointer.keyboard,
    dead,
    inert,
    expired: messageExpiry(family, pointer.date, td),
  });

  // WHAT this pass intends to do, decided BEFORE anything touches the network — so
  // the claim below can be made against the same plan the edit will perform.
  const plan = planEdit(profileId, pointer, tokens, reconciler, decision);
  if (!plan) return;

  // CLAIM FIRST, EDIT SECOND (#1788). Two overlapping ticks read the same pre-edit
  // keyboard and would otherwise both call the Bot API for an identical result: the
  // end state converges, but the rate-limit budget this sweep's zero-call steady
  // state exists to protect is spent twice. The compare-and-swap on the pointer's
  // stored blob lets exactly one pass through; the loser skips without a call.
  const claimed =
    plan.kind === "close"
      ? claimMessagePointerClose(profileId, pointer.id, pointer.version)
      : claimMessagePointerKeyboard(
          profileId,
          pointer.id,
          pointer.version,
          plan.keyboard
        );
  if (!claimed) {
    result.skipped++;
    return;
  }

  try {
    if (plan.kind === "close") {
      await closeMessage(pointer.chatId, pointer.messageId, plan.text);
      // The claim already removed the row — closing IS forgetting the pointer.
      result.closed++;
    } else if (plan.kind === "rebuild") {
      await rebuildMessage(
        profileId,
        pointer.chatId,
        pointer.messageId,
        plan.message
      );
      result.edited++;
    } else {
      await updateMessageKeyboard(
        pointer.chatId,
        pointer.messageId,
        plan.keyboard
      );
      result.edited++;
    }
  } catch (e) {
    // WHAT THE FAILURE MEANS IS CLASSIFIED, NEVER ASSUMED (#1885). The transport
    // throws one typed error for every Bot API failure alike, so "the edit threw" on
    // its own says nothing about whether the message still exists. Only the permanent
    // cases may forget the pointer; a transient one has to leave a retry possible.
    if (classifyTelegramFailure(e) === "transient") {
      // Rate limit, 5xx, network reach failure, timeout, unconfigured token: the
      // message is still sitting in the chat showing its pre-edit keyboard. The claim
      // already mutated (or deleted) the row before the call, so KEEPING the pointer
      // means putting it back — otherwise the next tick would read a row that claims
      // an edit which never happened, and the stale keyboard would stand forever.
      // Retries stay bounded by the pointer's own retention horizon (the pruner at the
      // top of this sweep), so this can never become a retry-forever loop.
      //
      // Delivery HEALTH is untouched here, deliberately: reconcile never dispatches,
      // so it has no channel result to fold, and the set/clear/freeze decision in
      // ./delivery-status stays the only thing that moves that marker. A failed edit
      // must neither raise a delivery alarm nor clear one a real send has raised.
      const kept =
        plan.kind === "close"
          ? restoreMessagePointer(pointer)
          : releaseMessagePointerKeyboard(
              profileId,
              pointer.id,
              plan.keyboard,
              pointer.version
            );
      log.info("message reconcile deferred (transient, pointer kept)", {
        profile: profileId,
        chat: pointer.chatId,
        kept,
        err: e instanceof Error ? e.message : String(e),
      });
      result.deferred++;
      return;
    }
    // A dead pointer: Telegram refuses edits on a deleted message, a chat the bot
    // was removed from, or a message past its edit horizon. Nothing is recoverable,
    // so forget it rather than retry forever. (A no-op for a close, whose claim
    // already deleted the row.)
    log.info("message reconcile failed (pointer dropped)", {
      profile: profileId,
      chat: pointer.chatId,
      err: e instanceof Error ? e.message : String(e),
    });
    dropMessagePointer(profileId, pointer.id);
    result.dropped++;
  }
}

// One prose-claim pointer. Folds its own outcome into `result`, mirroring the keyboard
// arm's claim-first / classify-the-failure posture exactly so the two paths cannot drift
// about what a failed edit means.
async function reconcileProse(
  profileId: number,
  pointer: MessagePointer,
  claim: ProseClaim,
  result: ReconcileResult
): Promise<void> {
  // FIRST PRE-CHECK, AND THE FREE ONE (#2069). A pointer with no recorded hash
  // (pre-migration-153) has nothing for the comparison below to match, so it is left
  // exactly as delivered rather than edited on a guess — which means a rebuild for it
  // could never produce an edit, and paying for one is pure waste.
  if (pointer.bodyHash == null) return;

  // SECOND PRE-CHECK: IS THE REBUILD WORTH PAYING FOR? (#2069)
  //
  // This pointer stays live until rollover, so without this the sweep ran the full
  // `gatherDigestInput` — the tick's heaviest per-profile read — on every remaining tick
  // of the day, ~15 times out of 16 only to hash the result and find it identical. The
  // cheap stamp says whether any ledger this kind's claims are derived from has been
  // written since the last real rebuild; the floor makes sure the stamp can only ever
  // make a rebuild sooner, never cancel one. See ./digest-deps for that division.
  const stamp = claim.stamp ? claim.stamp(profileId) : null;
  const gate = decideProseGather({
    date: pointer.date,
    stamp,
    last: parseProseGatherRecord(getProfileSetting(profileId, claim.gatherKey)),
    nowMs: clockNow().getTime(),
    floorMs: claim.floorMs,
  });
  if (!gate.gather) return;

  const rebuilt = claim.rebuild(profileId, pointer);
  // Recorded only once the rebuild has actually SUCCEEDED, and against the stamp read
  // BEFORE it: a write that lands mid-rebuild is either already in this render or still
  // ahead of the recorded stamp, so it can never be skipped as "already seen". A rebuild
  // that throws records nothing and is retried next tick (#2070).
  if (stamp != null)
    setProfileSetting(
      profileId,
      claim.gatherKey,
      formatProseGatherRecord({
        date: pointer.date,
        stamp,
        at: clockNow().getTime(),
      })
    );
  if (!rebuilt) return;
  const hash = messageBodyHash(rebuilt);
  // THE IDEMPOTENCE PIN. Nothing changed ⇒ no Telegram call at all, which is what keeps
  // an hourly sweep over the most-read message in the app off the rate limiter.
  if (pointer.bodyHash === hash) return;

  // CLAIM FIRST (#1788), on the hash rather than the keyboard: a digest's keyboard is
  // unchanged (often empty) across a prose edit, so it cannot tell two overlapping ticks
  // apart, while the hash moves on every real edit.
  if (!claimMessagePointerBody(profileId, pointer.id, pointer.bodyHash, hash)) {
    result.skipped++;
    return;
  }
  try {
    await rebuildMessage(profileId, pointer.chatId, pointer.messageId, rebuilt);
    result.edited++;
  } catch (e) {
    if (classifyTelegramFailure(e) === "transient") {
      // The chat still shows the pre-edit text, so put the witness back and let the next
      // tick recompute the same plan. Bounded by the pointer's own retention horizon.
      const kept = releaseMessagePointerBody(
        profileId,
        pointer.id,
        hash,
        pointer.bodyHash
      );
      log.info("prose reconcile deferred (transient, pointer kept)", {
        profile: profileId,
        chat: pointer.chatId,
        kept,
        err: e instanceof Error ? e.message : String(e),
      });
      result.deferred++;
      return;
    }
    log.info("prose reconcile failed (pointer dropped)", {
      profile: profileId,
      chat: pointer.chatId,
      err: e instanceof Error ? e.message : String(e),
    });
    dropMessagePointer(profileId, pointer.id);
    result.dropped++;
  }
}

// WHAT an edit will be, resolved with no network and no writes. Null means this
// pointer needs nothing this pass.
//
// It exists as its own step because of #1788: the claim has to know the exact keyboard
// it is swapping IN before the edit is issued, so deciding and performing can no longer
// be the same statement.
type EditPlan =
  | { kind: "close"; text: string }
  | { kind: "keyboard"; keyboard: InlineKeyboard }
  | { kind: "rebuild"; message: NotificationMessage; keyboard: InlineKeyboard };

function planEdit(
  profileId: number,
  pointer: MessagePointer,
  tokens: readonly string[],
  reconciler: FamilyReconciler | null,
  decision: ReconcileDecision
): EditPlan | null {
  if (decision.action === "close") {
    // The close NAMES ITS SUBJECT (#1822 item 7): the pointer recorded the delivered
    // title line at send time, attribution prefix included, so replacing the whole text
    // no longer leaves an orphan bubble in a shared chat. A pointer without one (recorded
    // before migration 139) degrades to the bare closing line.
    return {
      kind: "close",
      text: reconcileClosingText(decision.reason, pointer.title),
    };
  }
  if (decision.action === "strip-all") {
    return { kind: "keyboard", keyboard: decision.keyboard };
  }
  if (decision.action === "none") {
    // The additive class still re-renders: its buttons never die, but their labels
    // carry counts that do. Gated on the render actually DIFFERING from what was
    // delivered, so a quiet tick stays at zero calls.
    if (!reconciler?.rebuild) return null;
    const rebuilt = reconciler.rebuild(profileId, tokens, pointer);
    if (!rebuilt) return null;
    const keyboard = messageKeyboard(rebuilt);
    if (JSON.stringify(keyboard) === JSON.stringify(pointer.keyboard))
      return null;
    return { kind: "rebuild", message: rebuilt, keyboard };
  }
  // Partial resolution. A family with a rebuilder re-renders the whole message from
  // current state (the same computation the tap rebuild runs); everything else has
  // exactly the dead buttons removed.
  const rebuilt = reconciler?.rebuild?.(profileId, tokens, pointer) ?? null;
  if (rebuilt) {
    return {
      kind: "rebuild",
      message: rebuilt,
      keyboard: messageKeyboard(rebuilt),
    };
  }
  return { kind: "keyboard", keyboard: decision.keyboard };
}

// Re-exported for the DB tier's assertions and the tick's logging.
export { stripTokens };
