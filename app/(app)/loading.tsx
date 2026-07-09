// Default route-segment loading skeleton for the authenticated app (covers the
// dashboard and any page without its own loading.tsx). Simple pulse placeholders
// so navigation shows an instant frame instead of a blank pane.
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-48 rounded bg-slate-200 dark:bg-ink-800" />
        <div className="mt-2 h-4 w-72 rounded bg-slate-200 dark:bg-ink-800" />
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card">
            <div className="h-3 w-20 rounded bg-slate-200 dark:bg-ink-800" />
            <div className="mt-3 h-8 w-24 rounded bg-slate-200 dark:bg-ink-800" />
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="card h-64" />
        <div className="card h-64" />
      </div>
    </div>
  );
}
