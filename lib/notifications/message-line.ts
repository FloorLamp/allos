// THE MESSAGE-LINE GRAMMAR, as a type (issue #2391).
//
// `docs/internals/notifications.md` has documented the grammar of a system-initiated
// message line since #1913/#2048 — "glyph title — because · dueText, each part declared
// rather than inferred" — and nothing implemented it. Every producer interpolated its own
// `—` and `·`, so the grammar was a convention re-implemented at each call site and
// nothing could tell when a site stopped following it. The recap drifted furthest,
// composing with parentheses instead (#2389).
//
// WHY A TYPE AND NOT A JOIN HELPER. The digest's own bug is the argument. `${title} —
// ${detail}` silently assumed `detail` was a short CAUSE fragment; that held for the
// integration producer and not for the portal producer, whose detail was a complete
// sentence re-containing the title, so the line said its imperative twice (#1913 item 6).
// A shared `join(parts, " · ")` would have produced that line just as happily — what
// fixed it was making `because` a DECLARED FIELD with a stated contract. So the shared
// thing here is a line SHAPE with named parts; the separators are a detail it happens to
// own. A producer holding a cause fragment and an expiry cannot pass them in the wrong
// roles, and a producer holding neither renders a bare head without inventing
// punctuation.
//
// THE GRAMMAR, in one sentence: a head, then declared qualifiers — the first introduced
// by an em dash, the rest separated by `·`.
//
//   [glyph ]head[ — q₁][ · q₂ · q₃ …][ link]
//
// The two grammars the repo had unify under it exactly:
//
//   digest  🙋 Run the portal tool for tbh — never checked · expires in 6 days
//   recap   • Workouts: 7 — strength 4, cardio 3 · 5 last week
//
// The prefix differs (a glyph saying WHO ACTS, versus a row label folded into the head)
// and is itself a declared part. Nothing needs two conventions and no third surface
// should have to guess which to copy.
//
// SCOPE IS DECLARED, NOT INFERRED — see MESSAGE_LINE_MODULES at the bottom of this file.

import { richFrom, type MessageBody, type RichPart } from "./rich-text";

// The two separators, named once. A caller never types either of them.
const LEAD = "—"; // em dash — introduces the FIRST qualifier
const SEP = "·"; // middle dot — separates the ones after it

