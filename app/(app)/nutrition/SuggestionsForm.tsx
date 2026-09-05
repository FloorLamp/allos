"use client";

import { useActionState } from "react";
import { generateSuggestions, type SuggestState } from "./intake-actions";
import SubmitButton from "@/components/SubmitButton";

// AI-suggestions form. Uses useActionState so the server action's result (a
// failure note, a no-key message, or "added N") is surfaced inline instead of
// the request silently completing. The shared submit owner drives the pending
// spinner: the suggestion call can take several seconds, and the copy says which
// wait this is (#3752 deleted the one-use clone that said the same thing).
export default function SuggestionsForm() {
  const [state, formAction] = useActionState<SuggestState | null, FormData>(
    generateSuggestions,
    null
  );
  return (
    <div className="mt-4">
      <form action={formAction} className="flex flex-col gap-2 sm:flex-row">
        <input
          name="feedback"
          className="input flex-1"
          placeholder="Optional: how you're feeling / training for… (leave blank to use recent labs)"
        />
        <SubmitButton pendingLabel="Generating…" variant="primary">
          Get suggestions
        </SubmitButton>
      </form>
      {state && (
        <p
          className={`mt-2 text-sm ${
            state.ok
              ? "text-slate-500 dark:text-slate-400"
              : "text-rose-600 dark:text-rose-400"
          }`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
