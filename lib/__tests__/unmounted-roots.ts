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
// after all.
//
// EMPTY SINCE #2957, and that is the state to keep it in: its one entry recorded
// `components/illness/SymptomLogCard.tsx` as dead pending a decision to delete it,
// and that deletion has now happened. Empty means no permitted dead ends on the
// chains this walk takes — every new one is a finding. It seeds only from stamping
// controls, so an orphan file that stamps nothing is outside its reach, not absent.
export const UNMOUNTED_ROOTS: Record<string, string> = {};
