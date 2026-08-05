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
//   • the message's date is
//     past what its family's
//     handler would honor    → strip the keyboard regardless of state, because every
//                              button on it would now be refused.
//
// That last arm is the SAME rule as the first, one axis over, and it was the one place
// this module got it wrong (#2018). It used to read "the profile-local day rolled over",
// which is `tapDateGuard`'s equality rule — true for the food nudge, whose token date is
// a guess at when the user ate, and false for a dose reminder, whose token date is a fact
// the schedule established and whose write core honors a tap for ±DOSE_LOG_DATE_WINDOW_DAYS
// (#614). A bedtime reminder therefore lost its buttons at the first tick after midnight
// while `markDoseTaken` was still built to accept them. The verdict is now computed by
// `messageExpiry` in ./reconcile-registry, which asks each family's own guard; this module
// stays mechanical and is handed the answer.
//
// ── INERT BUTTONS ────────────────────────────────────────────────────────────
//
// Not every button claims state. "▲ Collapse", "⚙️ Tune", "➕ Show more"/"➖ Show less"
// and the deep-link buttons are VIEW controls: they cannot go stale and must not keep a
// fully resolved message alive. They are neither killed nor counted — declared `inert`
// in the registry with the reason, so the completeness guard can tell "we thought about
// this and there is nothing to reconcile" from "nobody thought about this".
//
// NO DB, NO CLOCK, NO NETWORK here — every scenario below is fixture-testable, and the
// DB half (./reconcile.ts) only supplies the predicates and performs the edits.

import { createHash } from "node:crypto";
import type { InlineKeyboard } from "./telegram-render";
import { plainBody } from "./rich-text";
import type { NotificationMessage } from "./types";

// The PROSE witness (#1913 item 4): a stable fingerprint of what a message SAYS.
//
// A prose-claim reconciler re-runs the builder that composed the send and edits only when
// the render actually differs — the same idempotence rule the additive food class obeys,
// and what keeps the sweep at zero Telegram calls in the steady state. Comparing needs a
// record of the delivered text, and a hash is the whole of what comparison needs: the
// pointer table has no business holding a second copy of a message full of health facts.
//
// Title AND body, because a digest can change in either — and the PLAIN body, so a
// markup-only difference between two renderings of identical words is not mistaken for
// news to edit.
export function messageBodyHash(msg: NotificationMessage): string {
  return createHash("sha256")
    .update(`${msg.title}\n${plainBody(msg.body)}`)
    .digest("hex");
}

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
        (b) => typeof b.callback_data !== "string" || !dead.has(b.callback_data)
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
  // Every claim this message made is resolved (or its date is past what the family's
  // handler honors): replace the body with a closing line and drop the keyboard.
  | { action: "close"; reason: CloseReason }
  // The message's date expired but it still has inert/deep-link controls worth keeping:
  // remove only the tappable state claims.
  | { action: "strip-all"; keyboard: InlineKeyboard };

// `superseded` is NEVER produced by decideReconcile below — a sweep cannot know that a
// newer message exists. It is the send path's close reason (#1898): re-issuing a
// keyboard closes the one it replaces, and it does so through this same vocabulary so
// the chat only ever sees one closing convention.
//
// `rollover` and `expired` are the two date closes and are deliberately separate WORDS,
// not one word with two meanings: "this is yesterday's message" is the honest line for a
// nudge whose day is simply over, and a lie for a dose whose ±2-day window has now run
// out — the reader needs to be told the confirm can no longer land here.
export type CloseReason = "resolved" | "rollover" | "expired" | "superseded";

export interface ReconcileInput {
  keyboard: InlineKeyboard;
  // Tokens whose tap is no longer actionable — the family predicates' verdict.
  dead: ReadonlySet<string>;
  // Tokens that make no state claim (view controls). Never dead, never counted.
  inert: ReadonlySet<string>;
  // The close reason if the message's date is past what its family's own tap guard
  // still honors (`messageExpiry`), or null while a tap would still be accepted.
  expired: Extract<CloseReason, "rollover" | "expired"> | null;
}

