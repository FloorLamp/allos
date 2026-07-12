import Link from "next/link";

// Root 404 boundary (issue #478). Catches any unmatched URL and any notFound()
// thrown outside the (app) group that has no closer boundary. Renders inside the
// bare root shell (no session, no nav), so it's a self-contained, theme-aware page
// rather than Next's unstyled default "404: This page could not be found."
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-6 py-16 text-center">
      <p className="text-sm font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
        404
      </p>
      <h1 className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-50">
        Page not found
      </h1>
      <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
        The page you&apos;re looking for doesn&apos;t exist or may have moved.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
      >
        Go to dashboard
      </Link>
    </main>
  );
}
