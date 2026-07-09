// Journal loading skeleton — a header plus a few day-group card placeholders.
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-36 rounded bg-slate-200 dark:bg-ink-800" />
        <div className="mt-2 h-4 w-72 rounded bg-slate-200 dark:bg-ink-800" />
      </div>
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card">
            <div className="h-5 w-32 rounded bg-slate-200 dark:bg-ink-800" />
            <div className="mt-3 h-4 w-full rounded bg-slate-200 dark:bg-ink-800" />
            <div className="mt-2 h-4 w-2/3 rounded bg-slate-200 dark:bg-ink-800" />
          </div>
        ))}
      </div>
    </div>
  );
}
