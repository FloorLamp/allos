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
// and the deep-link buttons are VIEW controls and must not keep a fully resolved message
// alive. They are not counted; the registry says whether they outlive expired claims.
// in the registry with the reason, so the completeness guard can tell "we thought about
// this and there is nothing to reconcile" from "nobody thought about this".
//
// NO DB, NO CLOCK, NO NETWORK here — every scenario below is fixture-testable, and the
// DB half (./reconcile.ts) only supplies the predicates and performs the edits.

import { createHash } from "node:crypto";
import type { InlineKeyboard } from "./telegram-render";
import { plainBody } from "./rich-text";
import type { NotificationMessage } from "./types";
import { formatMessageLine } from "./message-line";
import { formatMonthDay } from "../format-date";
import { zonedDateParts } from "../date";

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

// ---- Is the rebuild worth paying for? (issue #2069) ------------------------
//
// The witness above answers "did the render change?", but only AFTER the render has been
// paid for — and for the digest that render is the tick's heaviest per-profile read. A
// sent digest's pointer stays live until rollover, so the sweep was paying it on every
// remaining tick of the day just to discover, ~15 times out of 16, that nothing moved.
//
// So the prose arm asks a cheaper question first, and the DECISION is here, pure, next to
// the witness it guards. The DB half supplies two facts — a cheap dependency stamp over
// the ledgers this kind's claims are derived from, and what it recorded the last time it
// actually rebuilt — and this decides whether to gather.
//
// THE FLOOR IS WHY A STAMP IS ALLOWED TO BE INCOMPLETE. A stamp can make a rebuild
// PROMPT; it is never trusted to prove one unnecessary forever. Once the recorded gather
// is older than the caller's floor, the rebuild happens regardless of what the stamp says,
// so the worst a missing dependency can cost is latency — never a claim left standing for
// the rest of the day. That is the same posture as the sweep's failure handling (#1885):
// the cheap signal decides what to do FAST, and it is never allowed to decide that
// nothing needs looking at.

export interface ProseGatherRecord {
  // The pointer date the recorded gather was for. A new day is always a fresh subject.
  date: string;
  // The dependency stamp as of that gather.
  stamp: string;
  // When it happened, epoch ms — the floor's anchor.
  at: number;
}

export type ProseGatherReason =
  "no-stamp" | "no-record" | "new-day" | "stamp-moved" | "floor" | "unchanged";

export interface ProseGatherDecision {
  gather: boolean;
  reason: ProseGatherReason;
}

export function decideProseGather(input: {
  // The live pointer's date.
  date: string;
  // The cheap dependency stamp, or null for a kind that declares no pre-check.
  stamp: string | null;
  // What the last real rebuild recorded, or null if there is none.
  last: ProseGatherRecord | null;
  nowMs: number;
  floorMs: number;
}): ProseGatherDecision {
  // No pre-check declared ⇒ the kind rebuilds every tick, exactly as before. A reconciler
  // that has not been given a stamp must not be quietly throttled by the floor alone.
  if (input.stamp == null) return { gather: true, reason: "no-stamp" };
  if (!input.last) return { gather: true, reason: "no-record" };
  if (input.last.date !== input.date)
    return { gather: true, reason: "new-day" };
  if (input.last.stamp !== input.stamp)
    return { gather: true, reason: "stamp-moved" };
  // A record from the future (a clock step back) is not evidence of a recent gather, so
  // the elapsed comparison is written to fail OPEN rather than to trust it.
  const elapsed = input.nowMs - input.last.at;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= input.floorMs)
    return { gather: true, reason: "floor" };
  return { gather: false, reason: "unchanged" };
}

// The record's stored form — one profile_settings value, `date|stamp|epochMs`. Parsing is
// the #947 posture: a value this module cannot read is treated as ABSENT (so the next tick
// rebuilds) rather than throwing on the sweep.
export function formatProseGatherRecord(r: ProseGatherRecord): string {
  return `${r.date}|${r.stamp}|${r.at}`;
}

