"use client";

import { useCallback } from "react";
import { useToast } from "@/components/Toast";
import {
  useOfflineQueue,
  useQueuedDayContextCapture,
  type QueuedCapture,
} from "@/components/OfflineQueueProvider";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import type { StampedFormData } from "@/lib/logged-via";
import { useUndoableAction } from "@/components/useUndoableAction";
import {
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
  OFFLINE_QUEUE_COVERAGE,
  shouldQueueOffline,
  type FlowKind,
  type IntentPayload,
} from "@/lib/offline/queue";
import type { ArguedExclusion } from "@/lib/loggable-domains";
import type { OneTapAffordance } from "@/lib/one-tap";
import type { UndoOffer } from "@/lib/undo-offer";
import { TAP_REACH } from "@/lib/log-manifest";

// THE ONE CLIENT WRITE PIPELINE (#3276). Ten surfaces hand-wired the same commit dance
// — stamp the surface, try the action, read the typed outcome, fall back to the queue,
// pick the sentence, settle the one-tap ledger — and #3272 is what independent copies
// cost: a fresh form simply FORGOT the offline half and the tap instant.
//
// So the forgettable steps are either OWNED here or made unrepresentable:
//
//   provenance   — the pipeline builds and stamps the FormData (#3087). A caller hands
//                  `fields`, never a FormData, so a bare unstamped post has no spelling.
//   offline half — REQUIRED by type for an affordance OFFLINE_QUEUE_COVERAGE maps to a
//                  flow, FORBIDDEN for one it argues out (`OfflineHalf`). Omitting it
//                  is a compile error, not a silently online-only form.
//   tap instant  — minted here, once, BEFORE the attempt, so a dead-spot capture
//                  carries when the user tapped rather than when we gave up (#1427).
//   undo         — `undo` on an announcement is required and nullable: declining is a
//                  written `undo: null`; forgetting does not compile.
//   optimistic   — the value a tap paints and the ending it settles on are ONE
//                  declaration (`OptimisticValue`), so a surface cannot paint a guess
//                  and then forget one of the three endings (#3728).
//
// It never interprets a domain outcome — only the caller knows whether "already
// skipped" is a success sentence — and it runs no unattended retry: the bounded backoff
// in `useActivityAutosave` belongs to the autosave commit model, whose saves have nobody
// watching them, and re-firing a dose confirm on a timer minutes after the finger left
// is a different act. The three commit models stay three; all three consume this.

// What one run ended up doing. `captured` is a real landing — the device holds the
// intent and the replay owns it — so it settles the ledger the way a server write does,
// while `nothing` leaves the tap immediately retryable.
export type WriteResult = "wrote" | "captured" | "nothing";

// What this surface says about a settled write, and whether an Undo may ride it.
// `undo` is not optional: `lib/undo-offer.ts` already decides whether an offer is
// legitimate, and the failure this closes is a surface that never asked (the sheet's
// "Mark taken" has no undo while `DoseConfirmButton` does). `"silent"` is a
// real answer rather than an omission — a control that BECOMES its done state is its
// own receipt (#2654) — spelled out so saying nothing stays a decision.
export type WriteAnnouncement =
  | {
      readonly message: string;
      readonly tone?: "success" | "error";
      readonly undo: UndoOffer | null;
    }
  | "silent";

export interface WriteSettlement<V = void> {
  // Did anything actually get written? Answered from the TYPED outcome, never from the
  // ask — a dose retired by a schedule edit wrote nothing however the request went.
  readonly wrote: boolean;
  readonly announce: WriteAnnouncement;
  // WHAT THE SERVER SAYS THE VALUE NOW IS, for a surface that declared `optimistic`.
  // Present, it is ADOPTED over whatever the tap guessed — the #748 item 2 rule the
  // ledger already spells. Absent, the projection stands: an offline capture has no
  // server figure to adopt, and a surface whose truth arrives by revalidation says so
  // by naming the value its props feed (`null` on the dose override) rather than by
  // leaving this out.
  readonly value?: V;
}

// What this surface does with THIS tap on a dead connection. Three arms, so the choice
// is visible in the diff rather than implied by an absent branch: `capture` queues it
// and promises `keptMessage`; `refuse` says honestly that this tap is not a capture (an
// already-resolved dose would be an un-resolve, which the queue does not model);
// `attempt` goes to the network anyway because no offline path applies — a cross-profile
// write, whose replay carries no target profile and would land on the wrong person.
export type OfflineDecision =
  | {
      readonly kind: "capture";
      readonly flow: FlowKind;
      readonly date: string;
      readonly payload: IntentPayload;
      readonly keptMessage: string;
    }
  | { readonly kind: "refuse"; readonly message: string }
  | { readonly kind: "attempt" };

