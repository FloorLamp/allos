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
  getIntakeItemNames,
  getIntakeItems,
  getIntakeDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getFrequencyTargetProgress,
  redoseWindowState,
} from "../queries";
import { getProfileNameById } from "../profile-summary-load";
import { moodLabel } from "../mood";
import { severityLabelFor, symptomLabel } from "../symptoms";
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
  getProfileAge,
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
import { digestDependencyStamp, DIGEST_REGATHER_FLOOR_MS } from "./digest-deps";
import {
  closingTallyDetail,
  decideProseGather,
  decideReconcile,
  formatProseGatherRecord,
  keyboardTokens,
  messageBodyHash,
  parseProseGatherRecord,
  type CloseDetail,
  type CloseGroup,
  type ClosingTally,
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
  correctionMessageBinding,
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

// ── WHAT A RESOLVED CLOSE SAYS IS PART OF THE TYPE (issue #2275) ─────────────
//
// #1779 specified the reconcile substrate exhaustively and specified what a CLOSED
// message would say in seven words ("fully resolved → closeMessage with an honest
// closing line"). That deferral was never recorded, so a placeholder-quality line read
// as a decision, and the gap had to be rediscovered three times — #1834 added the
// subject, #2224 added counts, #2274 added names — each time for one family pair. Nine
// of eleven families still closed to "handled in the app." WHILE HOLDING THE OUTCOME:
// `mood`'s own resolution predicate reads the recorded mood and keeps only the null
// check; `workoutDraft` knows whether the session was finished or DISCARDED, two
// opposite outcomes rendering identically.
//
// The cause is mechanical: `tally?()` was OPTIONAL, and "this family declares none" was
// done by OMISSION — indistinguishable from oversight. So the declaration is now a
// discriminated union that every reconciler must satisfy, and it lives ON the reconciler
// rather than in a second registry table, where it cannot drift from the implementation
// it constrains.
//
// WHAT THE COMPILER GUARANTEES, WITH NO TEST OF ANY KIND:
//
//   • every family answers — `FAMILIES: Record<ReconcileFamily, FamilyReconciler>`
//     already makes a new family a build error until it is declared;
//   • a family cannot CLAIM detail without producing it — `detail()` is required on the
//     `outcome-detail` variant;
//   • a family cannot DECLINE detail without a reason — `why` is required on both other
//     variants, so "we decided against it" and "nobody looked" stay distinguishable by
//     construction rather than by review;
//   • a family cannot HALF-declare — the `never` members below make the variants
//     mutually exclusive, so a `subject-only` carrying a `detail()` is rejected.
//
// NO SCAN. Scans are for what types cannot see (source text, SQL — the `notify_` key
// registry, the stateful-writes scan, the instant-writer scan). A closed vocabulary with
// a per-member obligation is the other case, and the house precedent is
// `RECAP_COMPARISON_KINDS`: a new key is a type error until its author declares one.
export type CloseContent =
  | {
      closeStates: "outcome-detail";
      why?: never;
      // The outcome the close states — REQUIRED by this variant, which is the member
      // nine families silently lacked. Consulted ONLY when every claim died (a
      // `resolved` close) and answered from the SAME ledger read `dead` just asked, so
      // it is the decision's own inputs restated rather than a second computation
      // (#221). Null when this particular resolution genuinely has nothing to state,
      // which then reads as the plain closing sentence.
      detail(
        profileId: number,
        tokens: readonly string[],
        p: MessagePointer
      ): CloseDetail | null;
    }
  // The subject line and nothing more. No family claims it today; the reason is
  // required so that if one ever does, it is a decision on the record.
  | { closeStates: "subject-only"; why: string; detail?: never }
  // This family has no `resolved` close at all.
  | { closeStates: "not-applicable"; why: string; detail?: never };

export type FamilyReconciler = {
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
} & CloseContent;

// A close that names its items only when the message claimed SEVERAL of them.
//
// The refill nudge titles itself with the item's own name when exactly one is low
// ("💊 Vitamin D"), and the preventive nudge is one message per rule by construction, so
// repeating that name in the close would print it twice on one line — the #1722 "name
// twice" defect, one surface over. With several, the names are the whole point. `total`
// is the count across ALL of the family's groups, not this one's: "done · not
// applicable" with no names would be unreadable.
function namedIfSeveral(
  names: readonly string[],
  outcome: string,
  total: number
): CloseGroup {
  // Present-and-empty, so the formatter omits the group entirely — a bare `{ outcome }`
  // here would print "done" for a family where nothing was done.
  if (names.length === 0) return { names, outcome };
  return total > 1 ? { names, outcome } : { outcome };
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

// The dose message's OUTCOME (#2170, named by #2274) — the same two ledger reads
// `resolvedDoseIds` splits a resolution out of, kept apart instead of unioned. Reached
// only on a `resolved` close, so every dose named here is one this pass just proved
// resolved.
//
// The doses are the ones the KEYBOARD claimed, taken from its own take/skip tokens and
// deduplicated: a dose carries one confirm button and one skip button, and it is one
// dose either way. Tokens with no dose id (`all`, `demote`, the time-correction chips)
// carry no per-dose outcome and are ignored — the doses they cover are already named by
// the take/skip pair beside them.
//
// NAMES, in the order the keyboard showed them (#2274). The token carries the item id
// (`take:<profileId>:<doseId>:<suppId>:<date>`), so the lookup is one profile-scoped
// read of that profile's item names — never a name from another profile's ledger, even
// in a shared chat. An item whose name cannot be resolved is named as neither, the same
// posture as a dose in neither ledger set.
function doseClosingTally(
  profileId: number,
  tokens: readonly string[],
  prefixes: readonly string[]
): ClosingTally | null {
  const byDate = new Map<
    string,
    { taken: Set<number>; skipped: Set<number> }
  >();
  const seen = new Set<string>();
  const taken: string[] = [];
  const skipped: string[] = [];
  let names: Map<number, string> | null = null;
  for (const t of tokens) {
    const f = fields(t);
    if (!prefixes.includes(f[0])) continue;
    const doseId = Number(f[2]);
    const itemId = Number(f[3]);
    const date = f[4];
    if (!doseId || !date) continue;
    const key = `${date}:${doseId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let ledger = byDate.get(date);
    if (!ledger) {
      ledger = {
        taken: new Set(getTakenDoseIds(profileId, date)),
        skipped: new Set(getSkippedDoseIds(profileId, date)),
      };
      byDate.set(date, ledger);
    }
    // Each dose is stated as what the ledger SAYS it is. A dose in neither set is
    // unreachable on a resolved close (that is what "every claim died" means) and is
    // named as neither rather than inferred into one — a close that guesses is worse
    // than the sentence it replaces.
    const isTaken = ledger.taken.has(doseId);
    if (!isTaken && !ledger.skipped.has(doseId)) continue;
    names ??= getIntakeItemNames(profileId);
    const name = itemId ? names.get(itemId) : undefined;
    if (!name) continue;
    (isTaken ? taken : skipped).push(name);
  }
  return taken.length + skipped.length > 0 ? { taken, skipped } : null;
}

// Both dose families' `detail()`, unchanged between them.
function doseCloseDetail(
  profileId: number,
  tokens: readonly string[],
  prefixes: readonly string[]
): CloseDetail | null {
  const tally = doseClosingTally(profileId, tokens, prefixes);
  return tally ? closingTallyDetail(tally) : null;
}

// ── intake-dose ──────────────────────────────────────────────────────────────
// take/skip: `take:<profileId>:<doseId>:<suppId>:<date>`
// all:       `all:<profileId>:<slot>:<date>`
// demote:    `demote:<profileId>:<itemId>:<date>`
const intakeDose: FamilyReconciler = {
  dead(profileId, tokens, p) {
    // The fresh-and-bound anchors for THIS message (#2264): a correction token whose
    // burst has aged out — or belongs to another message — is dead here.
    const dead = deadCorrectionTokens(
      tokens,
      DOSE_TIME_PREFIXES,
      new Set(
        getDoseCorrectionBursts(
          profileId,
          clockNow(),
          correctionMessageBinding(profileId, "dose", {
            chatId: p.chatId,
            messageId: p.messageId,
          })
        ).map((b) => b.fromId)
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
  // "Vitamin D, Magnesium taken · Omega-3 skipped" (#2170/#2274) — the resolution facts
  // this family just established, restated in the words the buttons used.
  closeStates: "outcome-detail",
  detail(profileId, _tokens, p) {
    // The live keyboard may now contain only correction-time controls. The immutable
    // delivered keyboard retains every dose this reminder claimed, so the final receipt
    // can still name what was taken or skipped after those controls expire.
    return doseCloseDetail(profileId, keyboardTokens(p.receiptKeyboard), [
      "take",
      "skip",
    ]);
  },
  // Rebuild through the identical computation the TAP rebuild uses
  // (slotSessionForKeyboard → renderMergedIntakeMessage), so a partially reconciled
  // reminder is byte-identical to what tapping the same doses would have produced.
  rebuild(profileId, tokens, p) {
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
      renderMergedIntakeMessage(
        profileId,
        parts,
        date,
        getProfileAge(profileId)
      ),
      {
        now: clockNow(),
        pickerAnchor: openPickerAnchor(tokens, DOSE_TIME_PREFIXES),
        ref: { chatId: p.chatId, messageId: p.messageId },
      }
    );
  },
};

// ── redose-window ───────────────────────────────────────────────────────────
// `redose:<profileId>:<itemId>:<armingAdministrationId>:<nonce>`
// One notice, one administration-armed window. A newer family administration spends
// it whether that dose was logged from this button, another chat, or the app.
const redoseWindow: FamilyReconciler = {
  dead(profileId, tokens) {
    const dead = new Set<string>();
    for (const t of tokens) {
      const f = fields(t);
      if (f[0] !== "redose") continue;
      const itemId = Number(f[2]);
      const administrationId = Number(f[3]);
      if (
        !itemId ||
        !administrationId ||
        redoseWindowState(profileId, itemId, administrationId) !== "current"
      ) {
        dead.add(t);
      }
    }
    return dead;
  },
  closeStates: "outcome-detail",
  detail(profileId, tokens) {
    for (const t of tokens) {
      const f = fields(t);
      if (f[0] !== "redose") continue;
      const itemId = Number(f[2]);
      const administrationId = Number(f[3]);
      if (!itemId || !administrationId) continue;
      const state = redoseWindowState(profileId, itemId, administrationId);
      if (state === "superseded") {
        return { groups: [{ outcome: "dose logged" }] };
      }
      if (state === "cancelled") {
        return { groups: [{ outcome: "opening dose no longer logged" }] };
      }
      if (state === "unavailable") {
        return { groups: [{ outcome: "medication no longer available" }] };
      }
    }
    return null;
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
  // The same close, one message class over (#2170/#2274): an escalation resolves on
  // exactly the dose ledger the reminder does, and a caregiver's chat is the last place
  // a bare "handled in the app" belongs. `escack` carries no dose outcome, so it is not
  // a naming prefix — the take/skip pair beside it names the same dose.
  closeStates: "outcome-detail",
  detail(profileId, tokens) {
    return doseCloseDetail(profileId, tokens, ["esctake", "escskip"]);
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
  // PER MEMBER (#2275), because the round's whole subject is who owes what: one
  // member's doses confirmed and another's skipped is exactly the fact a bare "handled
  // in the app" destroyed. The member's name LEADS its group, which is the same
  // attribution the round's own body sections ("Ada:") and button labels
  // ("✅ Ada · Vitamin D") already carry (#377) — so the close discloses nothing this
  // chat was not already shown.
  //
  // Every read is scoped to the MEMBER whose ledger the button confirms against, never
  // the receiving profile's — the same rule `dead` above obeys.
  closeStates: "outcome-detail",
  detail(_profileId, tokens) {
    const order: number[] = [];
    const byMember = new Map<number, { taken: string[]; skipped: string[] }>();
    const ledgers = new Map<
      string,
      { taken: Set<number>; skipped: Set<number> }
    >();
    const names = new Map<number, Map<number, string>>();
    const seen = new Set<string>();
    for (const t of tokens) {
      const f = fields(t);
      if (f[0] !== "hh") continue;
      const memberId = Number(f[2]);
      const doseId = Number(f[3]);
      const itemId = Number(f[4]);
      const date = f[5];
      if (!memberId || !doseId || !itemId || !date) continue;
      const key = `${memberId}:${date}:${doseId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let ledger = ledgers.get(`${memberId}:${date}`);
      if (!ledger) {
        ledger = {
          taken: new Set(getTakenDoseIds(memberId, date)),
          skipped: new Set(getSkippedDoseIds(memberId, date)),
        };
        ledgers.set(`${memberId}:${date}`, ledger);
      }
      const isTaken = ledger.taken.has(doseId);
      if (!isTaken && !ledger.skipped.has(doseId)) continue;
      let memberNames = names.get(memberId);
      if (!memberNames) {
        memberNames = getIntakeItemNames(memberId);
        names.set(memberId, memberNames);
      }
      const name = memberNames.get(itemId);
      if (!name) continue;
      let bucket = byMember.get(memberId);
      if (!bucket) {
        bucket = { taken: [], skipped: [] };
        byMember.set(memberId, bucket);
        order.push(memberId);
      }
      (isTaken ? bucket.taken : bucket.skipped).push(name);
    }
    const groups: CloseGroup[] = [];
    for (const memberId of order) {
      const bucket = byMember.get(memberId);
      if (!bucket) continue;
      const lead = getProfileNameById(memberId) ?? undefined;
      groups.push(
        { ...(lead ? { lead } : {}), names: bucket.taken, outcome: "taken" },
        { ...(lead ? { lead } : {}), names: bucket.skipped, outcome: "skipped" }
      );
    }
    return groups.length > 0 ? { groups } : null;
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
  // correction chips riding beside them do, on their own hour-long clock (#2019) and
  // now on their own message (#2264): a chip for a burst another message produced is
  // dead here whatever its age.
  dead(profileId, tokens, p) {
    return deadCorrectionTokens(
      tokens,
      FOOD_TIME_PREFIXES,
      new Set(
        getFoodCorrectionBursts(
          profileId,
          clockNow(),
          correctionMessageBinding(profileId, "food", {
            chatId: p.chatId,
            messageId: p.messageId,
          })
        ).map((b) => b.fromId)
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
      const ref = { chatId: p.chatId, messageId: p.messageId };
      // An OPEN eating-time picker is the user's current view, exactly as the expansion
      // is (#1807), so the rebuild preserves it rather than editing the question away
      // while it is being answered. It survives only while its burst is still fresh
      // AND still bound to this message (#2264) — once it is not, the anchor is gone
      // from the offer set and the plain nudge comes back, which is how an ABANDONED
      // picker gets closed by the ordinary sweep.
      const anchor = openPickerAnchor(tokens, FOOD_TIME_PREFIXES);
      const picker =
        anchor != null
          ? getFoodCorrectionBursts(
              profileId,
              now,
              correctionMessageBinding(profileId, "food", ref)
            ).find((b) => b.fromId === anchor)
          : undefined;
      return buildFoodNudge(profileId, window, date, visibleCount, {
        now,
        ref,
        ...(picker ? { picker } : {}),
      });
    }
    return null;
  },
  // The ONE family with no `resolved` close to govern (#2275). Its keyboard never lies
  // and never resolves — another serving is always loggable — so `dead` kills only the
  // hour-long correction chips riding beside it, and the message closes on ROLLOVER
  // alone (`exact-day`), whose tail is a date fact rather than an outcome. The day's
  // final tally deliberately does NOT go on that line: a rolled-over additive nudge is
  // not a receipt for anything, its counts were live in the message until midnight, and
  // the day's totals are what the app and the digest are for.
  closeStates: "not-applicable",
  why: "additive: the quick-log buttons never resolve, so this family never produces a `resolved` close — only the rollover tail, which states a date and not an outcome",
};

// ── food-optin (class 3: decision) ───────────────────────────────────────────
// `foodoptin:<profileId>:<yes|no>` — the first-connection prompt. Once food logging is
// on, the choice it offers no longer exists.
const foodOptIn: FamilyReconciler = {
  dead(profileId, tokens) {
    if (!getProfileFoodTelegram(profileId)) return new Set<string>();
    return new Set(tokens.filter((t) => fields(t)[0] === "foodoptin"));
  },
  // WHICH WAY THE SETTING WENT (#2275) — read from the setting itself, not from which
  // button happens to be on the keyboard, so an opt-in performed in Settings closes with
  // the same sentence a tap would have. Only one direction can reach a resolved close:
  // `dead` fires exactly when food logging is ON, and a "Not now" tap leaves the choice
  // genuinely still available. Re-read here rather than assumed, because a close must
  // never state an outcome its ledger no longer holds.
  closeStates: "outcome-detail",
  detail(profileId) {
    return getProfileFoodTelegram(profileId)
      ? { groups: [{ outcome: "food logging turned on" }] }
      : null;
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
  // WHICH ACTION RESOLVED, AND HOW (#2275) — the two outcomes the nudge's own buttons
  // offer: ✅ Done → recordPreventiveDone, 🚫 Not applicable → setPreventiveOverride.
  // Read off the SAME assessment `dead` just consulted, so it is that verdict restated.
  //
  // "Deferred" is deliberately not one of them: ⏰ Remind later is a findings-bus snooze,
  // and the reconciler never reads the suppression bus (a dismissal must never close a
  // message), so a deferred rule stays actionable and never reaches a resolved close at
  // all. A rule that simply aged out of the catalog has no assessment left to name and
  // is stated as neither, the dose families' posture.
  closeStates: "outcome-detail",
  detail(profileId, tokens) {
    const summary = assessProfilePreventive(profileId, today(profileId));
    const byKey = new Map(summary.assessments.map((a) => [a.key, a]));
    const done: string[] = [];
    const na: string[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      const f = fields(t);
      if (!f[0].startsWith("pv")) continue;
      const key = f.slice(2).join(":");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const a = byKey.get(key);
      if (!a) continue;
      if (a.status === "up_to_date") done.push(a.name);
      else if (a.status === "not_recommended") na.push(a.name);
    }
    const total = done.length + na.length;
    if (total === 0) return null;
    return {
      groups: [
        namedIfSeveral(done, "done", total),
        namedIfSeveral(na, "not applicable", total),
      ],
    };
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
    const { low } = refillSupplyState(profileId);
    return new Set(wanted.filter((t) => !low.has(Number(fields(t)[2]))));
  },
  // WHICH ITEM IS NO LONGER LOW (#2275), from the SAME daysOfSupplyLeft/isLowSupply pair
  // `dead` just evaluated. The nudge is multi-item by design ("3 items running low"),
  // and which of the three was restocked is exactly what the bare sentence destroyed.
  //
  // "no longer low" rather than "restocked": the ledger says the shortage is over, not
  // how it ended — a deactivated item or a cleared count reaches the same state, and a
  // close must not name a write nobody made.
  closeStates: "outcome-detail",
  detail(profileId, tokens) {
    const { low, names } = refillSupplyState(profileId);
    const resolved: string[] = [];
    const seen = new Set<number>();
    for (const t of tokens) {
      const f = fields(t);
      if (f[0] !== "rfsnooze") continue;
      const itemId = Number(f[2]);
      if (!itemId || seen.has(itemId) || low.has(itemId)) continue;
      seen.add(itemId);
      const name = names.get(itemId);
      if (name) resolved.push(name);
    }
    return resolved.length > 0
      ? {
          groups: [namedIfSeveral(resolved, "no longer low", resolved.length)],
        }
      : null;
  },
};

// The shortage verdict for one profile, plus the names to state it with — one pass over
// the same read both arms of `refill` need, so the close cannot disagree with the
// predicate that produced it.
function refillSupplyState(profileId: number): {
  low: Set<number>;
  names: Map<number, string>;
} {
  const rates = getRefillRates(profileId);
  const low = new Set<number>();
  const names = new Map<number, string>();
  for (const s of getIntakeItems(profileId)) {
    names.set(s.id, s.name);
    if (!s.active || s.quantity_on_hand == null) continue;
    const daysLeft = daysOfSupplyLeft(
      s.quantity_on_hand,
      s.qty_per_dose,
      rates.get(s.id)?.dosesPerDay ?? 0
    );
    if (isLowSupply(daysLeft, DEFAULT_LOW_SUPPLY_DAYS)) low.add(s.id);
  }
  return { low, names };
}

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
        const slug = symptomTokenSlug(f);
        return (
          slug != null && logged.has(slug.replace(/_/g, " ").toLowerCase())
        );
      })
    );
  },
  // THE SYMPTOM AND THE SEVERITY RECORDED (#2275). Parity, not disclosure: the picker
  // named the symptom when it asked, and the severity is the answer it asked FOR — the
  // one fact the bare sentence threw away. Grouped by severity in the order the keyboard
  // listed the symptoms, through `severityLabelFor`, which is the ONE label resolution a
  // stored 1–4 goes through (a scaled symptom must not render as "Moderate" here and as
  // its own scale everywhere else, #1680).
  closeStates: "outcome-detail",
  detail(profileId, tokens, p) {
    const days = getSymptomDaysInRange(profileId, p.date, p.date, 20);
    const severities = new Map<string, number>();
    for (const d of days)
      for (const s of d.symptoms)
        severities.set(
          s.symptom.toLowerCase(),
          Math.max(severities.get(s.symptom.toLowerCase()) ?? 0, s.severity)
        );
    // Insertion order preserves keyboard order across the severity buckets.
    const byOutcome = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const t of tokens) {
      const slug = symptomTokenSlug(fields(t));
      if (!slug || seen.has(slug)) continue;
      const severity = severities.get(slug.replace(/_/g, " ").toLowerCase());
      if (severity == null) continue;
      seen.add(slug);
      const outcome = `logged, ${severityLabelFor(slug, severity).toLowerCase()}`;
      const bucket = byOutcome.get(outcome);
      if (bucket) bucket.push(symptomLabel(slug));
      else byOutcome.set(outcome, [symptomLabel(slug)]);
    }
    if (byOutcome.size === 0) return null;
    return {
      groups: [...byOutcome].map(([outcome, names]) => ({ names, outcome })),
    };
  },
};

