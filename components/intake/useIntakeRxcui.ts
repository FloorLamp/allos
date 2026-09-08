"use client";

import { useEffect, useRef, useState } from "react";
import {
  lookupRxcui,
  lookupRxcuiIngredients,
} from "@/app/(app)/nutrition/intake-actions";
import { parseRxcuiIngredients, dominantRxNormCandidate } from "@/lib/rxnorm";

// Shared RxNorm confirm state for BOTH intake forms (#846, extracted from the former
// IntakeItemForm). Owns the cached concept id (#144) + its resolved active-ingredient
// CUIs (#279), and the complete lookup → confirmation lifetime. A new product or
// operation invalidates every pending stage before it can publish identity or prefill.
// The form owns its dose ledger; it receives only current identity completions.
export interface ConfirmedRxcui {
  rxcui: string;
  rxcuiIngredients: string[] | null;
}

export interface RxcuiState {
  rxcui: string | null;
  rxcuiIngredients: string[] | null;
  candidates: { rxcui: string; name: string; score: number }[] | null;
  loading: boolean;
  error: string | null;
  find: (name: string) => Promise<void>;
  confirm: (code: string) => Promise<void>;
  // Current completion only. Null means a current no-match/offline/ambiguous
  // lookup; an invalidated operation never calls onResolved. The callback runs
  // inside the final validity check so no awaited result can become stale first.
  autoConfirm: (
    name: string,
    onResolved: (confirmed: ConfirmedRxcui | null) => void
  ) => Promise<void>;
  clear: () => void;
  // Replace identity when restoring a draft, or clear it for a blank form.
  reset: (identity?: ConfirmedRxcui | null) => void;
}

export function useIntakeRxcui(initial?: {
  rxcui?: string | null;
  rxcui_ingredients?: string | null;
}): RxcuiState {
  const [rxcui, setRxcui] = useState<string | null>(initial?.rxcui ?? null);
  const [rxcuiIngredients, setRxcuiIngredients] = useState<string[] | null>(
    () => {
      const stored = parseRxcuiIngredients(initial?.rxcui_ingredients ?? null);
      return stored.length > 0 ? stored : null;
    }
  );
  const [candidates, setCandidates] = useState<
    { rxcui: string; name: string; score: number }[] | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revision = useRef(0);
  useEffect(
    () => () => {
      ++revision.current;
    },
    []
  );

  function reset(identity: ConfirmedRxcui | null = null) {
    ++revision.current;
    setRxcui(identity?.rxcui ?? null);
    setRxcuiIngredients(identity?.rxcuiIngredients ?? null);
    setCandidates(null);
    setError(null);
    setLoading(false);
  }

  function begin(): number {
    reset();
    return revision.current;
  }

  // Auto-confirm carries the SAME revision through this stage; calling the public
  // confirm here would start a different operation. Code equality cannot guard an
  // older request for the same code after the product has changed away and back.
  async function resolveIngredients(
    code: string,
    operation: number
  ): Promise<ConfirmedRxcui | null> {
    setRxcui(code);
    let ingredients: string[] = [];
    try {
      ingredients = await lookupRxcuiIngredients(code);
    } catch {
      // Keep current product-CUI/name matching when decomposition is unavailable.
    }
    if (revision.current !== operation) return null;
    const confirmed = {
      rxcui: code,
      rxcuiIngredients: ingredients.length > 0 ? ingredients : null,
    };
    setRxcuiIngredients(confirmed.rxcuiIngredients);
    return confirmed;
  }

  async function confirm(code: string): Promise<void> {
    await resolveIngredients(code, begin());
  }

  async function find(name: string) {
    const operation = begin();
    const term = name.trim();
    if (!term) return;
    setLoading(true);
    try {
      const found = await lookupRxcui(term);
      if (revision.current !== operation) return;
      setCandidates(found);
      if (found.length === 0) {
        setError(
          "No RxNorm match found (the lookup may be offline). You can still save — interactions will match by name."
        );
      }
    } catch {
      if (revision.current !== operation) return;
      setError("Couldn't reach the RxNorm lookup. You can still save.");
      setCandidates([]);
    } finally {
      if (revision.current === operation) setLoading(false);
    }
  }

  async function autoConfirm(
    name: string,
    onResolved: (confirmed: ConfirmedRxcui | null) => void
  ): Promise<void> {
    const operation = begin();
    const term = name.trim();
    let confirmed: ConfirmedRxcui | null = null;
    try {
      const found = term ? await lookupRxcui(term) : [];
      if (revision.current !== operation) return;
      const dominant = dominantRxNormCandidate(found);
      if (dominant) confirmed = await resolveIngredients(dominant, operation);
      else if (found.length) setCandidates(found);
    } catch {
      // A CURRENT offline lookup retains name-only fallback. An obsolete one
      // cannot seed its old name, just as it cannot publish an old code.
    }
    // Keep the callback outside the transport catch: an application error must
    // not run the prefill twice by being mistaken for an offline lookup.
    if (revision.current === operation) onResolved(confirmed);
  }

  return {
    rxcui,
    rxcuiIngredients,
    candidates,
    loading,
    error,
    find,
    confirm,
    autoConfirm,
    clear: () => reset(),
    reset,
  };
}
