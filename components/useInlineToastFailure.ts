"use client";

import { useCallback, useState } from "react";
import { useToast } from "@/components/Toast";

// Field-bearing quick-log forms announce one failure through two channels: the
// durable inline alert beside the fields and the app toast. Keeping the pair in one
// hook makes a new validation/transport branch adopt both or neither.
export function useInlineToastFailure(): {
  error: string | null;
  clearError: () => void;
  fail: (message: string) => void;
} {
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const clearError = useCallback(() => setError(null), []);
  const fail = useCallback(
    (message: string) => {
      setError(message);
      toast(message, { tone: "error" });
    },
    [toast]
  );
  return { error, clearError, fail };
}
