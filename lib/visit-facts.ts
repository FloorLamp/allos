// The summary row of the visit pair — appointments (future) and encounters (past) —
// stated in the shared facts-with-editors grammar (#3218, #3223).
//
// ONE VOCABULARY, TWO TENSES. The two tables and their two Server Actions stay separate
// and untouched; only the FRONT DOOR unifies. So this module names the facts a visit has
// regardless of which store will hold it, and each form maps its own columns onto them:
// an appointment's `title` and an encounter's `reason` are the same fact ("what it's
// for"), as are `kind` and `type`. A reader comparing the two forms should find one set
// of nouns, not two dialects for the same six questions.
//
// THE TENSE IS A DERIVED FACT OF THE DATE, not a question asked before the form opens
// (#3223). `lib/visit-entry.ts` already owned that computation for the old upfront
// toggle and still does — this module does NOT re-derive it. One question, one
// computation: a second copy here is exactly the parallel concept the project rules
// forbid, and the two would drift the first time "today counts as upcoming" was revisited.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states — which facts the row states
// and which it prompts for — never this file's wording.
//
// Pure: no React, no DB, no clock. Both forms are renderers over `visitFactSummary`.

import {
  DEFAULT_FORMAT_PREFS,
  formatClockValue,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import {
  APPOINTMENT_KIND_LABELS,
  isAppointmentKind,
} from "./preventive-appointment";
import type { AppointmentKind } from "./types";

// The facts a visit states, in the order the row draws them. `provider` leads because it
// is the SEEDING PICK (#3218's contract: the chips follow the pick) — a provider carries
// a specialty and an address, so choosing one answers two of the chips behind it.
export type VisitFactKey =
  "provider" | "kind" | "when" | "reason" | "location" | "notes" | "diagnoses";

export type VisitFactState = "stated" | "missing";

export interface VisitFactChip {
  key: VisitFactKey;
  /** The sentence this chip states. */
  label: string;
  state: VisitFactState;
  /**
   * The value was supplied FOR the person — seeded from the provider they picked, or
   * from a follow-up prefill — rather than stated by them (#846). An editable
   * suggestion, and the chip has to say so.
   *
   * Absent when this surface does not track suggestion for that fact at all, which is
   * different from tracking it and finding it false (see FactChipRow's `suggestedAttrs`).
   */
  suggested?: boolean;
}

export interface VisitFactSummary {
  /** The facts with something to state, plus any MISSING essential, in reading order. */
  chips: VisitFactChip[];
  /**
   * The optional facts with nothing to state. They render no chip at all and are reached
   * through the one trailing affordance, whose label NAMES them so "more" never means
   * "somewhere in here".
   */
  absent: VisitFactKey[];
}

// The nouns, so the trailing affordance can name what it holds and a missing essential
// can prompt for itself in the same words.
export const VISIT_FACT_NOUNS: Record<VisitFactKey, string> = {
  provider: "provider",
  kind: "kind",
  when: "date",
  reason: "reason",
  location: "location",
  notes: "notes",
  diagnoses: "diagnoses",
};

/**
 * What the trailing affordance says. Names the facts it holds, in row order.
 * Returns null when nothing is absent — the affordance does not render at all then.
 */
export function moreFactsLabel(absent: readonly VisitFactKey[]): string | null {
  if (absent.length === 0) return null;
  const nouns = absent.map((k) => VISIT_FACT_NOUNS[k]);
  if (nouns.length === 1) return `Add ${nouns[0]}`;
  const last = nouns[nouns.length - 1];
  return `Add ${nouns.slice(0, -1).join(", ")} or ${last}`;
}

/**
 * What the when-chip says: "Mar 3 · 10:00" with a time, a bare "Mar 3" without one.
 *
 * THE DAY-VS-DATETIME HONESTY (#2234) IS THE WHOLE POINT OF THE BRANCH. A visit stores
 * its day and its optional wall-clock time in two columns and never folds them into one
 * instant, because a clinic day with no appointment time is a DAY — rendering it as
 * "Mar 3 · 00:00" would state a midnight nobody entered. So a chip with no time stays a
 * day, and the absence reads as absence rather than as a fabricated hour.
 */
export function visitWhenLabel(
  date: string,
  time: string | null | undefined,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS,
  opts: { today?: string } = {}
): string {
  const day = formatMonthDay(date, prefs, opts);
  const clock = formatClockValue(time, prefs.timeFormat);
  return clock ? `${day} · ${clock}` : day;
}

// ── THE PROVIDER SEEDING PICK ────────────────────────────────────────────────
//
// Picking a provider answers two more chips: the registry row carries a SPECIALTY and an
// ADDRESS, so "Dr. Chen, Dermatology, 4 Bay St" states the provider, proposes the kind
// and proposes the location. That is what makes the pair a two-tap confirm rather than a
// six-field form.
//
// SEEDED IS NOT STATED. Everything this produces is marked `suggested` and is editable
// before saving — the app proposes, the person confirms (#846). A wrong guess costs one
// tap on a chip that already says what it will write.
//
// THE MAP IS DELIBERATELY SMALL AND FALLS BACK TO null. A specialty this does not
// recognise seeds NOTHING rather than "other": "other" is a kind the person might mean,
// and inventing it would put a fact on the row they never chose. Matching is on the
// human display string because that is what the registry reliably carries — the NUCC
// `specialty_code` is present only for imported rows.
const SPECIALTY_KIND_HINTS: { match: RegExp; kind: AppointmentKind }[] = [
  { match: /\bdent|\borthodont|\bperiodont/i, kind: "dental" },
  { match: /\boptom|\bophthalm|\bvision|\beye\b/i, kind: "vision" },
  { match: /\baudiolog|\bhearing\b|\botolaryngolog/i, kind: "hearing" },
  {
    match:
      /\bpsychiatr|\bpsycholog|\bmental health\b|\bbehavioral health\b|\bcounsel|\btherapist\b/i,
    kind: "mental_health",
  },
  { match: /\bpediatric/i, kind: "well_child" },
  {
    match:
      /\bfamily (medicine|practice)\b|\binternal medicine\b|\bgeneral practice\b|\bprimary care\b/i,
    kind: "physical",
  },
];

/**
 * The appointment kind a provider's specialty proposes, or null when it proposes none.
 *
 * Null is the common and correct answer — see the note above the table. A caller must
 * treat a null as "leave the kind chip alone", never as a reason to write "other".
 */
export function specialtyToAppointmentKind(
  specialty: string | null | undefined
): AppointmentKind | null {
  const text = specialty?.trim();
  if (!text) return null;
  for (const hint of SPECIALTY_KIND_HINTS) {
    if (hint.match.test(text)) return hint.kind;
  }
  return null;
}

/** The label for a stored kind value, for the chip. Unknown/blank values state nothing. */
export function appointmentKindLabel(
  kind: string | null | undefined
): string | null {
  const k = kind?.trim();
  if (!k) return null;
  // The narrowing guard, not a membership test on the runtime array: the same question
  // asked once, in the module that owns the vocabulary.
  return isAppointmentKind(k) ? APPOINTMENT_KIND_LABELS[k] : null;
}

// ── THE SUMMARY ──────────────────────────────────────────────────────────────

export interface VisitFactInput {
  /** Which store will hold this, derived from the date by `lib/visit-entry.ts`. */
  tense: "upcoming" | "past";
  /** Required. The row cannot be written without it, so its chip is never absent. */
  date: string;
  /** Optional wall-clock HH:MM. Blank keeps the when-chip a bare day (#2234). */
  time: string;
  /** An appointment's `title`; an encounter's `reason`. */
  reason: string;
  /**
   * An appointment's `kind` (a closed vocabulary) or an encounter's `type` (free text
   * over a suggested list). Already the value the form will post.
   */
  kind: string;
  provider: string;
  location: string;
  notes: string;
  /** Encounters only. Undefined on the appointment branch, which has no such column. */
  diagnoses?: string;
  /** Facts whose current value the app proposed rather than the person stating it. */
  seeded?: Partial<Record<VisitFactKey, boolean>>;
  prefs?: DisplayFormatPrefs;
  today?: string;
}

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 *
 * THE ONE ESSENTIAL IS `when`. Both actions reject a visit with no date and both forms
 * already refuse to submit without one, so the date is the single fact whose absence is
 * a MISSING chip — dashed, on the row, saying what to add — rather than something tucked
 * away. Every other fact is genuinely optional in the store, so an empty one renders no
 * chip at all and is reached through the trailing affordance.
 */
export function visitFactSummary(f: VisitFactInput): VisitFactSummary {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const seeded = f.seeded ?? {};
  const chips: VisitFactChip[] = [];
  const absent: VisitFactKey[] = [];

  // A fact with a value states it; an empty optional goes behind the trailing chip.
  const state = (key: VisitFactKey, value: string, label: string) => {
    if (value.trim()) {
      chips.push({
        key,
        label,
        state: "stated",
        // A MISSING chip carries no marking by contract, and a stated fact this surface
        // never seeds is tracked-and-false rather than untracked — so the boolean is
        // always supplied here, and never `undefined`.
        suggested: seeded[key] === true,
      });
    } else {
      absent.push(key);
    }
  };

  state("provider", f.provider, f.provider.trim());

  // The kind reads back in its human label where the closed appointment vocabulary has
  // one; an encounter's free-text type states itself as typed.
  const kindLabel = appointmentKindLabel(f.kind) ?? f.kind.trim();
  state("kind", f.kind, kindLabel);

  if (f.date.trim()) {
    chips.push({
      key: "when",
      label: visitWhenLabel(f.date, f.time, prefs, { today: f.today }),
      state: "stated",
      suggested: seeded.when === true,
    });
  } else {
    // The one essential. Dashed and on the row, because a visit with no date cannot be
    // written at all and hiding that behind "more" would let someone reach Save with a
    // form that must fail.
    chips.push({ key: "when", label: "Add a date", state: "missing" });
  }

  state("reason", f.reason, f.reason.trim());
  state("location", f.location, f.location.trim());

  // The notes MARKER, not the notes: a chip states a fact, and pasting a paragraph of
  // clinical notes into a chip row would state it at the row's expense. So the chip says
  // that notes exist and opens them.
  state("notes", f.notes, "Notes added");

  if (f.diagnoses !== undefined) {
    state("diagnoses", f.diagnoses, f.diagnoses.trim());
  }

  return { chips, absent };
}
