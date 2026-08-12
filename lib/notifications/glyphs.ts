// THE MESSAGE GLYPH VOCABULARY (issue #2392) — pure, no DB/network.
//
// WHY IT EXISTS. Before this module there were 53 distinct base glyphs across 42 files,
// every one an inline literal. No registry, no declared meaning, and nothing to consult
// before adding the fifty-fourth — so the vocabulary drifted into synonyms (✅ and ✓ both
// affirmative; 😴 and 💤 both "sleep"; a flagged lab wearing 🚩 while the flagged VITAL
// one function away wore 🩺) and into an encoding split: 🌡 appeared both with and
// without U+FE0F, which is a colour emoji on one platform and a monochrome text glyph on
// the next — one symbol, two faces, in one product.
//
// NOT EVERY LOOKALIKE WAS A SYNONYM, which is the other half of the work: 👍 is not ✅ on
// a message whose own reply says "dose not marked taken", 🛌 is a REST day rather than
// sleep, 🔴 is an obligation rather than an alarm, and ⚑ ranks a due item where 🚩
// reports a reading out of range. Each of those kept its own entry, and the entry says
// why — a forced collapse that loses a real distinction is worse than a synonym.
//
// The one place semantics WERE declared showed what the fix looks like. For the digest's
// named data-plumbing lines the glyph "says WHO ACTS — 🔌 keeps 'a connection broke and
// allos will keep retrying'; 🙋 marks a line only a person can close", declared beside
// the domain so a new named-line domain must CHOOSE one rather than defaulting into 🔌
// silently (#1913 item 8). That discipline is what generalises here.
//
// THE TWO RULES, stated rather than implied:
//
//   1. ONE CONCEPT, ONE GLYPH. Adding a synonym requires RETIRING the incumbent, not
//      sitting beside it. Retirement is a first-class record here (RETIRED_GLYPHS), so
//      "we replaced ✓ with ✅" is a reviewable fact and a reintroduced ✓ fails the scan
//      by name rather than quietly re-forking the vocabulary.
//
//   2. A GLYPH CARRIES MEANING, NOT DECORATION — and WHICH meaning is DECLARED, never
//      inferred from where it appears. Every entry names its ROLE: does it say who must
//      act, what the line is about, where the thing stands, or what a control does to
//      the view? A producer that cannot answer that question for its glyph does not have
//      a glyph; it has decoration.
//
// ENCODING IS THEN SETTLED BY CONSTRUCTION. Each entry holds ONE canonical form
// INCLUDING its variation selector, producers reference the entry, and a literal cannot
// disagree with it. The completeness test derives the requirement from Unicode itself
// rather than a hand-kept list: a base codepoint that is `\p{Emoji}` but not
// `\p{Emoji_Presentation}` is presentation-AMBIGUOUS and must carry an explicit U+FE0F
// (colour) or U+FE0E (monochrome); one that is already unambiguous must carry neither,
// because a redundant selector is just a second spelling waiting to drift.
//
// WHAT THIS IS NOT. It is not a palette to pick from. Adding an entry is a copy decision
// — the same weight as adding a sentence — and the scan below exists so that decision is
// made once, in this file, rather than fifty-three times in forty-two others.

// ---------------------------------------------------------------------------
// ROLES
// ---------------------------------------------------------------------------

// What a glyph is DOING on the line it leads. Declared per entry; the reader of a
// message learns one vocabulary rather than one per surface.
export type GlyphRole =
  // WHO ACTS. The #1913 item 8 rule, and the reason this registry exists in this shape:
  // the glyph answers "is there anything for me to do here?" before the words do.
  | "actor"
  // WHAT THIS NEEDS. An alert outranks its topic — a line that carries one leads with it
  // rather than with the domain marker, because the reader's next action differs.
  | "alert"
  // WHAT THIS IS ABOUT. The domain marker: doses, training, sleep, a document. The
  // ordinary case, and the one a new named-line domain picks from.
  | "topic"
  // WHERE THE THING STANDS — either the state a row is already in ("✅ taken"), or the
  // state a tap moves it to ("✅ Confirmed taken"). Deliberately ONE role for both: the
  // button and the marker must be the same glyph, or a person cannot learn from the
  // confirmation what the marker will say afterwards.
  | "state"
  // WHAT A CONTROL DOES TO THE VIEW, changing nothing about the data — show more, go
  // back, open the tuning panel. Kept apart from `state` precisely because these do NOT
  // record anything.
  | "control";

