"use client";

import { useActionState } from "react";
import SubmitButton from "@/components/SubmitButton";
import { requestPasswordReset, type ResetRequestState } from "./actions";

// The reset-request form. On submit it always shows the same enumeration-safe
// message (whether or not the address is registered), then hides the form so the
// user isn't nudged to probe further. Submit and field are the shared owners
// (#3752); nothing about the enumeration answer depends on how they render.
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
          className="input"
        />
      </label>
      <SubmitButton pendingLabel="Sending…" variant="primary">
        Send reset link
      </SubmitButton>
    </form>
  );
}
