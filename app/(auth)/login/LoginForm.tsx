"use client";

import { useFormState, useFormStatus } from "react-dom";
import { login, verifyLoginTotp, type LoginState } from "./actions";

function SubmitButton({
  idleLabel,
  busyLabel,
}: {
  idleLabel: string;
  busyLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-gradient-to-r from-brand-500 to-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
    >
      {pending ? busyLabel : idleLabel}
    </button>
  );
}

function ErrorAlert({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
    >
      {message}
    </p>
  );
}

// The second-factor step (issue #23): shown after a correct password when the
// login has 2FA on. Submits a 6-digit authenticator code OR a recovery code to
// verifyLoginTotp, which finishes the sign-in server-side. The intermediate state
// is a short-lived server challenge — this form holds no credentials.
function TotpStep() {
  const [state, formAction] = useFormState<LoginState, FormData>(
    verifyLoginTotp,
    { needsTotp: true }
  );
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="text-sm text-slate-500 dark:text-slate-400">
        Enter the 6-digit code from your authenticator app. Lost your device?
        Use one of your recovery codes.
      </div>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-300">
        Authenticator or recovery code
        <input
          name="code"
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          autoFocus
          required
          data-testid="totp-code"
          className="rounded-lg border border-black/10 bg-white px-3 py-2 tracking-widest text-slate-900 outline-none focus:border-brand-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-100"
        />
      </label>
      <ErrorAlert message={state.error} />
      <SubmitButton idleLabel="Verify" busyLabel="Verifying…" />
      <a
        href="/login"
        className="text-center text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
      >
        Back to sign in
      </a>
    </form>
  );
}

// Client form driving the login Server Action, with inline error via
// useFormState. The `next` target is carried through as a hidden field and
// re-validated server-side. When the password succeeds but 2FA is required, the
// action returns needsTotp and we swap to the second-factor step.
export default function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useFormState<LoginState, FormData>(login, {});
  if (state.needsTotp) return <TotpStep />;
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-300">
        Username
        <input
          name="username"
          type="text"
          autoComplete="username"
          autoFocus
          required
          className="rounded-lg border border-black/10 bg-white px-3 py-2 text-slate-900 outline-none focus:border-brand-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-100"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-300">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-lg border border-black/10 bg-white px-3 py-2 text-slate-900 outline-none focus:border-brand-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-100"
        />
      </label>
      <ErrorAlert message={state.error} />
      <SubmitButton idleLabel="Sign in" busyLabel="Signing in…" />
    </form>
  );
}
