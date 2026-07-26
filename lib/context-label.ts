// The one-line CONTEXT LABEL a collapsed phone chrome bar shows in place of its
// controls — "Overview · 90D" on Trends (#1485 F), "All · Through today" on the
// Timeline (#1517 B).
//
// It exists as a shared module for the separator, which is the only decision in it
// and the one thing two bars must not disagree about: a middot, not an en dash,
// because the halves are PEERS (which surface, which window / which filter) rather
// than the ends of a range. Each surface still owns which strings it names — see
// lib/trends-context.ts's activeRangeLabel for the interesting half of that job.

export const CONTEXT_LABEL_SEPARATOR = " · ";

// Join the parts a bar names, dropping empties so a surface with nothing to say in
// one half doesn't render a dangling separator.
export function contextLabel(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => Boolean(p))
    .join(CONTEXT_LABEL_SEPARATOR);
}
