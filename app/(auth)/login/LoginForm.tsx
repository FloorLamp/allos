"use client";

import { useFormState, useFormStatus } from "react-dom";
import { login, type LoginState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-gradient-to-r from-brand-500 to-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
    >
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

// Client form driving the login Server Action, with inline error via
// useFormState. The `next` target is carried through as a hidden field and
// re-validated server-side.
export default function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useFormState<LoginState, FormData>(login, {});
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
      {state.error ? (
        <p
          role="alert"
          className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
        >
          {state.error}
        </p>
      ) : null}
      <SubmitButton />
    </form>
  );
}
