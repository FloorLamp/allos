"use client";

import { useFormStatus } from "react-dom";

// Submit button for the AI-suggestions form. useFormStatus reports the enclosing
// form's pending state (the suggestion call can take several seconds), so we show
// a spinner and disable the button while it runs.
export default function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <button
      className="btn whitespace-nowrap disabled:opacity-70"
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? (
        <span className="flex items-center gap-2">
          <svg
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
          Generating…
        </span>
      ) : (
        "Get suggestions"
      )}
    </button>
  );
}
