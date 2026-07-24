// The condition-suggestion findings BUILDER (issue #685) — the DB gather that feeds
// the pure detector (lib/condition-suggestions.ts), per the #448 findings-builder
// discipline: it GATHERS DB state (the profile's CURRENT qualitative lab results + the
// existing problem list) and hands it to the pure engine, then maps the results into
// the shared UpcomingItem each surface renders. It owns no threshold logic and reads
// through the profile-scoped query layer, so the profile-scoping guard is unaffected.
//
// ONE gather (conditionSuggestionsFor), formatters over it (#221): the Upcoming item
// (→ Upcoming page + the non-hideable Needs-attention hero via buildAttentionModel),
// carrying the SAME dedupeKey as the pure suggestion, so a dismiss on any surface
// silences every surface through the shared bus ("dismiss once, silence everywhere").
//
// Care tier, deliberately (#449): a positive HIV/HCV/HBsAg seen only as a flag chip is
// the safety gap #685 names, so — like the illness-care builder — this is PUSH-shaped:
// its items band "today" so they reach the hero, and its dedupeKey prefix
// (CONDITION_REVIEW_PREFIX) is registered in RULE_FINDING_PREFIXES. It is SUGGEST-ONLY
// (#560): the item offers a confirm ("Add to conditions") the user clicks; the app
// never silently inserts a problem-list row. A NEW notification channel (Telegram
// push) is deliberately NOT added here — the review/Upcoming/hero surface is the scoped
// step; a push is a larger decision left to a follow-up.

import {
  suggestConditionsFromResults,
  conditionSuggestionTitle,
  conditionSuggestionDetail,
  type ConditionSuggestion,
} from "./condition-suggestions";
import { getCurrentQualitativeResults } from "./queries/medical";
import { getConditions } from "./queries/clinical";
import type { UpcomingItem } from "./upcoming";
import type { AppRoute } from "./hrefs";

// The ONE gather: the condition suggestions the profile's current qualitative results
// warrant, deduped against its problem list. Every surface formats over THIS.
export function conditionSuggestionsFor(
  profileId: number
): ConditionSuggestion[] {
  const readings = getCurrentQualitativeResults(profileId);
  if (readings.length === 0) return [];
  const existing = getConditions(profileId).map((c) => ({
    name: c.name,
    code: c.code,
  }));
  return suggestConditionsFromResults(readings, existing);
}

// The review destination the suggestion links to (the problem list). The inline
// "Add to conditions" confirm lives on the item; the title/CTA link points here so a
// user can review the full list in context.
const CONDITIONS_HREF: AppRoute = "/records/problems";

// The condition-suggestion review items for the Upcoming/hero surface. Banded "today"
// (care tier → the act-now slice of the attention model), suppressible through the
// shared bus by the suggestion's dedupeKey, and carrying the confirm payload the
// Upcoming page renders as an inline "Add to conditions" button.
export function conditionReviewItems(profileId: number): UpcomingItem[] {
  return conditionSuggestionsFor(profileId).map((s) => ({
    key: s.key,
    domain: "condition-review" as const,
    title: conditionSuggestionTitle(s),
    detail: conditionSuggestionDetail(s),
    href: CONDITIONS_HREF,
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
    actionLabel: "Review",
    conditionSuggestion: { name: s.name, code: s.code },
    // The "Add to conditions" confirm (confirmConditionSuggestion) writes to the ACTING
    // profile, not the row's subject — so on a multi-view page the shared row scaffolding
    // renders it ONLY on the acting profile's own row (issue #1327 fix 5). Declaring the
    // target here replaces the page-local `(!multi || isActing)` special case.
    writeTarget: "acting" as const,
  }));
}
