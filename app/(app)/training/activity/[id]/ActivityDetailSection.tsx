export function ActivityDetailSectionHeading({
  children,
}: {
  children: string;
}) {
  return (
    <div className="mt-7 mb-3 flex items-center gap-3">
      <h2 className="section-label shrink-0">{children}</h2>
      <span
        aria-hidden="true"
        className="h-px flex-1 bg-black/5 dark:bg-white/10"
      />
    </div>
  );
}

export function ActivityDetailSectionNav({
  sections,
}: {
  sections: { id: string; label: string }[];
}) {
  // At least three optional sections: shorter records are easier to read
  // straight through than through another navigation row. The primary summary
  // sits above this navigation, so it does not need a redundant Overview link.
  if (sections.length < 3) return null;

  return (
    <nav
      aria-label="Activity sections"
      className="mt-4 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-black/5 py-2 text-sm dark:border-white/10"
      data-testid="activity-section-navigation"
    >
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          className="font-medium text-slate-600 transition hover:text-brand-700 hover:underline dark:text-slate-300 dark:hover:text-brand-300"
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}