export interface GlyphEntry {
  // The canonical form, variation selector included. The ONLY spelling of this concept.
  readonly glyph: string;
  readonly role: GlyphRole;
  // What the glyph CLAIMS, in the reader's terms. A producer that cannot say its line
  // means this has picked the wrong entry.
  readonly means: string;
}

// ---------------------------------------------------------------------------
// THE VOCABULARY
// ---------------------------------------------------------------------------

const VOCABULARY = {
  // ── actor: who has to act ────────────────────────────────────────────────
  allosRetries: {
    glyph: "🔌",
    role: "actor",
    means:
      "A connection broke and allos will keep retrying. Nothing for a person to do but wait — the line is informational, and it closes itself (#1685/#1913 item 8).",
  },
  personActs: {
    glyph: "🙋",
    role: "actor",
    means:
      "Only a PERSON can close this, and usually away from the device reading the message (#1757). Deliberately domain-neutral: the distinction is who acts, not what hardware is involved, so a future errand in another domain inherits it.",
  },

  // ── alert: what needs attention ──────────────────────────────────────────
  caution: {
    glyph: "⚠️",
    role: "alert",
    means:
      "Do not read this as fine, or as complete. Two shapes share it deliberately: a safety alarm the reader must not miss (a missed dose), and a message that had to be cut short ('+3 more — open the app'). Both say the same thing — what you are looking at is not the whole, settled picture.",
  },
  flagged: {
    glyph: "🚩",
    role: "alert",
    means:
      "A READING fell outside its reference range — the reconciled canonical flag, never a threshold invented by a surface. One glyph for labs and vitals alike: they are the same claim about the same kind of fact (#2392 collapsed the vitals half, which wore the clinical topic marker and so read as 'a clinical thing happened' rather than 'this number is out of range').",
  },
  priority: {
    glyph: "⚑",
    role: "alert",
    means:
      "Among the things due, THIS is the one that matters most today (#656) — a rank, carrying the item's own top reason. Deliberately NOT the flagged-reading glyph: a high-priority reminder is not an abnormal result, and dressing it as one is a false alarm in the direction that costs trust. Kept at TEXT weight (U+2691 is not an emoji codepoint at all) so the two read as different weights of flag, not the same one twice.",
  },

  // ── topic: what the line is about ────────────────────────────────────────
  sun: {
    glyph: "☀️",
    role: "topic",
    means:
      "The SUN — the morning message that arrives with it, and the daylight window it opens (#1723 part 1). One concept, honestly: the digest's title and the light-exposure line are both about the same hours of the same day, which is why they may share a glyph where two unrelated topics may not.",
  },
  recap: {
    glyph: "📊",
    role: "topic",
    means:
      "The periodic recap — a summary of a window that has already closed, which is what makes it a different message from the digest. ONE glyph across weekly, monthly and quarterly (#2178): the cadence changes how often the message arrives, never what it is, and a scale wearing its own face would tell the reader a second message had started.",
  },
  dose: {
    glyph: "💊",
    role: "topic",
    means:
      "A supplement or medication DOSE. One glyph across both kinds by the shared-substrate rule: kind decides clinical identity, not what a dose line looks like.",
  },
  resupply: {
    glyph: "🔄",
    role: "topic",
    means:
      "Supply is running out and needs replacing — the refill/shared-pool topic. The ORDER a person then places is a state (`ordered`), not this.",
  },
  training: {
    glyph: "🏋️",
    role: "topic",
    means:
      "A training session — planned, in progress, or done. The GENERIC marker, which is what makes it the honest answer for a session whose type nobody stated (#2272/#2503); the per-type labels below name a discipline.",
  },
  cardio: {
    glyph: "🏃",
    role: "topic",
    means:
      "A cardio session specifically — where a line names the discipline beside its siblings, and on a message ABOUT one such session (#2503: the finish nudge's title, which wore the barbell over a 1.4 km walk).",
  },
  sport: {
    glyph: "⚽",
    role: "topic",
    means:
      "A sport session specifically — where a line names the discipline beside its siblings, and on a message about one such session (#2503).",
  },
  mobility: {
    glyph: "🤸",
    role: "topic",
    means:
      "A MOBILITY session — the `recovery` activity type (#840): stretching and flexibility work, logged as tapped moves with no sets, weights or volume. Not the rest glyph (that is a statement about load, and this is a session that happened), not the practice glyph (that counts its own ledger), and emphatically not the training marker: announcing mobility work under a barbell tells a person it counted as training load, which is the one distinction #482 keeps everywhere else.",
  },
  rest: {
    glyph: "🛌",
    role: "topic",
    means:
      "A REST day — the training plan says do not train today. Not sleep: it is a statement about load, and the sleep glyph on it would make a recommendation look like a measurement.",
  },
  steps: {
    glyph: "🚶",
    role: "topic",
    means: "Walking — the daily step count and its declared target.",
  },
  outdoorPlan: {
    glyph: "🚴",
    role: "topic",
    means:
      "A planned OUTDOOR session and the window the forecast favours (#1724) — a plan about the week, never an instruction with a deadline.",
  },
  sleep: {
    glyph: "😴",
    role: "topic",
    means:
      "Sleep — last night's overnight session or a same-day nap. The words say which; two faces for one subject taught the reader nothing (#2392 retired the nap's own glyph).",
  },
  trend: {
    glyph: "📈",
    role: "topic",
    means:
      "A figure read as a SERIES rather than as today's value — sleep regularity, a trend line.",
  },
  food: {
    glyph: "🍽️",
    role: "topic",
    means:
      "Eating — the food log, its per-slot windows, and the nudge that offers them.",
  },
  protein: {
    glyph: "💪",
    role: "topic",
    means:
      "Protein specifically, distinct from the food log it is counted from (#824's grams preset is not a serving).",
  },
  weight: {
    glyph: "⚖️",
    role: "topic",
    means:
      "A body-weight reading — the figure and the prompts that log it, never a judgment about it.",
  },
  temperature: {
    glyph: "🌡️",
    role: "topic",
    means:
      "A body-temperature reading and the fever checks over it. The canonical form CARRIES U+FE0F: the bare codepoint defaults to a monochrome text glyph on several platforms, which is how one symbol came to have two faces in one product.",
  },
  illness: {
    glyph: "🤒",
    role: "topic",
    means:
      "An open illness episode, or a symptom on its way into one. About being unwell, never about an injury.",
  },
  injury: {
    glyph: "🤕",
    role: "topic",
    means:
      "An injury or pain report — kept apart from illness because the two lead to different questions.",
  },
  clinical: {
    glyph: "🩺",
    role: "topic",
    means:
      "Care a CLINICIAN owns — preventive screening, an overdue follow-up. Never a reading's out-of-range state: that is `flagged`.",
  },
  encounter: {
    glyph: "🏥",
    role: "topic",
    means:
      "A visit or appointment that HAPPENED — the encounter itself, not a screening that is still due.",
  },
  measurement: {
    glyph: "📏",
    role: "topic",
    means:
      "A body measurement — height and its kin, measured with a tape rather than assayed or monitored.",
  },
  document: {
    glyph: "📄",
    role: "topic",
    means:
      "A clinical document that arrived and finished extracting — the file, not the readings it carried.",
  },
  ledger: {
    glyph: "📋",
    role: "topic",
    means:
      "The LOG ITSELF — what the record does and does not contain (#2376). A statement about the ledger the message is already about, and deliberately never about the person: the empty-window notice wears this rather than an alert glyph precisely because nothing is wrong and nothing was owed.",
  },
  arrival: {
    glyph: "📥",
    role: "topic",
    means:
      "Data ARRIVED from a source — the provenance event, not the readings it carried.",
  },
  dueToday: {
    glyph: "🗓️",
    role: "topic",
    means:
      "The banded 'what's due' summary — a calendar's worth of items counted or named on one line.",
  },
  context: {
    glyph: "🧭",
    role: "topic",
    means:
      "A SITUATION or derived context is active and it changed what is due today (#662/#1292/#1298). One glyph for the declared and the derived halves: the reader's question is the same — why is there more on my list than usual — and the moon the derived half used to wear was simply wrong on a period-derived line.",
  },
  paused: {
    glyph: "⏸️",
    role: "topic",
    means:
      "Items are HELD by a pause situation (#1296) — visible on purpose, so a forgotten pause is never a silent reminder blackout.",
  },
  changed: {
    glyph: "🔁",
    role: "topic",
    means:
      "Something in the pushed tier changed STATE — missed, resumed, started (#1505 part 3).",
  },
  mood: {
    glyph: "🙂",
    role: "topic",
    means:
      "The daily wellbeing check-in (#992). A topic marker, never a verdict on the answer — the 1–5 faces of the scale itself are a graded SCALE and live with the domain, not here.",
  },
  practice: {
    glyph: "🧘",
    role: "topic",
    means:
      "A wellness practice — the tracked-practice list, its shortfall lines and its check-in (#1259).",
  },
  eventTime: {
    glyph: "🕐",
    role: "topic",
    means:
      "WHEN something happened, as opposed to when it was tapped (#2264) — the time-correction question and its statement of record.",
  },
  schedule: {
    glyph: "🕘",
    role: "topic",
    means:
      "When a recurring MESSAGE arrives — the digest time suggestion (#2217). About the delivery, never about the person.",
  },
  easingBack: {
    glyph: "🌤️",
    role: "topic",
    means:
      "Coming out of an illness and back toward normal load (#837) — the one-shot re-entry note. Deliberately NOT the sun: this is weather as a figure of speech about recovery, and giving it the same glyph as an actual daylight window would make a metaphor look like a forecast.",
  },
  device: {
    glyph: "🖥️",
    role: "topic",
    means:
      "A machine or workstation an errand has to be run on — hardware, distinct from who has to run it.",
  },
  wearable: {
    glyph: "⌚",
    role: "topic",
    means:
      "The worn device itself — whether it is on a wrist, not what it measured.",
  },
  inProgress: {
    glyph: "⏱️",
    role: "topic",
    means:
      "A session that is still running and has not been closed out — open, not late (#560/#1205).",
  },
  bullet: {
    glyph: "•",
    role: "topic",
    means:
      "NO domain marker — a plain list item. Declared rather than typed inline so 'this line deliberately has no glyph' is a choice on the record, and so the digest's body bullets and the recap's are provably the same character.",
  },

  // ── state: where the thing stands ────────────────────────────────────────
  done: {
    glyph: "✅",
    role: "state",
    means:
      "It is DONE — taken, logged, finished, confirmed — or, on a control, the tap that makes it so. The single affirmative in the product (#2392 retired the lighter check mark that had grown up beside it).",
  },
  acknowledged: {
    glyph: "👍",
    role: "state",
    means:
      "A person has SEEN this and is handling it — and NOTHING was recorded. Deliberately NOT the done glyph, and the distinction is safety-bearing: the escalation's 'I'm on it' sits one button away from 'Confirmed taken', and its own reply says 'dose not marked taken'. Collapsing the two would let an acknowledgement read as a confirmation on the one message where that is most expensive.",
  },
  skipped: {
    glyph: "⏭️",
    role: "state",
    means:
      "Deliberately SKIPPED (#232) — a decision on the record, never a miss. Carries U+FE0F: the bare codepoint is presentation-ambiguous.",
  },
  notApplicable: {
    glyph: "🚫",
    role: "state",
    means:
      "It does not apply to this person and should not be suggested again.",
  },
  snoozed: {
    glyph: "⏰",
    role: "state",
    means:
      "Hidden until a named later time, and then it comes back. A deferral, never a dismissal.",
  },
  discarded: {
    glyph: "🗑️",
    role: "state",
    means:
      "Thrown away rather than recorded — a draft dropped. Carries U+FE0F: the bare codepoint is presentation-ambiguous.",
  },
  finish: {
    glyph: "🏁",
    role: "state",
    means:
      "A thing reached its END — a session closed out, a milestone reached.",
  },
  ordered: {
    glyph: "📦",
    role: "state",
    means:
      "A refill has been ORDERED and is on its way — the person's action, not the shortage that prompted it.",
  },
  required: {
    glyph: "🔴",
    role: "state",
    means:
      "A `must` item still outstanding on a dose list, against the plain bullet everything else carries. A statement about OBLIGATION, not about danger — which is why it is not the caution or the flagged glyph.",
  },
  muted: {
    glyph: "🔕",
    role: "state",
    means:
      "A reminder is SILENCED: this category will not be sent, or this suggestion will not be raised again. The off half of a per-category delivery pair.",
  },
  reminding: {
    glyph: "🔔",
    role: "state",
    means:
      "A reminder is LIVE: this category or message will be sent, and the message that carries the bell is one. The on half of a per-category delivery pair, and the marker on the digest of what is due.",
  },
  waiting: {
    glyph: "⏳",
    role: "state",
    means:
      "Not yet — it happens as soon as the thing it is waiting on is ready, with no time named.",
  },

  // ── control: what a control does to the VIEW ─────────────────────────────
  more: {
    glyph: "➕",
    role: "control",
    means:
      "There is MORE here than the message shows — more to log, or more to reveal. One glyph for both because the reader's question is the same: what am I not seeing?",
  },
  less: {
    glyph: "➖",
    role: "control",
    means:
      "Collapse back to the short view. The exact counterpart of `more`, and never a removal of data.",
  },
  tune: {
    glyph: "⚙️",
    role: "control",
    means: "Change what this message says about you, not what it says now.",
  },
  guide: {
    glyph: "📖",
    role: "control",
    means:
      "Read HOW to do the thing the line names — a reference, not an action on any record.",
  },
  back: {
    glyph: "↩︎",
    role: "control",
    means:
      "Leave this drill-down and restore the message it replaced, changing nothing. Carries U+FE0E on purpose: a colour arrow beside plain text button labels reads as an action of its own weight, and this one is the opposite of one.",
  },
} as const satisfies Record<string, GlyphEntry>;