// The symptom slug a `symp:`/`symsev:` token names, or null for neither.
function symptomTokenSlug(f: readonly string[]): string | undefined {
  return f[0] === "symp" ? f[2] : f[0] === "symsev" ? f[3] : undefined;
}

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
  // THE MOOD THE USER RECORDED (#2275). The resolution predicate above already reads it
  // and keeps only the null check — this is that same read, stated. Through `moodLabel`,
  // the shared 5-point vocabulary the check-in keyboard, the dashboard tap row and the
  // trend tooltip all name a rating with.
  //
  // Restating a person's own answer is not a score and not a comparison, so the #992/#716
  // tone contract is untouched: it forbids JUDGING the value, never repeating it.
  closeStates: "outcome-detail",
  detail(profileId, tokens) {
    const labels: string[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      const f = fields(t);
      const date = f[0] === "mood" ? f[3] : f[0] === "moodkeep" ? f[2] : null;
      if (!date || seen.has(date)) continue;
      seen.add(date);
      const logged = getMoodOnDate(profileId, date);
      if (logged) labels.push(moodLabel(logged.valence));
    }
    return labels.length > 0
      ? { groups: [{ names: labels, outcome: "recorded" }] }
      : null;
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
  // FINISHED OR DISCARDED (#2275) — the single most valuable case this contract exists
  // for, because they are OPPOSITE outcomes that rendered identically. `dead` only asks
  // "is this still the live session?", which both answer the same way; the difference is
  // in the row, and it is the difference between a session that was kept and one that
  // was thrown away.
  //
  // `discardWorkoutSession` DELETES the draft and its sets, `finishWorkoutSession`
  // stamps `end_time` — so the row itself is the record, read profile-scoped. A draft
  // that is still open (no end_time, but old enough that presence no longer covers it)
  // has no outcome to state and gets the plain sentence rather than a guess.
  closeStates: "outcome-detail",
  detail(profileId, tokens) {
    const groups: CloseGroup[] = [];
    const seen = new Set<number>();
    for (const t of tokens) {
      const f = fields(t);
      if (f[0] !== "wofinish" && f[0] !== "wodiscard") continue;
      const activityId = Number(f[2]);
      if (!activityId || seen.has(activityId)) continue;
      seen.add(activityId);
      const row = db
        .prepare(
          "SELECT end_time FROM activities WHERE id = ? AND profile_id = ?"
        )
        .get(activityId, profileId) as { end_time: string | null } | undefined;
      if (!row) groups.push({ outcome: "session discarded" });
      else if (row.end_time) groups.push({ outcome: "session finished" });
    }
    return groups.length > 0 ? { groups } : null;
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
  // WHICH PRACTICE CAUGHT UP (#2275), from the SAME progress read `dead` just made. The
  // nudge carries one `✓ <name>` button per behind practice, so which of them the
  // session landed on is precisely what the bare sentence erased.
  //
  // The two verdicts are the ones the progress row itself states — the week's floor met
  // (or its ceiling reached, the calm "that's plenty" state), versus merely back on pace
  // with the week still running. Never "logged": the shortfall can also end because the
  // window moved, and the close states the STATE, not a write it did not witness.
  closeStates: "outcome-detail",
  detail(profileId, tokens) {
    const byId = new Map(
      getFrequencyTargetProgress(profileId).map((p) => [p.target.id, p])
    );
    const done: string[] = [];
    const onPace: string[] = [];
    const seen = new Set<number>();
    for (const t of tokens) {
      const f = fields(t);
      if (f[0] !== "pdone") continue;
      const targetId = Number(f[2]);
      if (!targetId || seen.has(targetId)) continue;
      seen.add(targetId);
      const p = byId.get(targetId);
      if (!p) continue;
      if (p.met || p.atCeiling) done.push(p.target.scope_value);
      else if (p.pace !== "behind") onPace.push(p.target.scope_value);
    }
    const total = done.length + onPace.length;
    if (total === 0) return null;
    return {
      groups: [
        namedIfSeveral(done, "done for the week", total),
        namedIfSeveral(onPace, "back on pace", total),
      ],
    };
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
  "redose-window": redoseWindow,
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
  // Pre-fix redose notices reused the generic, intentionally inert `prn:` token. Kind
  // disambiguates those already-delivered buttons: they carry no arming id and cannot
  // be made window-safe, so retire them once rather than preserving a double-dose
  // affordance until Telegram's edit horizon passes.
  const legacyRedose =
    pointer.kind === "redose" && tokens.some((t) => tokenPrefix(t) === "prn");
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
  const plan: EditPlan | null = legacyRedose
    ? {
        kind: "close",
        text: reconcileClosingText("resolved", pointer.title, {
          groups: [{ outcome: "old action expired; use /dose to log" }],
        }),
      }
    : planEdit(profileId, pointer, tokens, reconciler, decision);
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
      await closeMessage(
        profileId,
        pointer.chatId,
        pointer.messageId,
        plan.text
      );
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
        profileId,
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
    //
    // AND IT STATES THE OUTCOME (#2170/#2274/#2275). A fully-resolved close erased
    // everything the message knew, leaving the chat history less informative than the
    // reminder was. The detail is asked for ONLY on the `resolved` arm — the date closes
    // below resolve nothing, so an outcome there would be answering a question nobody's
    // ledger was asked — and it is a SNAPSHOT: this claim deletes the pointer, so a later
    // in-app edit makes the line historical rather than wrong, which is what "closing is
    // forgetting" has always meant.
    //
    // ONE formatter over what the family DECLARED, never a per-family rendering: which
    // families can answer at all is settled by `CloseContent` above, at compile time.
    const detail =
      decision.reason === "resolved" &&
      reconciler?.closeStates === "outcome-detail"
        ? reconciler.detail(profileId, tokens, pointer)
        : null;
    return {
      kind: "close",
      text: reconcileClosingText(decision.reason, pointer.title, detail),
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
