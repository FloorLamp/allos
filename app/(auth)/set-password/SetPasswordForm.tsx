"use client";

import { useActionState, useState } from "react";
import SubmitButton from "@/components/SubmitButton";
import { completeSetPassword, type SetPasswordState } from "./actions";

// The set-password form for both the invite and reset flows (the token carries its
// kind; the label just reads nicer). On success it swaps to a sign-in prompt. A
// client-side confirm-match guard keeps typos out before the round trip.
//
// The submit and both fields are the shared owners (#3752). The controlled
// value/onChange pair stays here, because the match guard is what reads it.
export default function SetPasswordForm({
  token,
  label,
  username = null,
}: {
  token: string;
  label: string;
  // The login this token belongs to (issue #1434). Carried into the sign-in link so
  // the username field arrives filled — the invitee already proved possession of a
  // token minted for exactly this login.
  username?: string | null;
}) {
  const [state, formAction] = useActionState<SetPasswordState, FormData>(
    completeSetPassword,
    {}
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && password !== confirm;

  if (state.ok) {
    return (
      <div className="flex flex-col gap-4">
        <p
          data-testid="set-password-done"
          className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
        >
          Your password is set. You can sign in now.
        </p>
        <a
          href={
            username ? `/login?u=${encodeURIComponent(username)}` : "/login"
          }
          data-testid="set-password-signin"
          className="w-full rounded-lg bg-(--btn) px-4 py-2.5 text-center text-sm font-semibold text-(--btn-fg) shadow-xs transition hover:bg-(--btn-hover)"
        >
          Sign in
        </a>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-300">
        New password
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="new-password"
          className="input"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-300">
        Confirm password
        <input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          data-testid="confirm-password"
          className="input"
        />
      </label>
      {mismatch && (
        <p className="text-sm text-rose-600 dark:text-rose-400">
          The passwords don&apos;t match.
        </p>
      )}
      {state.error && (
        <p
          role="alert"
          className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400"
        >
          {state.error}
        </p>
      )}
      <SubmitButton pendingLabel="Saving…" variant="primary">
        {label}
      </SubmitButton>
    </form>
  );
}
