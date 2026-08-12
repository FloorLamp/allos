import { IconArrowDown } from "@tabler/icons-react";
import type { Finding } from "@/lib/findings";
import {
  acceptDemotionSuggestion,
  dismissDemotionSuggestion,
} from "./intake-actions";
import DemotionSuggestionRow from "./DemotionSuggestionRow";

// Priority DEMOTION SUGGESTIONS (issue #1505 part 2) on the Supplements page: a
// high/mandatory supplement whose scheduled doses have gone sustainedly untaken,
// offered — never applied — for the `low` tag.
//
// Deliberately NOT rendered through the shared FindingsList: every other coaching
// card is dismiss-only, and this one carries a second, CONSEQUENTIAL affordance (the
// accept that writes obligation). It reuses FindingsList's card shape and the same
// suppression bus, but its own row so the accept button can render its typed outcome
// instead of the silent dismiss-only form.
//
// Nothing renders when no suggestion is firing — silence is the normal state.
export default function DemotionSuggestions({
  findings,
}: {
  findings: Finding[];
}) {
  if (findings.length === 0) return null;
  return (
    <div className="card" data-testid="demotion-suggestions">
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
        <IconArrowDown
          className="h-4 w-4 shrink-0 text-brand-500"
          stroke={2}
          aria-hidden="true"
        />
        Priority check
      </h2>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        Items you&rsquo;ve stopped taking that you&rsquo;re still on the hook
        for. Marking one low keeps its schedule and its tracking — it just stops
        pushing.
      </p>
      <ul className="space-y-3">
        {findings.map((f) => (
          <DemotionSuggestionRow
            key={f.dedupeKey}
            finding={f}
            acceptAction={acceptDemotionSuggestion}
            dismissAction={dismissDemotionSuggestion}
          />
        ))}
      </ul>
    </div>
  );
}