// THE ENROLLMENT GATE (#3275's census used AS a type, not copied as a list).
// `OFFLINE_QUEUE_COVERAGE` is already total over `OneTapAffordance` and const-asserted,
// so this reads each affordance's own row: an argued exclusion FORBIDS the offline half
// (`?: never`, so the surface is online-only by declaration with its own honest failure
// sentence); anything else REQUIRES it.
type OfflineHalf<A extends OneTapAffordance> =
  (typeof OFFLINE_QUEUE_COVERAGE)[A] extends ArguedExclusion
    ? { readonly offline?: never }
    : { readonly offline: (tappedAt: Date) => OfflineDecision };

// THE OPTIMISTIC-VALUE CHANNEL (#3728). Every quick-log surface used to carry its own:
// paint a guess, then hand-roll the three endings — adopt the server's figure, leave the
// guess standing for a queued replay, or put the old value back. `StoolTypeControl` spelt
// all three inline, and its rollback restored the value THIS tap fired from, so a
// refusal on one of the seven buttons erased a reading a sibling tap had already landed.
//
// One channel, so a write's projection and its settlement cannot disagree: the surface
// says what it shows and how this tap changes it, and the pipeline decides which of the
// three endings applies from the SAME typed outcome that picks the sentence.
export interface OptimisticValue<V> {
  // The displayed value as it stands BEFORE this tap. Read at the tap, so it is the
  // surface's own state and not a re-derivation.
  readonly from: V;
  // Identify separate displayed values, such as totals for different days.
  readonly key?: string;
  // How this tap makes it look, painted before the request leaves.
  readonly to: V;
  // Writes a value into the surface's own state. The surface keeps its state where it
  // is — the ledger's rule (#2041): a count indexed by day and slot has one home.
  readonly commit: (value: V) => void;
}

export type WriteSpec<A extends OneTapAffordance, R, V = void> = {
  // Which write this is, when one surface hosts many independent targets (#2041). The
  // key names the WRITE, not the row.
  readonly key?: string;
  // The fields to post. The pipeline builds and stamps the FormData; a caller never
  // holds one, which is what makes an un-stamped post unrepresentable.
  readonly fields: Readonly<Record<string, string>>;
  // Takes the STAMPED payload (#5349), which is what makes "the pipeline builds and
  // stamps it" a fact the compiler holds rather than a promise this comment makes. An
  // action that does not read a surface takes a plain `FormData` and is still accepted
  // here — a parameter is contravariant, so the wider signature fits the narrower slot.
  readonly action: (formData: StampedFormData) => Promise<R>;
  readonly settle: (result: R) => WriteSettlement<V>;
  // The value this tap moves, when the surface shows one. Omitted by a surface whose
  // server action revalidates and re-renders it.
  readonly optimistic?: OptimisticValue<V>;
  // What to say when the request itself did not complete and nothing was captured.
  readonly failureMessage: string;
} & OfflineHalf<A>;

export interface WritePipeline<A extends OneTapAffordance, V = void> {
  readonly affordance: A;
  pending: (key?: string) => boolean;
  blocked: (key?: string) => boolean;
  run: <R>(spec: WriteSpec<A, R, V>) => Promise<WriteResult>;
}

// What one attempt ended up doing, plus the server's own figure when it named one.
type Attempted<V> = { readonly result: WriteResult; readonly value?: V };

