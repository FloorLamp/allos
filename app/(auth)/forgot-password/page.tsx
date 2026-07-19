import Wordmark from "@/components/Wordmark";
import { canSendAuthEmail } from "@/lib/auth-email";
import ForgotPasswordForm from "./ForgotPasswordForm";

// Reads SMTP/public-URL config to decide whether the flow is available, so keep it
// dynamic.
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  const available = canSendAuthEmail();
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <Wordmark markClassName="h-8 w-14" />
        </div>
        <div className="rounded-2xl border border-black/10 bg-white/70 p-6 shadow-sm backdrop-blur-xl dark:border-white/5 dark:bg-ink-950/70">
          <h1 className="mb-1 text-lg font-semibold text-slate-800 dark:text-slate-100">
            Reset your password
          </h1>
          {available ? (
            <>
              <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
                Enter your email and we&apos;ll send a link to set a new
                password.
              </p>
              <ForgotPasswordForm />
            </>
          ) : (
            <p
              data-testid="reset-unavailable"
              className="mb-6 text-sm text-slate-500 dark:text-slate-400"
            >
              Password reset by email isn&apos;t set up on this instance. Ask an
              admin to reset your password.
            </p>
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
