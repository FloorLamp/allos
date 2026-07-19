"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { completeSetPassword, type SetPasswordState } from "./actions";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-gradient-to-r from-brand-500 to-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

// The set-password form for both the invite and reset flows (the token carries its
// kind; the label just reads nicer). On success it swaps to a sign-in prompt. A
// client-side confirm-match guard keeps typos out before the round trip.
export default function SetPasswordForm({
  token,
  label,
}: {
  token: string;
  label: string;
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
          href="/login"
          className="w-full rounded-lg bg-gradient-to-r from-brand-500 to-brand-600 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
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
          className="rounded-lg border border-black/10 bg-white px-3 py-2 text-slate-900 outline-none focus:border-brand-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-100"
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
          className="rounded-lg border border-black/10 bg-white px-3 py-2 text-slate-900 outline-none focus:border-brand-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-100"
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
      <SubmitButton label={label} />
    </form>
  );
}
