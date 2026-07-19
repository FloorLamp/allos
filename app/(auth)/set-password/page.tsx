import Wordmark from "@/components/Wordmark";
import { peekAuthToken } from "@/lib/auth-tokens";
import SetPasswordForm from "./SetPasswordForm";

// Resolves the token against the DB, so keep it dynamic (and never cached).
export const dynamic = "force-dynamic";

export default async function SetPasswordPage(props: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await props.searchParams;
  // Peek (no consume) so rendering the form doesn't spend the token — the POST
  // spends it. An invalid/expired/consumed token renders the generic dead-link
  // message with no oracle.
  const info = token ? peekAuthToken(token) : null;
  const isInvite = info?.kind === "invite";
  const heading = isInvite ? "Set your password" : "Reset your password";
  const label = isInvite ? "Set password" : "Reset password";

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <Wordmark markClassName="h-8 w-14" />
        </div>
        <div className="rounded-2xl border border-black/10 bg-white/70 p-6 shadow-sm backdrop-blur-xl dark:border-white/5 dark:bg-ink-950/70">
          <h1 className="mb-1 text-lg font-semibold text-slate-800 dark:text-slate-100">
            {heading}
          </h1>
          {info && token ? (
            <>
              <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
                Choose a password to
                {isInvite
                  ? " finish setting up your login."
                  : " sign in with from now on."}
              </p>
              <SetPasswordForm token={token} label={label} />
            </>
          ) : (
            <>
              <p
                data-testid="set-password-invalid"
                className="mb-6 text-sm text-slate-500 dark:text-slate-400"
              >
                This link is invalid or has expired. Request a new one from the
                sign-in page.
              </p>
              <a
                href="/forgot-password"
                className="block text-center text-xs text-brand-600 hover:underline dark:text-brand-400"
              >
                Request a new link
              </a>
            </>
          )}
          <a
            href="/login"
            className="mt-4 block text-center text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            Back to sign in
          </a>
        </div>
      </div>
    </main>
  );
}