// THE decision. Deterministic and total; the DB tier adds no branching of its own.
//
// Expiry is evaluated FIRST: a message whose buttons would all be refused is not
// "partially outstanding", it is out of date as a whole. What it is NOT is a global
// pre-empt (#2018) — the verdict comes from the family's own guard, so a food nudge
// still goes at the day boundary (closing the residual #947 gap, where the last nudge of
// an evening kept a live keyboard until the NEXT send, which may never come) while an
// unconfirmed dose keeps its buttons for as long as the write core would honor them.
export function decideReconcile(input: ReconcileInput): ReconcileDecision {
  const tokens = keyboardTokens(input.keyboard);
  const claims = tokens.filter((t) => !input.inert.has(t));

  if (input.expired) {
    if (claims.length === 0) return { action: "none" };
    const stripped = stripTokens(input.keyboard, new Set(claims));
    return stripped.length === 0
      ? { action: "close", reason: input.expired }
      : { action: "strip-all", keyboard: stripped };
  }

  const dead = claims.filter((t) => input.dead.has(t));
  if (dead.length === 0) return { action: "none" };
  if (dead.length === claims.length)
    return { action: "close", reason: "resolved" };
  return {
    action: "strip",
    keyboard: stripTokens(input.keyboard, new Set(dead)),
  };
}

// The closing line a fully-resolved message collapses to. Deliberately states WHY the
// buttons are gone: a message that simply lost its keyboard reads as a bug, and on the
// safety tier the user needs to know the dose is recorded, not merely un-tappable.
//
// Never celebratory and never a judgment — this is a correction of the app's own
// display, not feedback about the user (the #992/#716 tone contract).
//
// SUBJECTLESS FALLBACK ONLY (#1822 item 7). A close replaces the ENTIRE message text, so
// these sentences used to arrive as orphan bubbles: "Handled in the app — nothing left
// here." at 08:00, with no indication of WHAT was handled and — in a shared family chat —
// the "[Name] " attribution gone with the rest of the text, so you could not tell whose
// message resolved. Prefer `reconcileClosingText`, which names the subject; this map is
// what it degrades to for a pointer that never recorded one.
export const RECONCILE_CLOSING: Record<CloseReason, string> = {
  resolved: "Handled in the app — nothing left here.",
  rollover: "This is yesterday's message.",
  // The end of a dose's log window (#2018), where "yesterday's message" would be both
  // wrong (it is older than that) and unhelpful. It names the CONSEQUENCE instead —
  // the confirm can no longer land here — and where a later correction belongs, which
  // is the historical-dose backfill in the app (#1950).
  expired: "Too late to confirm here — log it in the app.",
  // Points DOWN the chat rather than merely stating a fact: the replacement is the very
  // next thing the user will scroll past, and a closed message that doesn't say where
  // the buttons went reads as a failure.
  superseded: "Superseded — use the message below.",
};

// The same two sentences as a TAIL, for when the subject leads the line:
// "[Norton] 🍽️ Morning food log — handled in the app."
const RECONCILE_CLOSING_TAIL: Record<CloseReason, string> = {
  resolved: "handled in the app.",
  rollover: "this was yesterday's message.",
  expired: "too late to confirm here, log it in the app.",
  superseded: "superseded, use the message below.",
};

// The text a closed message collapses to, naming its own subject. `title` is the message's
// delivered title line (attribution prefix included) as the pointer recorded it at send
// time; the first line is taken and trimmed, matching `replacementWithTitle`'s convention
// on the tap path — the same problem, already solved there for #377, so the reconcile close
// follows it rather than inventing a second shape.
//
// No title (a pointer from before the column existed, or a title-less message) ⇒ the bare
// closing line above. A close never invents a subject it was not told.
export function reconcileClosingText(
  reason: CloseReason,
  title: string | null | undefined
): string {
  const subject = (title ?? "").split("\n")[0]?.trim() ?? "";
  return subject
    ? `${subject} — ${RECONCILE_CLOSING_TAIL[reason]}`
    : RECONCILE_CLOSING[reason];
}
