// Per-section header used inside a STACKED Health-record pane (#1079). Care ›
// Overview (Background + Family history + Care plan + Health goals) is the one
// remaining stacked pane — Problems un-stacked into two panes in #1449 — and
// renders its four sections with these headers so each is distinguishable; a SOLO
// pane needs no header (the tab strip names it) and uses `SectionSubtitle` for its
// descriptive line instead.
//
// Scale (#1449, cluster B): `text-lg font-semibold`, deliberately BELOW the page
// h1 that `PageHeader` draws (`text-xl`/`md:text-2xl` bold) and above a card's
// `font-semibold` h3. It used to be `text-2xl font-bold` — identical weight to the
// page title — so Care › Overview read as five competing h1s on one scroll with no
// hierarchy to tell you which one named the page. The rule this encodes: exactly
// one h1-scale heading per page, and it is the PageHeader.

export function SectionHeader({
  id,
  title,
  subtitle,
  more,
}: {
  id?: string;
  title: string;
  subtitle: string;
  more?: React.ReactNode;
}) {
  return (
    <div id={id} className="mb-4 scroll-mt-24">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h2>
      <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {subtitle}
      </div>
      {more ? <IntroMore>{more}</IntroMore> : null}
    </div>
  );
}

// The descriptive line for a SOLO pane (the tab strip already provides the title).
export function SectionSubtitle({
  title,
  children,
  more,
}: {
  title: string;
  children: React.ReactNode;
  more?: React.ReactNode;
}) {
  return (
    <div className="mb-5" data-testid="records-pane-intro">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h2>
      <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>
      {more ? <IntroMore>{more}</IntroMore> : null}
    </div>
  );
}

function IntroMore({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-1 text-sm text-slate-500 dark:text-slate-400">
      <summary className="cursor-pointer font-medium text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100">
        More
      </summary>
      <div className="mt-1" data-testid="records-pane-intro-more">
        {children}
      </div>
    </details>
  );
}
