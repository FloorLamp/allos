"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  POST_SUCCESS_COOLDOWN_MS,
  acceptsTap,
  initialLedger,
  ledgerReducer,
  type LedgerPhase,
  type LedgerSettlement,
  oneTapAffordance,
  type LedgerState,
  type OneTapAffordance,
  type OneTapAffordanceDecl,
} from "@/lib/one-tap";

// The ONE client binding for one-tap logging (issues #2041 and #2007).
//
// Before this hook, five surfaces hand-rolled the same three steps — optimistic
// delta, `rollback()` closure, adopt the server's authoritative total — while citing
// the pattern by name ("the food-log #748 item 2 pattern"), and the post-success
// double-tap window was closed on exactly one of them. Both halves now live in the
// pure machine in `lib/one-tap.ts`; this is its React wiring and nothing else.
//
// WHAT IT OWNS: the phase (ready → writing → cooldown → ready), the pre-tap value a
// rollback restores, and the cooldown timer.
//
// WHAT IT DOES NOT OWN: the surface's state. The adopters keep their counts, sets and
// severity maps exactly where they are — a food bar's counts are indexed by day, meal
// slot and group and are also written by corrections and removals, so moving them
// under a hook would only give one number two homes. The hook is handed the pre-tap
// slice, the optimistic slice, and a `commit` that writes a slice back; it decides
// WHICH of the three to commit and when.
//
// Usage:
//   const ledger = useOptimisticLedger<number>("protein-grams");
//   await ledger.tap({
//     from: total,
//     optimistic: total + grams,
//     commit: setTotal,
//     write: () => addProteinGrams(fd),
//     settle: (res) => {
//       if (res.ok) return { kind: "adopt", value: res.grams };
//       toast(res.error, { tone: "error" });
//       return { kind: "rollback" };
//     },
//   });

// A tap's own result, so the caller can answer the user without re-deriving what
// happened. `absorbed` is the double-tap being swallowed: NOTHING was written and
// nothing should be said — the value beside the button already shows the first tap's
// result, which is the honest answer to "did that land?".
export type LedgerTapResult<R> =
  | { readonly status: "absorbed" }
  | { readonly status: "settled"; readonly result: R }
  | { readonly status: "failed"; readonly error: unknown };

export interface LedgerTap<V, R> {
  // Which write this is, when one surface hosts many independent one-tap targets.
  // The key names the WRITE, not the row: an undo tap is a different write from the
  // log tap beside it, so it carries a different key and is never absorbed by the
  // log tap's cooldown. Omitted on a surface with a single affordance.
  readonly key?: string;
  // The displayed slice as it stands BEFORE the tap — what a rollback restores.
  readonly from?: V;
  // The slice as this tap makes it look, applied immediately.
  readonly optimistic?: V;
  // Writes a slice into the surface's own state. Omitted by a surface with no
  // optimistic value (its server action revalidates and the page re-renders).
  readonly commit?: (value: V) => void;
  // The Server Action call. May throw (a dropped connection); see `onError`.
  readonly write: () => Promise<R>;
  // What the settled result means for the displayed value. Defaults to `keep` —
  // correct for a surface with no optimistic value at all.
  readonly settle?: (result: R) => LedgerSettlement<V>;
  // A thrown write. Returns what to do with the value; anything falsy rolls back.
  // (The food bar queues an offline capture here and returns `keep`, so the
  // optimistic count stands in for the queued write until replay.)
  readonly onError?: (
    error: unknown
  ) => LedgerSettlement<V> | undefined | Promise<LedgerSettlement<V> | undefined>;
}

export interface OptimisticLedger<V> {
  // The declared affordance this surface is, and what `lib/one-tap.ts` records about
  // it — so a surface that also asks the re-log question (#2007 layer 3) names the
  // affordance once, here, and passes it straight to `shouldConfirmRelog`.
  readonly affordance: OneTapAffordance;
  readonly decl: OneTapAffordanceDecl;
  // True while this key's write is in flight — the disable condition for a control
  // that dims during its request.
  pending: (key?: string) => boolean;
  // True while a tap on this key would be ABSORBED (in flight or inside the
  // post-success cooldown). Buttons deliberately stay enabled through the cooldown
  // (the #798 posture: informational, never permissive) — the tap is swallowed, the
  // control does not flicker, and a deliberate repeat a moment later still lands.
  blocked: (key?: string) => boolean;
  phase: (key?: string) => LedgerPhase;
  tap: <R>(spec: LedgerTap<V, R>) => Promise<LedgerTapResult<R>>;
}

