"use client";

import { useRef, useState } from "react";
import {
  lookupRxcui,
  lookupRxcuiIngredients,
} from "@/app/(app)/nutrition/supplement-actions";
import { parseRxcuiIngredients } from "@/lib/rxnorm";

// Shared RxNorm confirm state for BOTH intake forms (#846, extracted from the former
// IntakeItemForm). Owns the cached concept id (#144) + its resolved active-ingredient
// CUIs (#279), the candidate list, and the lookup/confirm handlers. The form threads
// `rxcui`/`rxcuiIngredients` into its hidden fields and the interaction notices, so
// the ONE matching computation drives both forms identically (the cross-kind rule).
export interface RxcuiState {
  rxcui: string | null;
  rxcuiIngredients: string[] | null;
  candidates: { rxcui: string; name: string; score: number }[] | null;
  loading: boolean;
  error: string | null;
  find: (name: string) => Promise<void>;
  confirm: (code: string) => Promise<void>;
  clear: () => void;
  // A name edit invalidates a previously-confirmed code (and its ingredients).
  onNameChange: () => void;
  // Full reset for an add-form after a successful save.
  reset: () => void;
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

  // Latest confirmed code — guards the async ingredient resolve against a stale
  // response landing after the user cleared or re-confirmed a different code.
  const rxcuiRef = useRef<string | null>(initial?.rxcui ?? null);
  function apply(code: string | null, ingredients: string[] | null) {
    rxcuiRef.current = code;
    setRxcui(code);
    setRxcuiIngredients(ingredients);
  }

  async function confirm(code: string) {
    apply(code, null);
    setCandidates(null);
    setError(null);
    try {
      const ingredients = await lookupRxcuiIngredients(code);
      if (rxcuiRef.current === code && ingredients.length > 0) {
        setRxcuiIngredients(ingredients);
      }
    } catch {
      // Keep product-rxcui + name matching.
    }
  }

  async function find(name: string) {
    const term = name.trim();
    if (!term) return;
    setLoading(true);
    setError(null);
    try {
      const found = await lookupRxcui(term);
      setCandidates(found);
      if (found.length === 0) {
        setError(
          "No RxNorm match found (the lookup may be offline). You can still save — interactions will match by name."
        );
      }
    } catch {
      setError("Couldn't reach the RxNorm lookup. You can still save.");
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }

  function clear() {
    apply(null, null);
    setCandidates(null);
  }

  function onNameChange() {
    if (rxcuiRef.current) apply(null, null);
    setCandidates(null);
    setError(null);
  }

  function reset() {
    apply(null, null);
    setCandidates(null);
    setError(null);
  }

  return {
    rxcui,
    rxcuiIngredients,
    candidates,
    loading,
    error,
    find,
    confirm,
    clear,
    onNameChange,
    reset,
  };
}
