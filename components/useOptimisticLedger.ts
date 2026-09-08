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
import { noteOneTapWrite } from "@/lib/offline/snapshot-refresh";

// Shared write phases, optimistic settlement, and cooldown. Surfaces keep their
// displayed state; a tap supplies its projection and commit callback. Write keys
// debounce actions. Value keys group sibling actions that change the same state.

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
  // The displayed value this write changes. Defaults to the write key; supply the
  // same value key for sibling writes, and different keys for independent values.
  readonly valueKey?: string;
  // The displayed slice before the tap; refreshes the rollback baseline when idle.
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
  ) =>
    LedgerSettlement<V> | undefined | Promise<LedgerSettlement<V> | undefined>;
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
  // post-success cooldown). Whether that DIMS the control is the surface's call, and
  // it follows the feedback design the registry records: a surface with an optimistic
  // count beside the tap absorbs silently, because the count already answered "did
  // that land?", and dimming it would only make a legitimate repeat feel broken. A
  // surface with no count to move (the substance card, whose week figure arrives with
  // the revalidation) disables for the window instead, so the swallowed tap is
  // visible rather than silently ignored.
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
  const values = useRef(new Map<string, { value: V; inFlight: number }>());
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
      const valueKey = spec.valueKey ?? key;
      let value =
        spec.from !== undefined ? values.current.get(valueKey) : undefined;
      if (spec.from !== undefined) {
        if (!value) {
          value = { value: spec.from, inFlight: 0 };
          values.current.set(valueKey, value);
        } else if (value.inFlight === 0) {
          value.value = spec.from;
        }
      }
      if (value) value.inFlight += 1;
      const optimistic =
        spec.optimistic !== undefined ? spec.optimistic : (before.value as V);
      const tapped = ledgerReducer(
        {
          ...before,
          value: spec.from !== undefined ? spec.from : before.value,
        },
        { kind: "tap", optimistic }
      );
      states.current.set(key, tapped);
      setPhases((prev) => new Map(prev).set(key, tapped.phase));
      if (spec.optimistic !== undefined) spec.commit?.(optimistic);

      const finish = (settlement: LedgerSettlement<V>) => {
        // #2908: a tap that LANDED — server-adopted, or captured into the write queue —
        // makes any offline read snapshot that folds this flow in out of date. Marking
        // it here rather than at each surface is the whole point of there being one
        // binding: the affordance is already declared, and lib/offline/snapshot-refresh
        // maps it to the affected kinds off registries that already exist. A rollback
        // wrote nothing, so it marks nothing.
        if (settlement.kind !== "rollback") noteOneTapWrite(affordance);
        const resolved =
          settlement.kind === "rollback" && settlement.to === undefined && value
            ? { ...settlement, to: value.value }
            : settlement;
        const settled = ledgerReducer(states.current.get(key) ?? tapped, {
          kind: "settled",
          settlement: resolved,
        });
        if (value && settlement.kind !== "rollback")
          value.value = settled.value;
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

      try {
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
      } finally {
        if (value) value.inFlight -= 1;
      }
    },
    [cooldownMs, read, affordance]
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
