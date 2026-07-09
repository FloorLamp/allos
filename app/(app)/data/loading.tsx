// Data page loading skeleton — header, tab strip, and a content block.
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-24 rounded bg-slate-200 dark:bg-ink-800" />
        <div className="mt-2 h-4 w-80 rounded bg-slate-200 dark:bg-ink-800" />
      </div>
      <div className="mb-4 flex gap-2">
        <div className="h-9 w-24 rounded-lg bg-slate-200 dark:bg-ink-800" />
        <div className="h-9 w-24 rounded-lg bg-slate-200 dark:bg-ink-800" />
      </div>
      <div className="card h-72" />
    </div>
  );
}
