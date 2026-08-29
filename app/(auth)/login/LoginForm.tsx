"use client";

import { useActionState } from "react";
import SubmitButton from "@/components/SubmitButton";
import { login, verifyLoginTotp, type LoginState } from "./actions";

function ErrorAlert({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      data-testid="login-error"
      className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400"
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
  const [state, formAction] = useActionState<LoginState, FormData>(
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
          className="input tracking-widest"
        />
      </label>
      <ErrorAlert message={state.error} />
      <SubmitButton pendingLabel="Verifying…" variant="primary">
        Verify
      </SubmitButton>
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
// useActionState. The `next` target is carried through as a hidden field and
// re-validated server-side. When the password succeeds but 2FA is required, the
// action returns needsTotp and we swap to the second-factor step.
//
// THE CONTROLS ARE THE APP'S, NOT THIS PAGE'S (#3752). The submit was a fourth
// hand-rolled `useFormStatus` button and the fields were hand-styled copies of
// `.input`; both now come from the shared owners, so the pending spinner, the
// disabled treatment, the field boundary and the phone control box are whatever
// the rest of the app renders. The form's `flex flex-col` already stretches the
// submit across the card, which is what the old `w-full` was buying.
export default function LoginForm({
  next,
  username = "",
}: {
  next: string;
  // Optional prefill for the username field (issue #1434) — the invite flow hands
  // it over after the invitee set their password. `defaultValue`, so it stays an
  // ordinary editable field.
  username?: string;
}) {
  const [state, formAction] = useActionState<LoginState, FormData>(login, {});
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
          defaultValue={username}
          autoFocus
          required
          className="input"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-300">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="input"
        />
      </label>
      <ErrorAlert message={state.error} />
      <SubmitButton pendingLabel="Signing in…" variant="primary">
        Sign in
      </SubmitButton>
    </form>
  );
}
