// Tick-time message reconciliation — the PURE half (issue #1779).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// Every inline keyboard the app sends is a frozen snapshot. Take a dose, mark it in
// the app, come back to Telegram six hours later: the reminder still sits in the chat
// with live "✅ Taken" buttons, presenting the dose as outstanding. At that distance
// the chat artifact is trusted more than memory, so the message actively invites a
// re-take — the safety tier lying in the outbound direction. The TAP path has been
// honest for a long time (typed outcomes; a stale tap answers "already taken"), but
// that only protects the user who taps. Nothing corrected what a message DISPLAYS.
//
// ── THE RULE, AND WHY IT NEEDS NO SECOND STATE MODEL ─────────────────────────
//
// The honesty rule is universal: A BUTTON WHOSE TAP WOULD NOW BE REFUSED OR ANSWERED
// "ALREADY DONE" BY ITS OWN TYPED OUTCOME MUST NOT REMAIN RENDERED AS ACTIONABLE.
//
// That phrasing is the whole design. The typed-outcome layer already knows the answer
// for every button family; reconciliation renders that same answer PROACTIVELY rather
// than waiting for a tap. So a reconciler is not a second dueness model and not a
// second renderer (#221) — it is one read-only predicate per button family, asking the
// SAME ledger the tap handler asks:
//
//     "is this token still actionable?"
//
// Everything else is mechanical and lives here, once, for every kind:
//
//   • no token died          → NO EDIT AT ALL (idempotent; the common tick costs zero
//                              Telegram calls, which is what keeps this off the rate
//                              limiter);
//   • some tokens died       → strip exactly those buttons;
//   • every claim died       → close the message with an honest closing line;
//   • the profile-local day
//     rolled over            → strip the keyboard regardless of state — yesterday's
//                              tokens carry yesterday's date, so leaving them tappable
//                              is worse than removing them.
//
// ── INERT BUTTONS ────────────────────────────────────────────────────────────
//
// Not every button claims state. "▲ Collapse", "⚙️ Tune", "➕ Show more" and the
// deep-link buttons are VIEW controls: they cannot go stale and they must not keep a
// fully resolved message alive. They are neither killed nor counted — declared `inert`
// in the registry with the reason, so the completeness guard can tell "we thought about
// this and there is nothing to reconcile" from "nobody thought about this".
//
// NO DB, NO CLOCK, NO NETWORK here — every scenario below is fixture-testable, and the
// DB half (./reconcile.ts) only supplies the predicates and performs the edits.

import type { InlineKeyboard } from "./telegram-render";

// The callback-token prefix of a button, or null for a url/deep-link button (which
// carries no token and is therefore never a state claim).
export function tokenPrefix(token: string | undefined): string | null {
  if (typeof token !== "string") return null;
  const i = token.indexOf(":");
  if (i <= 0) return null;
  return token.slice(0, i);
}

// Every callback token on a keyboard, in keyboard order (row-major). Order matters:
// the OWNING reconciler of a message is the one for its first state-claiming token,
// and builders put the primary action rows first and ride-along rows (the offer tail,
// ⚙️ Tune) last.
export function keyboardTokens(keyboard: InlineKeyboard): string[] {
  const out: string[] = [];
  for (const row of keyboard) {
    for (const btn of row) {
      if (typeof btn.callback_data === "string" && btn.callback_data)
        out.push(btn.callback_data);
    }
  }
  return out;
}

// Drop every button whose callback token is in `dead`, then drop rows left empty.
// Deep-link buttons and inert controls survive by construction — they are never `dead`.
export function stripTokens(
  keyboard: InlineKeyboard,
  dead: ReadonlySet<string>
): InlineKeyboard {
  return keyboard
    .map((row) =>
      row.filter(
        (b) =>
          typeof b.callback_data !== "string" || !dead.has(b.callback_data)
      )
    )
    .filter((row) => row.length > 0);
}

// What the sweep should do with one live message.
export type ReconcileDecision =
  // Nothing changed: make NO Telegram call. Pinned by an edit-call count in the DB
  // tier, because a reconcile that edits on every tick is a rate-limit incident.
  | { action: "none" }
  // Some claims resolved, others remain: strip exactly the dead buttons.
  | { action: "strip"; keyboard: InlineKeyboard }
  // Every claim this message made is resolved (or the day rolled over): replace the
  // body with a closing line and drop the keyboard.
  | { action: "close"; reason: CloseReason }
  // The day rolled over but the message still has inert/deep-link controls worth
  // keeping: remove only the tappable state claims.
  | { action: "strip-all"; keyboard: InlineKeyboard };

export type CloseReason = "resolved" | "rollover";

export interface ReconcileInput {
  keyboard: InlineKeyboard;
  // Tokens whose tap is no longer actionable — the family predicates' verdict.
  dead: ReadonlySet<string>;
  // Tokens that make no state claim (view controls). Never dead, never counted.
  inert: ReadonlySet<string>;
  // The subject's local day has moved past the message's send date.
  rolledOver: boolean;
}

// THE decision. Deterministic and total; the DB tier adds no branching of its own.
//
// Rollover is evaluated FIRST and unconditionally: a message from yesterday is not
// "partially outstanding", it is out of date as a whole, and its tokens would be
// refused anyway (every dated token carries its send date and the handlers check it).
// This also closes the residual #947 gap — today the last food nudge of an evening
// keeps a live keyboard until the NEXT send, which may never come.
export function decideReconcile(input: ReconcileInput): ReconcileDecision {
  const tokens = keyboardTokens(input.keyboard);
  const claims = tokens.filter((t) => !input.inert.has(t));

  if (input.rolledOver) {
    if (claims.length === 0) return { action: "none" };
    const stripped = stripTokens(input.keyboard, new Set(claims));
    return stripped.length === 0
      ? { action: "close", reason: "rollover" }
      : { action: "strip-all", keyboard: stripped };
  }

  const dead = claims.filter((t) => input.dead.has(t));
  if (dead.length === 0) return { action: "none" };
  if (dead.length === claims.length) return { action: "close", reason: "resolved" };
  return { action: "strip", keyboard: stripTokens(input.keyboard, new Set(dead)) };
}

// The closing line a fully-resolved message collapses to. Deliberately states WHY the
// buttons are gone: a message that simply lost its keyboard reads as a bug, and on the
// safety tier the user needs to know the dose is recorded, not merely un-tappable.
//
// Never celebratory and never a judgment — this is a correction of the app's own
// display, not feedback about the user (the #992/#716 tone contract).
export const RECONCILE_CLOSING: Record<CloseReason, string> = {
  resolved: "Handled in the app — nothing left here.",
  rollover: "This is yesterday's message.",
};
