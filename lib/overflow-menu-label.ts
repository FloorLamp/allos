// THE NAME AN ACTION SHEET GOES BY (#3501).
//
// `components/OverflowMenu.tsx` has always carried the rule in a comment: "The
// trigger's accessible name names the row these actions belong to ('Medication
// actions', 'Actions for …'), which is exactly the heading the sheet owes a viewer
// who can no longer see the row it came from." Nine callers followed it. The rest
// passed a generic string — "More actions", "Activity actions", "Snooze or
// dismiss" — and the sheet rendered the generic string as its only identity.
//
// That mattered more once #3374 forked the popover into a bottom SHEET below `md`.
// A popover is anchored under the kebab it came from, so the row is still on
// screen and answers for it. A sheet detaches: "Snooze 1 week" hovering over a
// five-row list answers to nothing.
//
// SO THE SENTENCE LIVES HERE, ONCE, AND THE COMPONENT'S PROPS ASK FOR ITS PARTS
// RATHER THAN FOR THE FINISHED STRING. A `label: string` prop can only ever be
// obeyed by convention — nine callers did and nineteen did not, and nothing could
// tell them apart. `itemName` is a required prop, so a menu cannot be mounted
// without naming the thing it acts on, and the phrasing cannot drift because no
// call site writes it.
//
// `kind` is optional and is the row's noun, not a decoration: a display name on
// its own can be ambiguous across surfaces ("Actions for Vitamin D" — the
// supplement, the bottle in the cabinet, or the lab result?), and the kind is what
// the reader already sees in the section around the row. It also keeps the app's
// existing vocabulary ("Medication actions", "Result actions") intact as the
// leading words of the new name.
export function overflowMenuLabel(itemName: string, kind?: string): string {
  const name = itemName.trim();
  const noun = kind?.trim();
  // An empty name is a caller bug, not a shape to render: falling back to the kind
  // alone keeps the name honest ("Medication actions") instead of shipping a
  // dangling "Actions for " to a screen reader. The source guard
  // (lib/__tests__/overflow-menu-identity.test.ts) is what keeps a caller from
  // choosing this path on purpose.
  if (!name) return noun ? `${noun} actions` : "Actions";
  return noun ? `${noun} actions for ${name}` : `Actions for ${name}`;
}