export function useWritePipeline<A extends OneTapAffordance, V = void>(
  affordance: A
): WritePipeline<A, V> {
  const toast = useToast();
  const announceUndoable = useUndoableAction();
  const { enqueue } = useOfflineQueue();
  const captureDayContext = useQueuedDayContextCapture();
  const stampLoggedVia = useLoggedViaStamp();
  const ledger = useOptimisticLedger<V>(affordance);

  // ONE announcement path. An Undo rides only where `lib/undo-offer.ts` says it may.
  const say = useCallback(
    (announcement: WriteAnnouncement) => {
      if (announcement === "silent") return;
      if (announcement.undo) {
        announceUndoable({
          message: announcement.message,
          tone: announcement.tone,
          undo: announcement.undo,
        });
        return;
      }
      if (announcement.tone === "error")
        toast(announcement.message, { tone: "error" });
      else toast(announcement.message);
    },
    [announceUndoable, toast]
  );

  // The offline half, reached from either entry: a browser already reporting itself
  // offline, or a submit that died on the shapes a dead connection and a mid-deploy swap
  // produce (`shouldQueueOffline` — #2912's classifier: `__NEXT_ERROR_CODE` for the
  // stale-action signature, plus the TypeError a dropped fetch throws).
  const capture = useCallback(
    async (
      decision: OfflineDecision,
      capturedContext: QueuedCapture | null
    ): Promise<WriteResult> => {
      if (decision.kind === "attempt") return "nothing";
      if (decision.kind === "refuse") {
        say({ message: decision.message, tone: "error", undo: null });
        return "nothing";
      }
      if (!capturedContext) {
        say({
          message: OFFLINE_CAPTURE_REFUSED_MESSAGE,
          tone: "error",
          undo: null,
        });
        return "nothing";
      }
      // READ THE ANSWER (#3038): the device can refuse the capture — logged out, or no
      // IndexedDB to queue into — and promising a sync that will never happen is worse
      // than the missing save, because nothing later contradicts it.
      const kept =
        (await enqueue(decision.flow, decision.payload, capturedContext)) ===
        "kept";
      if (!kept) {
        say({
          message: OFFLINE_CAPTURE_REFUSED_MESSAGE,
          tone: "error",
          undo: null,
        });
        return "nothing";
      }
      // A queued intent has no server row yet, so there is nothing an inverse could
      // re-derive: an offline capture never carries an Undo.
      say({ message: decision.keptMessage, undo: null });
      return "captured";
    },
    [enqueue, say]
  );

  const attempt = useCallback(
    async <R>(
      spec: WriteSpec<A, R, V>,
      tappedAt: Date,
      offlineDecision: OfflineDecision | undefined,
      capturedContext: QueuedCapture | null
    ): Promise<Attempted<V>> => {
      // Resolve the existing write-gate generation before starting the slow action.
      // A later profile switch/logout then invalidates the exact token this tap spends
      // if the request fails and falls back to IndexedDB.
      if (capturedContext) await capturedContext.writeToken;
      const online =
        typeof navigator === "undefined" || navigator.onLine !== false;
      if (!online && offlineDecision) {
        const decision = offlineDecision;
        // `attempt` falls through to the network on purpose — a cross-profile write has
        // no offline path but is still worth trying, and a failure is reported below.
        if (decision.kind !== "attempt")
          return { result: await capture(decision, capturedContext) };
      }

      const formData = stampLoggedVia(new FormData());
      for (const [name, value] of Object.entries(spec.fields))
        formData.set(name, value);
      let result: R;
      try {
        result = await spec.action(formData);
      } catch (error) {
        // A dropped connection uses the same capture or refusal as offline preflight.
        if (
          offlineDecision &&
          shouldQueueOffline(navigator.onLine !== false, error)
        ) {
          const decision = offlineDecision;
          if (decision.kind !== "attempt")
            return { result: await capture(decision, capturedContext) };
        }
        say({ message: spec.failureMessage, tone: "error", undo: null });
        return { result: "nothing" };
      }
      const settled = spec.settle(result);
      say(settled.announce);
      return settled.wrote
        ? { result: "wrote", value: settled.value }
        : { result: "nothing" };
    },
    [capture, say, stampLoggedVia]
  );

  const run = useCallback(
    async <R>(spec: WriteSpec<A, R, V>): Promise<WriteResult> => {
      if (ledger.blocked(spec.key)) return "nothing";
      // Stamped up front: everything below — the round trip, its failure, the queue
      // write — happens after the moment the user acted. Evaluate the offline branch
      // once here as well: a mutable form or selected day may change while an online
      // action is in flight, and its failure still belongs to this tap's payload.
      const tappedAt = new Date();
      const offline = spec.offline as
        ((at: Date) => OfflineDecision) | undefined;
      const offlineDecision = offline?.(tappedAt);
      let capturedContext: QueuedCapture | null = null;
      if (offlineDecision?.kind === "capture") {
        capturedContext = captureDayContext(
          offlineDecision.date,
          TAP_REACH[affordance],
          tappedAt
        );
      }
      const projection = spec.optimistic;
      // Held in a local rather than read off `tap`'s return so the ledger sees exactly
      // one settlement and the caller sees exactly one answer.
      let outcome: Attempted<V> = { result: "nothing" };
      await ledger.tap({
        key: spec.key,
        valueKey: projection?.key ?? "",
        from: projection?.from,
        optimistic: projection?.to,
        commit: projection?.commit,
        write: async () => {
          outcome = await attempt(
            spec,
            tappedAt,
            offlineDecision,
            capturedContext
          );
        },
        settle: () => {
          if (outcome.result === "nothing") return { kind: "rollback" };
          if (outcome.value !== undefined)
            return { kind: "adopt", value: outcome.value };
          return { kind: "keep" };
        },
        onError: () => {
          outcome = { result: "nothing" };
          say({ message: spec.failureMessage, tone: "error", undo: null });
          return { kind: "rollback" };
        },
      });
      return outcome.result;
    },
    [affordance, attempt, captureDayContext, ledger, say]
  );

  return {
    affordance,
    pending: ledger.pending,
    blocked: ledger.blocked,
    run,
  };
}
