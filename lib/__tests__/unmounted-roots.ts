// FILES A MOUNT-GRAPH WALK MAY LEGITIMATELY DEAD-END AT (#3087/#3580).
//
// `lib/__tests__/logged-via-surface-wiring.test.ts` walks each stamping control up
// through its importers until a chain reaches a region root, a page, or the router.
// A chain that ends at a file NOTHING mounts is a finding, because "covered" and "I
// lost the thread" must not answer the same way — a missed barrel re-export looks
// exactly like a component that renders nowhere.
//
// A REGISTRY, NOT A FILTER: adding a line is a claim somebody has to write down and
// review, and `staleUnmountedRoots` fails if a registered file is gone or is mounted
// after all. It lives in its own module rather than inside that test because a SECOND
// guard pins one of these files and the two must not be able to disagree about
// whether it is dead — `lib/__tests__/episode-logbar-reuse.test.ts` reads
// `components/illness/SymptomLogCard.tsx`'s bytes and asserts on them, which is a
// perfectly green assertion about a component nothing renders (#3580 item 5).
export const UNMOUNTED_ROOTS: Record<string, string> = {
  "components/illness/SymptomLogCard.tsx":
    "dead code — no file in app/ or components/ imports it, confirmed by review on " +
    "PR #3560. Deleting it is out of that PR's scope, so it is registered rather " +
    "than removed; delete the component and this line together. " +
    "lib/__tests__/episode-logbar-reuse.test.ts pins this same file and says so.",
};
