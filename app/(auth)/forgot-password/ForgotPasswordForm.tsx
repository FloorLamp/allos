"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { requestPasswordReset, type ResetRequestState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-gradient-to-r from-brand-500 to-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
    >
      {pending ? "Sending…" : "Send reset link"}
    </button>
  );
}

// The reset-request form. On submit it always shows the same enumeration-safe
// message (whether or not the address is registered), then hides the form so the
// user isn't nudged to probe further.
export default function ForgotPasswordForm() {
  const [state, formAction] = useActionState<ResetRequestState, FormData>(
    requestPasswordReset,
    {}
  );
  if (state.message) {
    return (
      <p
        data-testid="reset-sent"
        className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
      >
        {state.message}
      </p>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-300">
        Email
        <input
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          data-testid="reset-email"
          className="rounded-lg border border-black/10 bg-white px-3 py-2 text-slate-900 outline-none focus:border-brand-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-100"
        />
      </label>
      <SubmitButton />
    </form>
  );
}