export function parseProseGatherRecord(
  raw: string | undefined | null
): ProseGatherRecord | null {
  if (!raw) return null;
  const [date, stamp, at] = raw.split("|");
  if (!date || !stamp || !at) return null;
  const ms = Number(at);
  if (!Number.isFinite(ms)) return null;
  return { date, stamp, at: ms };
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
// Deep links and standalone inert controls survive unless the caller names them here.
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
  // Inert view controls whose subject is the claims they reveal. They remain inert for
  // live reconciliation, but expire with those claims instead of surviving alone.
  claimView?: ReadonlySet<string>;
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
    const expiredTokens = new Set(claims);
    for (const token of tokens) {
      if (input.claimView?.has(token)) expiredTokens.add(token);
    }
    if (expiredTokens.size === 0) return { action: "none" };
    const stripped = stripTokens(input.keyboard, expiredTokens);
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
//
// ── THE OUTCOME DETAIL (issues #2170 → #2274 → #2275) ────────────────────────
//
// A resolved close replaces the ENTIRE message text, so the chat history ended up LESS
// informative than the reminder had been: the reader learned that something was
// recorded, not what. The detail states what the reconcile ALREADY HAD IN HAND — every
// claim token was resolved against the ledger to decide the close, so this is the
// decision's own inputs restated, not a second adherence computation (#221).
//
// IT NAMES WHAT HAPPENED, IN THE DOMAIN'S OWN WORDS (#2274). #2170's rule here was
// "counts only, never an item list", and it did not survive contact with the message it
// applies to: THE REMINDER WAS ALREADY A LIST. It named every item, under the same
// `[Name]` attribution prefix, in the same chat. A close that names the same items is
// not a new report and discloses nothing the chat did not already contain — it
// PRESERVES what the message said instead of degrading it to an integer, which is what
// made the history get less specific as things resolved. And the words are the ones the
// user has always seen: the button is `✅ <name>`, the write core is `markDoseTaken`, so
// the close says `taken` / `skipped` and never the reconcile's private "logged".
//
// IT ALSO SAYS WHEN, FOR DOSES (#2867, owner decision 2026-08-14). "Which" alone left
// out the fact a person glancing back at the chat most often wants — did I take it this
// morning, or am I remembering yesterday? The instants are already in the ledger the
// close reads, so stating them costs one more read of rows this pass already resolved.
//
// The rest of #2170's rule STANDS, and is why the parts below carry names, an outcome
// and nothing else: THE APP LEDGER STAYS THE COMPLETE SURFACE. No amounts, no food
// notes, no adherence tails, no per-dose marks — the receipt answers WHICH and WHEN, and
// how much is in the app. The boundary moved for times only. A close can never be longer
// than the reminder it replaces, so it needs no cap.
//
// ORDER IS THE ORDER THE MESSAGE SHOWED THEM. Callers read their tokens in keyboard
// order, which is already the reminder's own obligation-then-name sort — parity for
// free, and no second sort to drift.
//
// IT IS A SNAPSHOT, ON PURPOSE. Closing is forgetting: the pointer is deleted in the
// same claim, so nothing re-edits this text afterwards. A dose edited in the app later
// makes the chat line HISTORICAL, exactly like every other message in a chat — not
// wrong, and deliberately not maintained.

// ONE outcome and the items it applies to: "Vitamin D, Magnesium taken".
export interface CloseGroup {
  // An attribution the group's items hang off — the household round's member name,
  // which its body sections and its button labels already carry (#377). Absent for a
  // single-subject message, whose subject line already says whose it is.
  lead?: string;
  // The items this outcome applies to, in the order the message showed them.
  //
  // PRESENT AND EMPTY means "this group is about items and there are none" — the group
  // is omitted, so an all-taken close is one clean clause. ABSENT means the outcome
  // names no items at all (a draft session is one thing, a check-in is one value), and
  // the outcome stands alone.
  names?: readonly string[];
  // What happened, in the DOMAIN's own words — `taken`, `skipped`, `session discarded`.
  outcome: string;
}

// What a family says about a `resolved` close. One shape for every family (#2275), so
// the close text is ONE formatter over declared facts rather than eleven renderings.
export interface CloseDetail {
  groups: readonly CloseGroup[];
}

// "Vitamin D, Magnesium taken · Omega-3 skipped", or null when nothing renders (which
// then reads as the plain closing sentence).
//
// ` · ` is the separator the dose reminder's own tail already uses, so the close is
// punctuated like the message it replaces. Names repeat across groups on purpose — a
// supplement taken at one dose and skipped at another is two facts — but collapse
// WITHIN a group, where the same name twice would be a rendering artifact.
export function closeDetailText(
  detail: CloseDetail | null | undefined
): string | null {
  if (!detail) return null;
  const parts: string[] = [];
  for (const g of detail.groups) {
    if (!g.outcome) continue;
    // Present-and-empty ⇒ this group had items and has none. Absent ⇒ it never had any.
    if (g.names && g.names.length === 0) continue;
    const names = g.names ? [...new Set(g.names)].join(", ") : "";
    const lead = g.lead ? `${g.lead}: ` : "";
    parts.push(`${lead}${names ? `${names} ` : ""}${g.outcome}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// One dose the ledger says was TAKEN, and when (#2867).
export interface TakenDose {
  name: string;
  // THE ADMINISTRATION INSTANT ITSELF, ISO UTC — not a pre-rendered clock and not a
  // date beside one. That is the whole point of the shape: the displayed date and the
  // displayed clock are two views of ONE fact, and handing them in separately is what
  // let them disagree.
  //
  // They did. The first cut passed the adherence DAY beside the instant's wall clock,
  // and a correction that crosses local midnight moves only `occurred_at` — the
  // adherence day is unchanged by design (`restampDoseLogsCore` reports
  // `crossedMidnight` for exactly this) — so a dose stated at 23:50 the previous
  // evening was labelled with the following day: a datetime that never happened.
  // Deriving both from this one field makes that unrepresentable rather than tested-for.
  //
  // Null/absent for a taken row this pass could not read an instant from — which renders
  // as a plain `taken` group rather than inventing a time, the same stated-not-inferred
  // posture the tally takes for a dose in neither ledger set. Rare by construction:
  // `intake_item_logs.recorded_at` is NOT NULL and the read COALESCEs `occurred_at` onto
  // it, so this arm covers a stored value that will not parse.
  at?: string | null;
}

// The DOSE families' shape of `CloseDetail` (#2274): the taken receipt first, then the
// skips. Both dose families share it unchanged — they are the only ones whose vocabulary
// is take/skip, which is why it may be dose-specific at all.
export interface ClosingTally {
  // Doses confirmed taken, each with its administration instant, and doses deliberately
  // skipped — a skip is a record the user made, which is why it is stated rather than
  // folded into the first list.
  //
  // SKIPS CARRY NO TIME. "Skipped 8:12" would state when the button was pressed, which
  // is not when anything happened; a skip's whole content is that nothing was taken.
  taken: readonly TakenDose[];
  skipped: readonly string[];
  // The PROFILE's timezone, which every instant above renders in. Absent means the
  // caller has no zone to render in, and every taken dose falls back to the untimed
  // `taken` group rather than being shown in the host's zone.
  tz?: string;
}

// The rendered view of one administration instant, or null when there is nothing to
// render it from.
function takenAt(
  d: TakenDose,
  tz: string | undefined
): { key: string; date: string; clock: string } | null {
  if (!d.at || !tz) return null;
  const instant = new Date(d.at);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = zonedDateParts(tz, instant);
  return {
    // BUCKETS KEY ON THE UTC MINUTE, not on the rendered clock. Within one offset the
    // two are the same thing — offsets are whole minutes — so "doses logged in the same
    // displayed minute share a bucket" is unchanged. Across a DST FALL-BACK they are
    // not: 05:30Z and 06:30Z on 2026-11-01 in America/New_York both display 01:30, an
    // hour apart, and keying on the rendered clock merged them into one clause claiming
    // they were simultaneous. They now render as two clauses reading the same time,
    // which is what actually happened — the repeated wall hour is genuinely ambiguous,
    // and stating it twice is honest where merging is not.
    key: instant.toISOString().slice(0, 16),
    date: parts.date,
    clock: parts.hhmm,
  };
}

// GROUPED BY TIME, not marked per item (#2867 owner decision): the common one-tap-all
// case collapses to a single clause, and doses logged in the same minute share a bucket.
// Buckets render in first-appearance order — which is keyboard order, the same rule the
// rest of the close follows.
//
// The DATE rides a clause only on a close that spans more than one. "taken 08:12" is
// unambiguous on an ordinary single-date close, and carrying the date there would be
// noise on every one of them.
export function closingTallyDetail(tally: ClosingTally): CloseDetail {
  const rendered = tally.taken.map((t) => takenAt(t, tally.tz));
  const spansDates =
    new Set(rendered.filter((r) => r !== null).map((r) => r.date)).size > 1;
  const buckets = new Map<string, { outcome: string; names: string[] }>();
  tally.taken.forEach((t, i) => {
    const at = rendered[i];
    const key = at ? at.key : "untimed";
    let bucket = buckets.get(key);
    if (!bucket) {
      const when = at
        ? spansDates
          ? `${formatMonthDay(at.date)}, ${at.clock}`
          : at.clock
        : "";
      bucket = { outcome: when ? `taken ${when}` : "taken", names: [] };
      buckets.set(key, bucket);
    }
    bucket.names.push(t.name);
  });
  return {
    groups: [
      ...[...buckets.values()].map((b) => ({
        names: b.names,
        outcome: b.outcome,
      })),
      { names: tally.skipped, outcome: "skipped" },
    ],
  };
}

// "Vitamin D, Magnesium taken 08:12 · Omega-3 skipped" / "Melatonin skipped", or null
// when neither list has anything in it.
export function closingTallyText(tally: ClosingTally): string | null {
  return closeDetailText(closingTallyDetail(tally));
}

export function reconcileClosingText(
  reason: CloseReason,
  title: string | null | undefined,
  // The resolution facts, for `resolved` only. The other reasons close for time or
  // lifecycle reasons where an outcome would be wrong or unknowable — a rolled-over
  // nudge says nothing about what the day's ledger holds, and a superseded keyboard was
  // replaced rather than answered.
  detail?: CloseDetail | null
): string {
  const subject = (title ?? "").split("\n")[0]?.trim() ?? "";
  // No subject ⇒ the bare sentence, detail or not: a pointer that never recorded a
  // subject has no per-item facts to attribute either.
  if (!subject) return RECONCILE_CLOSING[reason];
  const outcome =
    reason === "resolved" ? closeDetailText(detail ?? null) : null;
  // No app pointer (#2274): the buttons are gone because everything is resolved, and
  // naming what happened already tells the reader it is recorded. "In the app." was a
  // sentence fragment doing two jobs and reading like a truncated string.
  // The subject is the head; what happened to it is the note. The sentence-final period
  // belongs to the outcome clause, so it rides the note rather than the composition.
  return formatMessageLine({
    head: subject,
    notes: [outcome ? `${outcome}.` : RECONCILE_CLOSING_TAIL[reason]],
  });
}
