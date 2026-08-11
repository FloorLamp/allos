"use client";

import { useState, type Dispatch, type SetStateAction } from "react";

// Local draft state whose baseline belongs to a prop/URL selection. A new reset key
// is reflected during that render, without copying props into state from an effect;
// the next edit adopts the new baseline before applying its update.
export function useResettableState<T, K = unknown>(
  initialValue: T,
  resetKey: K
): [T, Dispatch<SetStateAction<T>>] {
  const [stored, setStored] = useState(() => ({
    key: resetKey,
    value: initialValue,
  }));
  // React discards this render and retries immediately, so children never observe
  // the stale draft and a later return to an older key cannot resurrect it.
  if (!Object.is(stored.key, resetKey)) {
    setStored({ key: resetKey, value: initialValue });
  }

  const setValue: Dispatch<SetStateAction<T>> = (next) => {
    setStored((previous) => {
      return {
        key: resetKey,
        value:
          typeof next === "function"
            ? (next as (value: T) => T)(previous.value)
            : next,
      };
    });
  };

  return [stored.value, setValue];
}
