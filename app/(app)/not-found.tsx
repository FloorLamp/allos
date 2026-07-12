import Link from "next/link";

// 404 boundary for the authenticated app (issue #478). Any notFound() inside the
// (app) group — a missing /encounters/[id], /import/[id], /protocols/[id],
// /providers/[id], etc. — renders here, INSIDE the app shell (this file is a child
// of (app)/layout.tsx, so the sidebar/nav stay), instead of Next's bare default.
export default function AppNotFound() {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-16 text-center">
      <p className="text-sm font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
        404
      </p>
      <h1 className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-50">
        Not found
      </h1>
      <p className="mt-3 max-w-md text-sm text-slate-500 dark:text-slate-400">
        This record doesn&apos;t exist, or you don&apos;t have access to it. It
        may have been deleted or moved to another profile.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
