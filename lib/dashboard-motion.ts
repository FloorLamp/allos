// WITNESSED CHANGES ONLY — which Now cards may animate (#3253 decision 4).
//
// Motion on this surface makes one claim: "this just moved". A reading that gets
// promoted while you are looking at the page has moved in front of you, and the lift
// into Now is worth drawing. The SAME diff arriving because you came back to a tab
// you left two hours ago has not: nothing moved while you were there, and animating
// it asserts something false about a change you were not present for.
//
// So the rule is not "did the card set change" — it is "did it change WHILE WATCHED".
// Three inputs decide it and they are all the caller's observations, kept out here so
// the decision is unit-tested rather than eyeballed through a browser:
//
//   • `previous` — the ids from the last render, or NULL on the very first one. The
//     first paint NEVER animates. That is not a special case bolted on: a fresh
//     page load (a reload, a resume that re-navigates, the first visit) has no
//     "before" the viewer saw, so there is nothing for motion to be about.
//   • `hiddenSinceLast` — whether the document was hidden at any point between the
//     two renders. This is the resume half of the rule. It is WIRED but effectively
//     dormant: nothing refreshes this page in place today, so no in-place diff can
//     currently arrive across a hidden interval. #3075's silent refresh is what makes
//     the branch reachable, and the branch is here so that refresh lands quiet by
//     construction instead of needing this argued again later.
//   • `pageVisible` — the state at the moment of the change. A diff that lands while
//     the tab is in the background is the same false claim.
//
// Deliberately NOT View Transitions. `data-candidate-id` gives every card a stable
// identity across renders, so the platform could glide the resume case for free —
// and gliding the resume case is precisely what the witnessed-only rule refuses
// (#3253 records this so it is not re-derived).
//
// Pure: no DOM, no clock, no React.

export interface NowMotionInput {
  /** Card ids from the previous render, in order. NULL on first render. */
  previous: readonly string[] | null;
  /** Card ids for the render now landing, in order. */
  next: readonly string[];
  /** Was the document hidden at any point since the previous render? */
  hiddenSinceLast: boolean;
  /** Is the document visible right now? */
  pageVisible: boolean;
  /** Did the viewer ask for reduced motion? Then nothing animates, ever. */
  reduceMotion: boolean;
}

export interface NowMotionVerdict {
  /** The card ids that arrived in front of the viewer and may animate. */
  animate: readonly string[];
  /**
   * Whether Now just BECAME empty in front of the viewer — the "Nothing needs you."
   * sentence fading in as the last card resolves. It is the same witnessed test: an
   * empty strip on arrival is a fact, not an event.
   */
  emptyArrived: boolean;
}

const QUIET: NowMotionVerdict = { animate: [], emptyArrived: false };

export function witnessedNowMotion(input: NowMotionInput): NowMotionVerdict {
  const { previous, next, hiddenSinceLast, pageVisible, reduceMotion } = input;
  // Reduced motion is a DESIGNED state, not a degradation: the new card is simply
  // there on the frame it lands. Same end state, no keyframe scheduled.
  if (reduceMotion) return QUIET;
  if (previous === null) return QUIET;
  if (hiddenSinceLast || !pageVisible) return QUIET;
  const before = new Set(previous);
  return {
    animate: next.filter((id) => !before.has(id)),
    emptyArrived: previous.length > 0 && next.length === 0,
  };
}