// A message line, in its named parts. Generic over the part type so the same shape
// serves a plain line and a rich one (see RichMessageLine) — one grammar, two
// renderings, never two shapes.
//
// EVERY FIELD IS A ROLE, and the role is the point. Read the contracts: they are what a
// producer is asked for by the signature instead of inheriting from a renderer it would
// have to go and read.
export interface MessageLineParts<T> {
  // A leading marker rendered before the head, space-separated. In the digest it says
  // WHO ACTS (🔌 allos will retry versus 🙋 a person has to go do this, #1913 item 8);
  // elsewhere it is the section bullet. Absent ⇒ the line starts at the head.
  //
  // A VALUE, never a literal this type cares about. It is the seam a declared glyph
  // vocabulary lands on (#2392): swapping `glyph: "😴"` for `glyph: GLYPH.sleep` is a
  // value change at the call site with no signature change here, and every producer
  // migrated in #2391 already passes it as this field rather than concatenating it onto
  // a line — which is why that swap does not have to re-migrate any of them.
  //
  // And the line does not have to OWN it. A producer that returns parts while its
  // caller decides the marker leaves this absent and the call site spreads its own in
  // (`formatMessageLine({ glyph: "•", ...recapMessageLine(l) })`), so a section that
  // stamps one glyph across many producers still has exactly one place holding it.
  glyph?: T | null;
  // The subject: what the line is ABOUT. Required, always rendered, never punctuated by
  // the formatter. A row label belongs here folded into the head ("Workouts: 7"), which
  // is what makes the recap's grammar and the digest's the same grammar.
  //
  // THE HEAD IS OPAQUE, DELIBERATELY. It is one clause the producer writes, and this
  // type models no structure inside it — not the emphasized token a sentence turns on
  // ("Nothing logged for **Midday** today."), not a relative day, not a row label. Those
  // are what the clause SAYS; a role here would only be a copy template wearing a
  // grammar's clothes, and it would have to be re-invented per sentence shape. A rich
  // head takes a SEQUENCE of parts, so an emphasized token lands exactly where the
  // sentence needs it rather than where a slot decided.
  //
  // This is not the hole the old `${title} — ${detail}` join left open. That defect was
  // an unstated contract on a QUALIFIER — the join could not tell a cause fragment from
  // a finished sentence. The head has never been ambiguous: it is the whole subject
  // clause, always first, always unpunctuated. And a qualifier smuggled INTO a head is
  // exactly what lib/__tests__/message-line.test.ts fails a registered module for.
  head: T;
  // A short CAUSE FRAGMENT explaining the head — "weather fetch failed (503)", "never
  // checked". Rendered FIRST, introduced by the em dash.
  //
  // THE CONTRACT IS THE FIELD'S WHOLE REASON FOR EXISTING (#1913 item 6). A fragment,
  // deliberately written for this surface. NEVER a complete sentence, and never one that
  // re-states the head — that is the exact defect this field was extracted to make
  // impossible to reintroduce. A producer with a supporting sentence written for a card
  // has a `note`, not a `because`.
  because?: T | null;
  // Supporting facts that QUALIFY the head and are neither a cause nor a comparison: the
  // dose amount behind a reminder, the sleep stages behind a duration, the lifts behind a
  // PR count. Repeatable, rendered in the order given, `·`-separated. Fragments, same as
  // `because` — a note never restates the head either.
  //
  // THIS IS THE REPEATING GROUP, and nothing requires its entries to be heterogeneous.
  // A line whose tail is N facts of the SAME kind — "protein 84 g+ of 95 g · fiber 18 g+
  // of 38 g" — is N notes, not a second shape. The `·` between `because` and `deadline`
  // and the `·` between two nutrients are the same job: joining peer qualifiers of one
  // head. The named roles exist to pin CONTRACT and ORDER for the qualifiers that have
  // one; `notes` is the ordered slot for the qualifiers that are simply facts. A
  // per-item hedge ("+" for a floor figure) therefore stays inside its own note, which
  // is the only place it can be right when items disagree.
  //
  // Nullish entries are dropped, so a producer may pass conditionals positionally and
  // still get correct punctuation.
  notes?: readonly (T | null | undefined)[];
  // How the head compares to the SAME figure elsewhere or earlier — "5 last week", "up
  // from 62%". Its own role because the recap's whole #1935 lesson was that a comparison
  // and a note are not interchangeable, and the untyped slot that held both drifted into
  // five unrelated idioms.
  comparison?: T | null;
  // A real DEADLINE the head carries — "expires in 6 days". Rendered last, because a
  // deadline is the thing the reader checks after they know what the line is about.
  //
  // NEVER a CTA label and never a status phrase (#1913 item 7): a broken integration's
  // `dueText` is "Reconnect", and printing that here would invent a deadline it does not
  // have. A domain declares whether it carries one; the line does not guess.
  deadline?: T | null;
  // A trailing bare token — a deep link URL. Appended after a SPACE with no separator,
  // because a URL is not a qualifier of the head and punctuating it would glue
  // characters onto a link.
  link?: T | null;
}

// The plain-text line: the ordinary case.
export type MessageLine = MessageLineParts<string>;

// The rich line: the same named parts, each an inline rich fragment (a run, a span, or a
// sequence of them). Used where a channel supports emphasis — the protein nudge bolds
// its figure (#1822 item 4) — so the plain and the emphasized rendering can only ever
// differ in emphasis, never in what they claim or how they are punctuated.
export type RichMessageLine = MessageLineParts<RichPart | readonly RichPart[]>;

function isPresent<T>(part: T | null | undefined): part is T {
  if (part === null || part === undefined) return false;
  if (typeof part === "string") return part.trim().length > 0;
  if (Array.isArray(part)) return part.some((p) => isPresent(p));
  return true;
}

// The qualifiers of a line, in their declared order: cause, notes, comparison, deadline.
// Absent and blank parts are dropped, which is what lets a producer pass conditionals
// positionally without ever emitting an orphaned separator.
//
// Exported for surfaces that render the PARTS rather than a line of text — the recap
// card lays its annotation out as a styled span, so it takes the qualifiers and does its
// own layout while still getting the one ordering decision from here (#221).
export function messageLineQualifiers<T>(
  line: MessageLineParts<T>
): readonly T[] {
  return [
    line.because,
    ...(line.notes ?? []),
    line.comparison,
    line.deadline,
  ].filter(isPresent);
}

// Render a plain message line. The FIRST present qualifier takes the em dash and every
// later one takes the `·`; a line with no qualifier is its head alone, with no invented
// punctuation.
export function formatMessageLine(line: MessageLine): string {
  const head = [line.glyph, line.head]
    .filter(isPresent)
    .map((s) => s.trim())
    .join(" ");
  const quals = messageLineQualifiers(line).map((q) => q.trim());
  const tail = quals
    .map((q, i) => `${i === 0 ? LEAD : SEP} ${q}`)
    .join(" ")
    .trim();
  const link = isPresent(line.link) ? line.link.trim() : "";
  return [head, tail, link].filter((s) => s.length > 0).join(" ");
}