export type GlyphName = keyof typeof VOCABULARY;

// The declared vocabulary, for the completeness tests and for anything that wants to
// read the meanings (the scan's failure message names the concept, not the codepoint).
export const GLYPH_VOCABULARY: {
  readonly [K in GlyphName]: GlyphEntry;
} = VOCABULARY;

// THE CALL-SITE LOOKUP. `glyph: GLYPH.sleep` instead of `glyph: "😴"` — a VALUE change
// at the call site with no signature change anywhere, because #2391 already made every
// migrated producer pass its glyph as a plain field rather than concatenate it onto a
// line (lib/notifications/message-line.ts, `MessageLineParts.glyph`).
export const GLYPH = Object.fromEntries(
  Object.entries(VOCABULARY).map(([name, entry]) => [name, entry.glyph])
) as { readonly [K in GlyphName]: (typeof VOCABULARY)[K]["glyph"] };

// ---------------------------------------------------------------------------
// RETIREMENTS
// ---------------------------------------------------------------------------

// RULE 1 MADE ENFORCEABLE. A synonym does not simply stop being used — it is RETIRED,
// on the record, pointing at the survivor. That is what turns "one concept, one glyph"
// from a sentence in a comment into something the scan can say out loud when a retired
// form comes back: it names the concept that already owns the meaning.
//
// A retired form is also how the ENCODING split is expressed. The bare 🌡 is not a
// different glyph from 🌡️ to a reader; it is the same symbol rendered two ways, and it
// is retired in favour of the one canonical spelling.
export interface RetiredGlyph {
  readonly form: string;
  readonly replacedBy: GlyphName;
  readonly why: string;
}

