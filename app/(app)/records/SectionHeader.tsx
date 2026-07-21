// Per-section header used inside a STACKED Health-record pane (#1079). A stacked
// pane (Problems = Conditions + Allergies; Care › Overview = Background + Family
// history + Care plan + Health goals) renders its 2–4 sections with their existing
// headers so each is distinguishable; a SOLO pane needs no header (the tab strip
// names it) and uses `SectionSubtitle` for its descriptive line instead.

export function SectionHeader({
  id,
  title,
  subtitle,
}: {
  id?: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div id={id} className="mb-6 scroll-mt-24">
      <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
        {title}
      </h2>
      <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {subtitle}
      </div>
    </div>
  );
}

// The descriptive line for a SOLO pane (the tab strip already provides the title).
export function SectionSubtitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
      {children}
    </p>
  );
}
