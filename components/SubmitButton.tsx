"use client";

import { useFormStatus } from "react-dom";

// Shared pending-aware submit button. Drop it inside any <form> (server-action
// or client-action) and useFormStatus disables it and shows a spinner while the
// submission is in flight, so expensive writes can't be double-fired and the
// user gets feedback. Pass `disabled` to combine an extra guard (e.g. an empty
// required field) with the pending state; `pendingLabel` overrides the label
// shown while busy.
export default function SubmitButton({
  children,
  className = "btn",
  pendingLabel,
  disabled = false,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  pendingLabel?: React.ReactNode;
  disabled?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending}
      className={className}
      {...rest}
    >
      {pending ? (
        <span className="inline-flex items-center gap-2">
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
          {pendingLabel ?? children}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
