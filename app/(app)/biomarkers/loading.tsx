// Biomarkers loading skeleton — header, filter bar, and a results-table block.
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-44 rounded bg-slate-200 dark:bg-ink-800" />
        <div className="mt-2 h-4 w-80 rounded bg-slate-200 dark:bg-ink-800" />
      </div>
      <div className="mb-6 flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-8 w-24 rounded-full bg-slate-200 dark:bg-ink-800"
          />
        ))}
      </div>
      <div className="card space-y-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-6 rounded bg-slate-200 dark:bg-ink-800" />
        ))}
      </div>
    </div>
  );
}