export const RETIRED_GLYPHS: readonly RetiredGlyph[] = [
  {
    form: "✓",
    replacedBy: "done",
    why: "The lighter check mark, affirmative in exactly the sense ✅ already was, kept alive by button-width habit rather than by meaning. A reader who learned ✅ met ✓ and had to decide whether the difference mattered; it did not, and nothing said so.",
  },
  {
    form: "🌙",
    replacedBy: "context",
    why: "Marked the DERIVED-context acknowledgment line, which fires for a rough night AND for a logged period (#1292/#1298) — so the moon was already wrong half the time, and it sat one line above the situation-activation line asking the reader's identical question under a different face.",
  },
  {
    form: "💤",
    replacedBy: "sleep",
    why: "Marked the nap line directly beneath the overnight line's 😴. Two faces for one subject in one four-line section; the words ('+ 45m nap') already carry the only distinction there is.",
  },
  {
    form: "🌡",
    replacedBy: "temperature",
    why: "The bare thermometer, no U+FE0F — the SAME symbol as the canonical form, rendered as a monochrome text glyph rather than a colour emoji on several platforms. It appeared beside its own canonical spelling inside one module.",
  },
  {
    form: "🗑",
    replacedBy: "discarded",
    why: "The bare wastebasket, no U+FE0F. Presentation-ambiguous by the same rule as the thermometer; nothing about it was a deliberate monochrome choice.",
  },
  {
    form: "⏭",
    replacedBy: "skipped",
    why: "The bare skip triangle, no U+FE0F. Presentation-ambiguous, and it rides dose keyboards beside ✅ — which is emoji-presentation by default, so the pair rendered at two different weights on the platforms that split them.",
  },
];

