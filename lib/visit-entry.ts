// Pure decision logic behind the single "Add visit" entry on the Visits page
// (issue #566). The page keeps two tables and two form components — appointments
// (future, scheduling) and encounters (past, clinical) — but unifies the ENTRY
// POINT: one affordance that branches on tense so a user never has to know "which
// form do I use?". This module owns the branch decision so both the wrapper and a
// unit test agree on it ("one question, one computation").

export type VisitTense = "upcoming" | "past";

// Which visit shape a chosen date implies. A future OR today date books an
// appointment ("upcoming"); a strictly past date logs an encounter ("past").
// Today defaults to "upcoming" — a fresh entry is most often a scheduling action,
// and it keeps the deep-link / Book-CTA default on the appointment branch. ISO
// yyyy-mm-dd strings sort chronologically, so a plain string compare is correct.
export function visitTenseForDate(date: string, today: string): VisitTense {
  return date >= today ? "upcoming" : "past";
}

// The entry's initial branch. Any prefill / deep-link is inherently a future
// booking, so it forces the appointment branch regardless of the seeded date:
//   • a preventive "Book" CTA (issue #85) arrives with a title/kind prefill,
//   • the command palette's "Add appointment" (issue #29) arrives with ?new=1.
// With neither present the chosen date decides via visitTenseForDate.
export function initialVisitTense(opts: {
  hasPrefill: boolean;
  focusNew: boolean;
  date: string;
  today: string;
}): VisitTense {
  if (opts.hasPrefill || opts.focusNew) return "upcoming";
  return visitTenseForDate(opts.date, opts.today);
}
