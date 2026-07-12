// Friendly 404 for a shared passport link (issue #478). The share page calls
// notFound() for ANY miss — expired, revoked, or never-existed — and this boundary
// (closest to app/share/[token]/page.tsx) renders instead of Next's bare default.
//
// The recipient is unauthenticated and possibly the user's clinician; they need to
// know the link is dead and what to do, WITHOUT the app confirming a link ever
// existed. So the copy is deliberately uniform across expired/revoked/mistyped —
// preserving the anti-probing property that every share miss looks identical — and
// never says "expired" vs "revoked". No app chrome, no navigation into the app (the
// recipient has no session), matching the chrome-less share view itself.
export default function ShareNotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
        This link is no longer active
      </h1>
      <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-300">
        The shared health record you&apos;re trying to open isn&apos;t
        available. Ask the person who shared it to send you a new link.
      </p>
      <p className="mt-6 text-xs text-neutral-400 dark:text-neutral-500">
        Shared links expire and can be turned off by their owner at any time.
      </p>
    </div>
  );
}
