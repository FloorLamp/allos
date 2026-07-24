// The pure model for the recomposed "How are you today?" check-in card (issue #1314).
// The card's four intents become its structure — Rate / Context / Report / Act —
// under ONE CheckInSection grammar, and each section renders a live one-liner at rest
// so the card reads as a status panel and opens only for input. Those summary lines
// are FORMATTERS over the SAME data each section's expansion edits (#221 — no second
// derivation), so they live here, pure and unit-tested, next to the merged-chip model
// that #1311 folds in. No DB, no React.
//
// The four sections, in fixed order:
//   1. Rate    — the hero face row (one tap completes the check-in) + the expansion
//                (Energy, the relevance-gated Calm #1313, a note).
//   2. Context — the merged "What's going on?" chip group (#1311): sticky situations
//                ∪ today-only work/social day-factors, ONE group, two write paths.
//   3. Report  — the illness door ("Not feeling well?" is a report, not a sibling);
//                defers to the hero cockpit while an episode is active.
//   4. Act     — the PRN meds quick-log slot (#1221 fold-in).

import { moodLabel } from "./mood";

export type CheckInSectionId = "rate" | "context" | "report" | "act";

// ---- Rate summary ------------------------------------------------------------

export interface RateSummaryInput {
  valence: number | null;
  energy: number | null;
  // The DISPLAY slot of the Calm scale (already relabeled #1313), or null. Only
  // meaningful when the scale is relevant; the caller passes null when gated out.
  calmDisplay: number | null;
}

// The Rate section's collapsed one-liner. Unlogged → the invitation; logged → the
// rating plus any expansion detail the user has filled, so the collapsed card still
// tells them what today holds.
export function rateSummary(input: RateSummaryInput): string {
  if (input.valence == null) return "Tap to log your day.";
  const parts = [moodLabel(input.valence)];
  if (input.energy != null) parts.push(`energy ${input.energy}`);
  if (input.calmDisplay != null) parts.push(`calm ${input.calmDisplay}`);
  return parts.join(" · ");
}

// ---- Context: the merged "What's going on?" chip group (#1311) ---------------

// One chip in the merged group. `sticky` chips (situations) stay until cleared;
// `day` chips (work/social factors) are recorded on today's mood log and reset at
// midnight — the visibility invariant (#1311) becomes a component-consumable prop,
// never per-surface styling, so a user never thinks "Work" persists or "Travel"
// clears overnight.
export type ChipVariant = "sticky" | "day";

export interface ContextChip {
  // A stable key for React + testids. For a sticky chip it's the situation name; for
  // a day chip it's the factor slug.
  key: string;
  label: string;
  active: boolean;
  variant: ChipVariant;
}

export interface ContextGroupInput {
  // The non-illness situation options (name + active), the sticky half.
  situations: { name: string; active: boolean }[];
  // The surviving mood-only day-factors (slug + label + active), the today half.
  dayFactors: { slug: string; label: string; active: boolean }[];
}

export interface ContextGroup {
  sticky: ContextChip[];
  day: ContextChip[];
}

// Partition the two chip sources into ONE group's two variant-tagged halves. The
// rendering is one group with an "Ongoing / Just today" split; this is the model it
// maps over so the two write paths (setActiveSituations for sticky, the mood-factor
// path for day) stay correctly routed by `variant`.
export function contextGroup(input: ContextGroupInput): ContextGroup {
  return {
    sticky: input.situations.map((s) => ({
      key: s.name,
      label: s.name,
      active: s.active,
      variant: "sticky" as const,
    })),
    day: input.dayFactors.map((f) => ({
      key: f.slug,
      label: f.label,
      active: f.active,
      variant: "day" as const,
    })),
  };
}

// Whether the Context section has any chips at all (both sources empty → the section
// is omitted, the same zero-footprint-when-unused posture the old disclosure had).
export function contextGroupHasChips(group: ContextGroup): boolean {
  return group.sticky.length > 0 || group.day.length > 0;
}

// The Context section's collapsed one-liner: the ACTIVE context (situations then
// today-factors, in that order), or the calm empty state. A formatter over the same
// group the expansion toggles.
export function contextSummary(group: ContextGroup): string {
  const active = [
    ...group.sticky.filter((c) => c.active),
    ...group.day.filter((c) => c.active),
  ].map((c) => c.label);
  return active.length > 0 ? active.join(" · ") : "Nothing noted.";
}

// ---- Report summary ----------------------------------------------------------

// The Report section's collapsed one-liner. While an episode is active the section
// defers to the hero cockpit; otherwise it's the calm well-day rest state.
export function reportSummary(activeEpisode: boolean): string {
  return activeEpisode ? "Illness tracked above." : "Feeling well.";
}

// ---- Act (PRN meds) summary --------------------------------------------------

// The Act section's collapsed one-liner. Formatter over the count of active PRN meds
// the section's quick-log lists; zero → the section is omitted upstream, so this only
// formats the present case.
export function actSummary(prnCount: number): string {
  if (prnCount <= 0) return "No PRN meds.";
  return `${prnCount} PRN ${prnCount === 1 ? "med" : "meds"}`;
}
