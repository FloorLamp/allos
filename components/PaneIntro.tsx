// The descriptive line for a SOLO pane inside a tab-first hub: the tab strip
// already supplies the title, so this h2 restates it at section scale and adds
// the one-line orientation the strip has no room for.
//
// Scale (#1449, cluster B): `text-lg font-semibold`, deliberately BELOW the page
// h1 that `PageHeader` draws and above a card's `font-semibold` h3 — exactly one
// h1-scale heading per page, and it is the PageHeader. On a tab-first hub that
// h1 is `sr-only` below `md`, which makes THIS the first visible heading on a
// phone; keeping it at section scale is what stops it reading as a second page
// title.
//
// Lives in components/ rather than under /records because Results' panes need
// the same line (#3236). The `testId` is the caller's because the marker names
// the hub, not the shape.
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
    <div className="mb-5" data-testid={testId}>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h2>
      <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>
    </div>
  );
}
