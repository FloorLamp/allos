import Link from "next/link";
import { EPISODES_HREF } from "@/lib/hrefs";

// The calm "see the household's illness history" link (issue #1009 Ask 2), now with a
// CONTEXTUAL home (issue #1549).
//
// It used to be its own full-width block on the dashboard, which put it between the
// reopen band and the household strip — three adjacent household-shaped bands in the
// just-recovered state, and, in the 8–14-day tail, a link floating context-free after
// the all-clear card once the illness hero that justified it was gone. The overlap was
// structural rather than incidental: the reopen window (7 days) is a strict SUBSET of
// the promo window (HOUSEHOLD_RECENTLY_SICK_DAYS = 14), so every reopen state also
// showed the promo.
//
// So the link became a ROW inside whichever household band is already on screen — the
// reopen band's footer when reopen lines are visible, the household strip's label row
// otherwise — and this component is the one definition both placements render, so the
// two can't drift into different copy or different destinations.
//
// UNCHANGED by that move, deliberately: the predicate that decides whether it appears
// at all (`accessible.length > 1 && isHouseholdRecentlySick(...)`, still evaluated on
// the page), the 14-day window, the href, and its no-dismiss / no-dedupeKey / not-a-
// finding nature. It appears because it's useful and disappears on its own.
//
// The `household-history-promo` testid is stable across both homes: a caller asserts
// WHERE it landed by which container it sits in, never by a different hook.
export default function HouseholdHistoryPromoLink() {
  return (
    <Link
      href={EPISODES_HREF}
      data-testid="household-history-promo"
      className="inline-flex items-center gap-2 text-sm font-medium text-sky-700 hover:underline dark:text-sky-300"
    >
      Episodes &amp; visits →
    </Link>
  );
}