const SOLE_KEY = "";

export function useOptimisticLedger<V = void>(
  // The affordance this surface is. Declared, not inferred: `lib/one-tap.ts` records
  // what a second tap means here and which feedback design applies, and a surface
  // cannot run the shared machinery without saying which one it is.
  affordance: OneTapAffordance,
  opts: { cooldownMs?: number } = {}
): OptimisticLedger<V> {
  const cooldownMs = opts.cooldownMs ?? POST_SUCCESS_COOLDOWN_MS;
  // The machine's state per key. A ref because a tap reads and writes it
  // synchronously inside one async sequence — a stale render closure must never let
  // a second tap through the `ready` gate — while the mirror below drives rendering.
  const states = useRef(new Map<string, LedgerState<V>>());
  const [phases, setPhases] = useState<ReadonlyMap<string, LedgerPhase>>(
    () => new Map()
  );
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const read = useCallback((key: string): LedgerState<V> => {
    const found = states.current.get(key);
    if (found) return found;
    // `undefined as V` is the no-optimistic-value case (V = void): the machine still
    // runs its phases, it just has nothing to roll back.
    const fresh = initialLedger(undefined as V);
    states.current.set(key, fresh);
    return fresh;
  }, []);

  const phaseOf = useCallback(
    (key?: string) => phases.get(key ?? SOLE_KEY) ?? "ready",
    [phases]
  );

  const tap = useCallback(
    async <R>(spec: LedgerTap<V, R>): Promise<LedgerTapResult<R>> => {
      const key = spec.key ?? SOLE_KEY;
      const before = read(key);
      // The double-tap gate. Read from the ref, so two taps in the same frame — the
      // ones a fat finger and a queued click actually produce — cannot both pass.
      if (!acceptsTap(before.phase)) return { status: "absorbed" };
      const optimistic =
        spec.optimistic !== undefined ? spec.optimistic : (before.value as V);
      const tapped = ledgerReducer(
        { ...before, value: spec.from !== undefined ? spec.from : before.value },
        { kind: "tap", optimistic }
      );
      states.current.set(key, tapped);
      setPhases((prev) => new Map(prev).set(key, tapped.phase));
      if (spec.optimistic !== undefined) spec.commit?.(optimistic);

      const finish = (settlement: LedgerSettlement<V>) => {
        const settled = ledgerReducer(states.current.get(key) ?? tapped, {
          kind: "settled",
          settlement,
        });
        states.current.set(key, settled);
        setPhases((prev) => new Map(prev).set(key, settled.phase));
        if (settlement.kind === "adopt") spec.commit?.(settlement.value);
        else if (settlement.kind === "rollback" && spec.from !== undefined)
          spec.commit?.(settled.value);
        if (settled.phase !== "cooldown") return;
        // Exactly one timer per key: the cooldown has one transition, back to ready.
        const running = timers.current.get(key);
        if (running) clearTimeout(running);
        timers.current.set(
          key,
          setTimeout(() => {
            timers.current.delete(key);
            const cooled = ledgerReducer(states.current.get(key) ?? settled, {
              kind: "cooled",
            });
            states.current.set(key, cooled);
            setPhases((prev) => new Map(prev).set(key, cooled.phase));
          }, cooldownMs)
        );
      };

      let result: R;
      try {
        result = await spec.write();
      } catch (error) {
        const handled = await spec.onError?.(error);
        finish(handled ?? { kind: "rollback" });
        return { status: "failed", error };
      }
      finish(spec.settle ? spec.settle(result) : { kind: "keep" });
      return { status: "settled", result };
    },
    [cooldownMs, read]
  );

  return {
    affordance,
    decl: oneTapAffordance(affordance),
    pending: (key?: string) => phaseOf(key) === "writing",
    blocked: (key?: string) => phaseOf(key) !== "ready",
    phase: phaseOf,
    tap,
  };
}