// Render a rich message line as a `MessageBody` a channel can carry directly (the
// renderers drop emphasis where the transport has none, keeping the words). Punctuated
// identically to formatMessageLine by construction — the two read the same parts through
// the same ordering, so the plain and the emphasized rendering of one line can only ever
// differ in emphasis.
export function formatRichMessageLine(line: RichMessageLine): MessageBody {
  const flat = (part: RichPart | readonly RichPart[]): RichPart[] =>
    Array.isArray(part) ? [...part] : [part as RichPart];
  const out: RichPart[] = [];
  const push = (parts: readonly RichPart[]) => {
    if (out.length > 0) out.push(" ");
    out.push(...parts);
  };
  if (isPresent(line.glyph)) push(flat(line.glyph));
  push(flat(line.head));
  messageLineQualifiers(line).forEach((q, i) => {
    push([i === 0 ? LEAD : SEP]);
    out.push(" ", ...flat(q));
  });
  if (isPresent(line.link)) push(flat(line.link));
  return richFrom(out);
}

// ---------------------------------------------------------------------------
// THE DECLARED SCOPE
// ---------------------------------------------------------------------------

// WHY THE SCOPE IS A LIST AND NOT A PATTERN. `·` and `—` are ordinary punctuation in
// this codebase: `lib/activity-import-details.ts` joins heart-rate samples with `·`, and
// UI strings, chart captions and page copy use both. Inferring scope from the
// punctuation would sweep all of that into one lowest-common-denominator abstraction and
// leave the scan full of noise nobody reads. Inferring it from a directory would be
// wrong in the other direction — `lib/weekly-recap.ts` composes a system-initiated
// message and does not live under `lib/notifications/`, while half of what does live
// there is transport, tokens and registries.
//
// So scope is DECLARED: a module in this list composes the body lines of a
// system-initiated message, and lib/__tests__/message-line.test.ts fails it for
// hand-assembling `—`/`·` into a line instead of going through the formatter. The
// allowlist there carries a written reason per survivor, in the shape the repo's other
// chokepoint scans use (STATEFUL_WRITE_TABLES, CROSS_PROFILE_SQL_MODULES, the
// telegram.ts outbound chokepoint).
//
// Adding a module here is how a new message surface opts IN. That is deliberate: the
// list is the reviewable record of what "a system-initiated message line" means today,
// and a producer that is genuinely something else (an inline keyboard button label, an
// AI prompt, a `·`-joined list of coequal facts) says so by not being on it — or, when
// it lives beside lines that are, by carrying an allowlist entry that states why.
export const MESSAGE_LINE_MODULES: readonly { module: string; why: string }[] =
  [
    {
      module: "lib/notifications/digest.ts",
      why: "The morning digest — the grammar's home surface (#1913/#2048). Its Today/Yesterday/Sleep/New sections are the largest set of message lines the app sends.",
    },
    {
      module: "lib/notifications/upcoming-digest.ts",
      why: "The digest's banded 'what's due' model and the named data-plumbing lines (#1685/#1757), including the title that names the profile.",
    },
    {
      module: "lib/weekly-recap.ts",
      why: "The weekly recap message (#32). The second system-initiated message a profile receives, and the surface that had drifted to a parenthesis grammar (#2389) — it is in scope precisely because it is not under lib/notifications/.",
    },
    {
      module: "lib/notifications/supplement-format.ts",
      why: "The dose reminder: per-dose body lines and the window title (#232/#380).",
    },
    {
      module: "lib/notifications/preventive-format.ts",
      why: "The preventive-care nudge's body line (#1722 item 3).",
    },
    {
      module: "lib/notifications/food-format.ts",
      why: "The protein nudge's status line (#1710/#1822) — the rich-text case, proving the emphasized rendering is punctuated by the same grammar.",
    },
    {
      module: "lib/notifications/reconcile-core.ts",
      why: "The closing sentence a reconciled pointer is edited down to (#2274/#2275).",
    },
    {
      module: "lib/notifications/correction-rows.ts",
      why: "The time-correction picker's question and the body's statement of record (#2264).",
    },
    {
      module: "lib/notifications/household-round-format.ts",
      why: "The household round's title and per-member section headers (#1719).",
    },
    {
      module: "lib/notifications/offer-tail.ts",
      why: "The digest's 'Log other…' tail (#1505). Registered so its keyboard-label separator is a REVIEWED exemption with a reason rather than an unexamined omission.",
    },
    {
      module: "lib/nutrition-day.ts",
      why: "The digest's yesterday nutrition line (#2379) — the homogeneous-tail case, where the head is a section noun and each short nutrient is one note. Registered although it is a domain module, because that is where the line's parts are composed; like lib/weekly-recap.ts it is in scope for what it produces, not for where it lives.",
    },
    {
      module: "lib/notifications/workout-recap-format.ts",
      why: "The post-workout finish nudge's weekly-status line (#981/#1122).",
    },
  ];
