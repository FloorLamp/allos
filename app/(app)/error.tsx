"use client";

// Route-segment error boundary for the authenticated app. Next.js renders this
// (keeping the app shell/nav mounted) when a page or its data throws, instead of
// a blank crash. `reset()` re-renders the failed segment so a transient failure
// can be retried without a full reload.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-lg py-16">
      <div className="card text-center">
        <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          This page hit an unexpected error. You can try again, or head back to
          the dashboard.
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-slate-400 dark:text-slate-500">
            Reference: {error.digest}
          </p>
        )}
        <div className="mt-5 flex justify-center gap-2">
          <button type="button" onClick={reset} className="btn">
            Try again
          </button>
          <a href="/" className="btn-ghost">
            Go to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