// ---------------------------------------------------------------------------
// THE DECLARED SCOPE
// ---------------------------------------------------------------------------

// WHY SCOPE IS A LIST AND NOT A PATTERN — the same argument MESSAGE_LINE_MODULES makes
// one layer up, and for a sharper reason here. An emoji in this repo is not always a
// message glyph: `lib/datasets/food-groups.ts` carries one icon PER ROW of a catalog
// (🥬, 🫐, 🥩 — a data column, not a vocabulary of concepts), `lib/mood.ts` holds a
// graded 1–5 SCALE of faces where the whole point is that adjacent values differ, and
// UI surfaces use ✓ and ★ as styled typography inside tables and buttons. Sweeping
// those in would force a registry entry per food and per scale point and produce a scan
// nobody could read.
//
// So scope is DECLARED: a module in this list composes text a PERSON READS IN A MESSAGE
// — a notification body, a title, an inline keyboard label, a command reply, or a line
// handed to one of those. lib/__tests__/glyph-vocabulary.test.ts fails any of them for
// carrying an emoji literal instead of referencing GLYPH, with an allowlist that carries
// a written reason per survivor.
//
// Adding a module here is how a new message surface opts IN, and it is the reviewable
// record of what "a message builder" means today.
export const GLYPH_MODULES: readonly { module: string; why: string }[] = [
  {
    module: "lib/notifications/digest.ts",
    why: "The morning digest — the largest set of message lines the app sends, and the surface whose 'who acts' declaration this registry generalises from (#1913 item 8).",
  },
  {
    module: "lib/notifications/upcoming-digest.ts",
    why: "The digest's banded 'what's due' model and the named data-plumbing lines, which own the two actor glyphs (#1685/#1757).",
  },
  {
    module: "lib/notifications/digest-tune.ts",
    why: "The collapsed Tune panel: the control that opens it and the per-category on/off labels (#1714).",
  },
  {
    module: "lib/recap.ts",
    why: "The periodic recap message (#32/#2178) — the second system-initiated message a profile receives, at whichever of the three cadences the profile chose. In scope precisely because it does not live under lib/notifications/.",
  },
  {
    module: "lib/notifications/supplement-format.ts",
    why: "The dose reminder: window title, per-dose body lines with their state markers, and the confirm/skip keyboard (#232/#380).",
  },
  {
    module: "lib/notifications/preventive-format.ts",
    why: "The preventive-care nudge's title and its done / not-applicable / remind-later keyboard (#1722 item 3).",
  },
  {
    module: "lib/notifications/food-format.ts",
    why: "The food nudge: window title, the served-today tally line, the time-correction hint and the show-more/less view controls (#1016/#1710/#1807).",
  },
  {
    module: "lib/notifications/food.ts",
    why: "The food-logging opt-in prompt and its enable button (#682).",
  },
  {
    module: "lib/notifications/workout-format.ts",
    why: "The workout nudge: the recommendation title in each of its states (rest, on-track, planned) and the how-to control (#2012).",
  },
  {
    module: "lib/notifications/workout-presence.ts",
    why: "The post-workout dose prompt and the still-working-out nudge with its finish/discard controls (#560/#1205).",
  },
  {
    module: "lib/notifications/workout-recap-format.ts",
    why: "The post-workout finish nudge and its per-discipline session labels (#981/#1122).",
  },
  {
    module: "lib/notifications/escalation.ts",
    why: "The missed-dose escalation (#615) — the safety message that owns the confirmed / acknowledged distinction this registry declines to collapse.",
  },
  {
    module: "lib/notifications/refill.ts",
    why: "The refill nudge's title and its 'Ordered' button (#233).",
  },
  {
    module: "lib/notifications/supply-pool.ts",
    why: "The shared-supply shortage notice — the pooled twin of the refill nudge, which is why it must speak the same resupply glyph.",
  },
  {
    module: "lib/notifications/redose.ts",
    why: "The PRN redose notice's log-dose control (#798).",
  },
  {
    module: "lib/redose-format.ts",
    why: "The PRN redose notice's title and body (#798) — the pure formatter behind the module above.",
  },
  {
    module: "lib/notifications/followup.ts",
    why: "The overdue safety follow-up escalation's title (#1866).",
  },
  {
    module: "lib/notifications/illness-care.ts",
    why: "The logged-symptom duration/trajectory care finding's title (#805).",
  },
  {
    module: "lib/notifications/temp-red-flag.ts",
    why: "The fever-check red-flag finding's title (#859) — one of the three surfaces the thermometer's encoding split ran across.",
  },
  {
    module: "lib/notifications/ease-back.ts",
    why: "The one-shot post-illness ease-back note's title (#837).",
  },
  {
    module: "lib/notifications/mood.ts",
    why: "The opt-in daily wellbeing check-in's title (#992).",
  },
  {
    module: "lib/notifications/practices.ts",
    why: "The wellness-practice check-in: title, per-practice log buttons and the overflow caution (#1259/#1895).",
  },
  {
    module: "lib/notifications/household-round-format.ts",
    why: "The household round's title, per-member section headers and confirm buttons (#1719).",
  },
  {
    module: "lib/notifications/offer-tail.ts",
    why: "The digest's guaranteed 'Log other…' access tail and its expanded per-item labels (#1505/#1819).",
  },
  {
    module: "lib/notifications/correction-rows.ts",
    why: "The time-correction picker's chips, its statement of record, and the back control that restores the message it replaced (#2264).",
  },
  {
    module: "lib/notifications/telegram-time-correction.ts",
    why: "The confirmations a time correction sends back (#2264).",
  },
  {
    module: "lib/notifications/callback-data.ts",
    why: "The typed OUTCOME text for every inline action in the product — the single largest concentration of state glyphs, and the place a confirmation's glyph has to match the marker the list will show afterwards.",
  },
  {
    module: "lib/notifications/telegram-callbacks.ts",
    why: "The in-place message replacements a tap leaves behind (#1945).",
  },
  {
    module: "lib/notifications/telegram-quick-log.ts",
    why: "The on-demand command replies (#1895): the PRN, symptom, temperature, food, practice, mood and weight prompts and their outcomes.",
  },
  {
    module: "lib/notifications/telegram-api.ts",
    why: "The transport's own truncation caution, appended when a keyboard ran out of room for every button — the one message line composed below the builders.",
  },
  {
    module: "lib/notifications/home-assistant.ts",
    why: "The Home Assistant webhook test message — the one send whose entire content is a confirmation that the channel works.",
  },
  {
    module: "lib/notifications/reconcile-registry.ts",
    why: "The reconcile families' declarations. It produces no message text, but its prose QUOTES button labels — registered so those quotes are a reviewed exemption with a reason rather than an unexamined place for the vocabulary to drift out of sync with the buttons it describes.",
  },
  {
    module: "lib/administration-format.ts",
    why: "The PRN administration confirmations (#797).",
  },
  {
    module: "lib/protein-nudge.ts",
    why: "The protein quick-add button labels (#824).",
  },
  {
    module: "lib/milestones-db.ts",
    why: "The milestone notification's title (#221).",
  },
  {
    module: "lib/wear-reminder.ts",
    why: "The opt-in bedtime wear reminder's title (#2161).",
  },
  {
    module: "lib/digest-time-suggestion.ts",
    why: "The digest time suggestion's line and its accept / snap / decline controls (#2216/#2217).",
  },
  {
    module: "lib/queries/recent-changes.ts",
    why: "The recent-changes lines (#1713) — composed here and rendered verbatim in the digest's New section and the household member card, which is why its glyphs are digest glyphs.",
  },
];
