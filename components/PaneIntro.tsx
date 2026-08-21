// The descriptive line for a SOLO pane inside a tab-first hub: the tab strip
// already supplies the title, so this h2 restates it at section scale and adds
// the one-line orientation the strip has no room for.
//
// Scale (#1449, cluster B): `text-lg font-semibold`, deliberately BELOW the page
// h1 that `PageHeader` draws and above a card's `font-semibold` h3 — exactly one
// h1-scale heading per page, and it is the PageHeader.
//
// ── BELOW `md` IT DRAWS NEITHER (owner decision, #3408) ──────────────────────
//
// The tension was already conceded in this file's own comment: `SectionSubtitle`
// exists because "the tab strip already provides the title", and this drew the
// title anyway. On a phone that cost about 120px of name-plus-read-once-copy
// directly under the chip that had JUST named the pane — the first visible
// heading on the page, because the hub's h1 is `sr-only` there — and it was the
// top of the stack that put the first Immunizations record roughly a full screen
// down. It is the same call `PageHeader.hideSubtitleBelowSm` already encodes for
// a page subtitle: orientation prose is read once, and a phone pays for it every
// visit.
//
// THE HEADING STAYS IN THE DOCUMENT, `sr-only`. "Renders neither" is about the
// PIXELS. A pane with no h2 at all would leave the phone's outline with a section
// of content under no heading — an assistive-tech reader navigating by heading
// would find the hub's `sr-only` h1 and then nothing until a card's h3 — and
// #1449's rule is about heading SCALE, not about deleting the level. So the title
// becomes invisible rather than absent, and the prose, which orients rather than
// names, is dropped outright.
//
// WIDTH-GATED IN CSS, NOT IN JS. Both branches are the same authored node with a
// different class; there is no second copy to drift and no hydration seam
// (components/useCompactViewport.ts says when a JS check is the right tool — a
// HOST decision — and this is not one).
//
// Lives in components/ rather than under /records because Results' panes need
// the same line (#3236), and landing the decision here is what gives them the
// behaviour with no Results-specific code. The `testId` is the caller's because
// the marker names the hub, not the shape.
export default function PaneIntro({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    // The wrapper's own bottom margin goes with the content it was spacing: an
    // element that renders nothing visible must not reserve room either (#2399's
    // rule, one level up from the empty states it was written for).
    <div className="mb-0 md:mb-5" data-testid={testId}>
      <h2 className="sr-only text-lg font-semibold text-slate-900 md:not-sr-only dark:text-slate-100">
        {title}
      </h2>
      <p className="hidden text-sm text-slate-500 md:block dark:text-slate-400">
        {children}
      </p>
    </div>
  );
}
