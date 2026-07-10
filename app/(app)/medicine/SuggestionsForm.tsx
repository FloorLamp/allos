"use client";

import { useActionState } from "react";
import { generateSuggestions, type SuggestState } from "./actions";
import GenerateButton from "./GenerateButton";

// AI-suggestions form. Uses useActionState so the server action's result (a
// failure note, a no-key message, or "added N") is surfaced inline instead of
// the request silently completing. GenerateButton (useFormStatus) drives the
// pending spinner.
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
        <GenerateButton />
      </form>
      {state && (
        <p
          className={`mt-2 text-sm ${
            state.ok
              ? "text-slate-400 dark:text-slate-500"
              : "text-rose-600 dark:text-rose-400"
          }`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
