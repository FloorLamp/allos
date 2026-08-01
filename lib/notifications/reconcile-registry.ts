// THE CALLBACK-VOCABULARY REGISTRY (issue #1779 §3) — every button family the app can
// put in a chat, and what happens when it goes stale.
//
// PURE and declarative on purpose. It is the thing the completeness guard
// (lib/__tests__/reconcile-registry.test.ts) scans the notification source against, so
// a new button family cannot ship without answering the question "what happens when
// this message is still sitting in the chat tomorrow?". The two legal answers are:
//
//   • a FAMILY — a reconciler in ./reconcile.ts owns it, and knows how to ask the
//     ledger whether each of its tokens is still actionable;
//   • INERT — with a written reason. A view control ("▲ Collapse", "⚙️ Tune",
//     "➕ Show more") makes no state claim, so it cannot lie and must not, by its mere
//     presence, keep a fully resolved message alive.
//
// There is deliberately no third answer. "Not covered yet" is exactly the state that
// produced the defect.

// The reconciler families. Each is one small read-only predicate over the SAME ledger
// the tap handler writes to — never a second dueness model (#221).
export type ReconcileFamily =
  | "intake-dose"
  | "escalation"
  | "household-round"
  | "food"
  | "food-optin"
  | "preventive"
  | "refill"
  | "symptom"
  | "mood"
  | "workout-draft"
  | "practice";

export interface ReconcilePrefixEntry {
  // The callback token prefix, without its colon.
  prefix: string;
  // The reconciler that owns messages led by this token.
  family?: ReconcileFamily;
  // …or the written reason this button makes no state claim.
  inert?: string;
}

export const RECONCILE_PREFIXES: readonly ReconcilePrefixEntry[] = [
  // ── Class 1: state-claim buttons ───────────────────────────────────────────
  // The message asserts something is outstanding and an in-app write can resolve it.

  // Dose reminders (#232/#1154). The sharpest case in the issue: a dose taken in the
  // app leaves a live "✅ Taken" six hours later, and that is the prompt that invites a
  // double dose.
  { prefix: "take", family: "intake-dose" },
  { prefix: "skip", family: "intake-dose" },
  { prefix: "all", family: "intake-dose" },
  // ⤓ May rides the dose reminder (#1505 part 2) and dies with the same message —
  // and separately once the item is already `may`, when the suggestion is moot.
  { prefix: "demote", family: "intake-dose" },

  // Missed-dose escalation (#233 phase 2) — safety tier. A confirmed-taken dose must
  // not keep a caregiver's chat claiming it was missed.
  { prefix: "esctake", family: "escalation" },
  { prefix: "escskip", family: "escalation" },
  { prefix: "escack", family: "escalation" },

  // The household round (#1459): one message, one button per member. Members resolve
  // independently, so this is the canonical PARTIAL case.
  { prefix: "hh", family: "household-round" },

  // Preventive nudges (#233 phase 1): done / not-applicable / remind-later, all three
  // resolvable from the app.
  { prefix: "pvdone", family: "preventive" },
  { prefix: "pvna", family: "preventive" },
  { prefix: "pvlater", family: "preventive" },

  // Refill nudge (#233 phase 3): logging the refill in the app ends the shortage.
  { prefix: "rfsnooze", family: "refill" },

  // Symptom follow-up (#859): the day's symptom logged in the app answers the ask.
  { prefix: "symp", family: "symptom" },
  { prefix: "symsev", family: "symptom" },

  // Daily check-in (#992) and its confirm-to-KEEP affordance (#1668).
  { prefix: "mood", family: "mood" },
  { prefix: "moodkeep", family: "mood" },

  // Stale-workout nudge (#1205): the draft finished or discarded in the app.
  { prefix: "wofinish", family: "workout-draft" },
  { prefix: "wodiscard", family: "workout-draft" },

  // Practice pace nudge (#1259): a session logged in the app clears the shortfall.
  { prefix: "pdone", family: "practice" },
  // ⤓ Right-size rides that same nudge (#1670) and dies with the same message — and
  // separately once the floor has been lowered in the app, when the offer is moot.
  // The `demote`-on-a-dose-reminder shape one domain over: a ride-along inherits the
  // family of the message it decorates rather than earning one of its own.
  { prefix: "rslower", family: "practice" },

  // ── Class 2: additive quick-log buttons ────────────────────────────────────
  // The buttons don't lie — logging another serving stays valid all day — but the
  // COUNTS they carry go stale. Reconciled by re-rendering from the same builder and
  // editing only when the render actually differs.
  { prefix: "food", family: "food" },
  { prefix: "foodprotein", family: "food" },

  // ── Class 3: decision buttons ──────────────────────────────────────────────
  // A choice made in the app leaves the message offering a choice that no longer exists.
  { prefix: "foodoptin", family: "food-optin" },

  // ── Inert: view controls, not state claims ─────────────────────────────────
  {
    prefix: "foodmore",
    inert:
      "reveals the next page of the SAME nudge's ranked buttons — a stateless view change that logs nothing and claims nothing",
  },
  {
    prefix: "offer",
    inert:
      "expands the digest's guaranteed-access tail (#1505); the expansion re-resolves the slot AT TAP, so the collapsed button cannot be stale",
  },
  {
    prefix: "offerc",
    inert: "collapses the offer tail back — pure keyboard view state",
  },
  {
    prefix: "prn",
    inert:
      "an additive access affordance (#797/#1505): logging an as-needed dose is valid at any time, and the token carries no date, so it never becomes a false claim",
  },
  {
    prefix: "tune",
    inert:
      "opens the digest's per-category preferences (#1714) — a preference control, never a claim about the day",
  },
  {
    prefix: "tunec",
    inert: "closes the ⚙️ Tune panel — pure keyboard view state",
  },
  {
    prefix: "tunet",
    inert:
      "flips one digest category's demotion (#1714); a preference is whatever it currently is and cannot go stale",
  },
];

const BY_PREFIX = new Map(RECONCILE_PREFIXES.map((e) => [e.prefix, e]));

export function reconcileEntryFor(
  prefix: string | null
): ReconcilePrefixEntry | undefined {
  return prefix == null ? undefined : BY_PREFIX.get(prefix);
}

// The family that OWNS a message, given its keyboard's tokens in keyboard order: the
// first token that makes a state claim. Builders put the primary action rows first and
// ride-along rows (the offer tail, ⚙️ Tune) last, so "first" is the message's subject.
//
// Null when nothing on the keyboard claims state — a `/dose` list, a fully collapsed
// digest — in which case there is nothing to reconcile and the sweep makes no call.
export function owningFamily(
  tokens: readonly string[],
  prefixOf: (token: string) => string | null
): ReconcileFamily | null {
  for (const t of tokens) {
    const entry = reconcileEntryFor(prefixOf(t));
    if (entry?.family) return entry.family;
  }
  return null;
}

// Which of a keyboard's tokens are INERT — passed to the pure decision so they neither
// die nor keep a resolved message alive. An UNKNOWN prefix is deliberately NOT inert:
// it is treated as a live claim, so a family that slips past the registry fails safe
// (its message is left alone rather than silently closed). The completeness guard is
// what makes "unknown" a build failure rather than a runtime surprise.
export function inertTokens(
  tokens: readonly string[],
  prefixOf: (token: string) => string | null
): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (reconcileEntryFor(prefixOf(t))?.inert) out.add(t);
  }
  return out;
}
