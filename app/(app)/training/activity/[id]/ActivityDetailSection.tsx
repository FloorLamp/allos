export function ActivityDetailSectionNavigation({
  sections,
}: {
  sections: { id: string; label: string }[];
}) {
  if (sections.length < 2) return null;
  return (
    <nav
      aria-label="Activity sections"
      className="mb-5 flex rounded-lg bg-slate-100 p-1 dark:bg-ink-800"
      data-testid="activity-section-navigation"
    >
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-center text-xs font-semibold text-slate-600 transition hover:bg-white hover:text-brand-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-300 dark:hover:bg-ink-700 dark:hover:text-brand-300 sm:text-sm"
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}

export function ActivityDetailSectionHeading({
  children,
  first = false,
}: {
  children: string;
  first?: boolean;
}) {
  return (
    <div className={`mb-3 flex items-center gap-3 ${first ? "" : "mt-7"}`}>
      <h2 className="section-label shrink-0">{children}</h2>
      <span
        aria-hidden="true"
        className="h-px flex-1 bg-black/5 dark:bg-white/10"
      />
    </div>
  );
}
