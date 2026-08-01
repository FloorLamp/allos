import { IconArrowDown } from "@tabler/icons-react";
import { today } from "@/lib/db";
import { getFindingSuppressions } from "@/lib/queries";
import { activeFindings } from "@/lib/findings";
import {
  collectRightSizeCandidates,
  rightSizeCandidateFinding,
} from "@/lib/rule-findings";
import type { RightSizeDomain } from "@/lib/target-rightsize";
import {
  acceptRightSizeLower,
  acceptRightSizeStop,
  dismissRightSizeSuggestion,
} from "@/app/(app)/rightsize-actions";
import RightSizeSuggestionRow from "./RightSizeSuggestionRow";

// Frequency-target RIGHT-SIZING suggestions (issue #1670) for ONE domain: weekly
// floors the profile has been under for four completed weeks, offered — never applied
// — for the cadence they actually keep, or for the domain's own no-expectation state.
//
// One component for all three domains (wellness practices, training routines, food
// habits) because there is one detector; only the heading and the stop-label differ,
// and both are read from the domain rather than re-decided per surface. The same
// component therefore renders on /wellness, /training?tab=goals and the Nutrition Food
// tab, which is the responsive/shared-content rule applied across surfaces.
//
// Deliberately NOT rendered through the shared FindingsList: every other coaching card
// is dismiss-only, and this one carries two further CONSEQUENTIAL affordances (the
// accepts that write a floor). It reuses FindingsList's card shape and the same
// suppression bus, but its own row so each button can render its typed outcome.
//
// Nothing renders when no suggestion is firing — silence is the normal state.

const DOMAIN_HEADING: Record<RightSizeDomain, string> = {
  practice: "Weekly goal check",
  training: "Weekly routine check",
  food: "Weekly habit check",
};

const DOMAIN_SUBTITLE: Record<RightSizeDomain, string> = {
  practice:
    "Practices you've been under for a month. Right-sizing one keeps every session you've logged — it just stops asking for more than you do.",
  training:
    "Routines you've been under for a month. Right-sizing one keeps every session you've logged — it just stops asking for more than you do.",
  food: "Habits you've been under for a month. Right-sizing one keeps your food log exactly as it is — it just stops asking for more than you do.",
};

export default async function RightSizeSuggestions({
  profileId,
  domain,
}: {
  profileId: number;
  domain: RightSizeDomain;
}) {
  const now = today(profileId);
  const candidates = collectRightSizeCandidates(profileId, now).filter(
    (c) => c.domain === domain
  );
  if (candidates.length === 0) return null;
  // The SAME suppression filter every other coaching surface applies, run over these
  // candidates' own Finding envelopes — so a dismiss here, on the coaching tab, or on
  // the dashboard rollup hides the suggestion on all of them.
  const live = new Set(
    activeFindings(
      candidates.map(rightSizeCandidateFinding),
      getFindingSuppressions(profileId),
      now
    ).map((f) => f.dedupeKey)
  );
  const rows = candidates.filter((c) => live.has(c.key));
  if (rows.length === 0) return null;

  return (
    <div className="card" data-testid="right-size-suggestions">
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
        <IconArrowDown
          className="h-4 w-4 shrink-0 text-brand-500"
          stroke={2}
          aria-hidden="true"
        />
        {DOMAIN_HEADING[domain]}
      </h2>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        {DOMAIN_SUBTITLE[domain]}
      </p>
      <ul className="space-y-3">
        {rows.map((c) => (
          <RightSizeSuggestionRow
            key={c.key}
            candidate={c}
            lowerAction={acceptRightSizeLower}
            stopAction={acceptRightSizeStop}
            dismissAction={dismissRightSizeSuggestion}
          />
        ))}
      </ul>
    </div>
  );
}
