"use client";

import { useCallback } from "react";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
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
// "Mark taken" has no undo while `DoseConfirmButton`'s two mounts do). `"silent"` is a
// real answer rather than an omission — a control that BECOMES its done state is its
// own receipt (#2654) — spelled out so saying nothing stays a decision.
export type WriteAnnouncement =
  | {
      readonly message: string;
      readonly tone?: "success" | "error";
      readonly undo: UndoOffer | null;
    }
  | "silent";

export interface WriteSettlement {
  // Did anything actually get written? Answered from the TYPED outcome, never from the
  // ask — a dose retired by a schedule edit wrote nothing however the request went.
  readonly wrote: boolean;
  readonly announce: WriteAnnouncement;
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

export type WriteSpec<A extends OneTapAffordance, R> = {
  // Which write this is, when one surface hosts many independent targets (#2041). The
  // key names the WRITE, not the row.
  readonly key?: string;
  // The fields to post. The pipeline builds and stamps the FormData; a caller never
  // holds one, which is what makes an un-stamped post unrepresentable.
  readonly fields: Readonly<Record<string, string>>;
  readonly action: (formData: FormData) => Promise<R>;
  readonly settle: (result: R) => WriteSettlement;
  // What to say when the request itself did not complete and nothing was captured.
  readonly failureMessage: string;
} & OfflineHalf<A>;

export interface WritePipeline<A extends OneTapAffordance> {
  readonly affordance: A;
  pending: (key?: string) => boolean;
  blocked: (key?: string) => boolean;
  run: <R>(spec: WriteSpec<A, R>) => Promise<WriteResult>;
}

export function useWritePipeline<A extends OneTapAffordance>(
  affordance: A
): WritePipeline<A> {
  const toast = useToast();
  const announceUndoable = useUndoableAction();
  const { enqueue } = useOfflineQueue();
  const stampLoggedVia = useLoggedViaStamp();
  const ledger = useOptimisticLedger(affordance);

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
    async (decision: OfflineDecision): Promise<WriteResult> => {
      if (decision.kind === "attempt") return "nothing";
      if (decision.kind === "refuse") {
        say({ message: decision.message, tone: "error", undo: null });
        return "nothing";
      }
      // READ THE ANSWER (#3038): the device can refuse the capture — logged out, or no
      // IndexedDB to queue into — and promising a sync that will never happen is worse
      // than the missing save, because nothing later contradicts it.
      const kept =
        (await enqueue(decision.flow, decision.date, decision.payload)) ===
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
    async <R>(spec: WriteSpec<A, R>, tappedAt: Date): Promise<WriteResult> => {
      const offline = spec.offline as
        ((at: Date) => OfflineDecision) | undefined;
      const online =
        typeof navigator === "undefined" || navigator.onLine !== false;
      if (!online && offline) {
        const decision = offline(tappedAt);
        // `attempt` falls through to the network on purpose — a cross-profile write has
        // no offline path but is still worth trying, and a failure is reported below.
        if (decision.kind !== "attempt") return capture(decision);
      }

      const formData = stampLoggedVia(new FormData());
      for (const [name, value] of Object.entries(spec.fields))
        formData.set(name, value);
      let result: R;
      try {
        result = await spec.action(formData);
      } catch (error) {
        // Only the CAPTURE arm applies here. The pre-flight decision answers "the
        // browser says we are offline"; this one answers "the request died", where the
        // surface's own failure sentence is what every adopted site has always said —
        // the refusal copy is about a state the user is in, not about a dropped fetch.
        if (offline && shouldQueueOffline(navigator.onLine !== false, error)) {
          const decision = offline(tappedAt);
          if (decision.kind === "capture") return capture(decision);
        }
        say({ message: spec.failureMessage, tone: "error", undo: null });
        return "nothing";
      }
      const settled = spec.settle(result);
      say(settled.announce);
      return settled.wrote ? "wrote" : "nothing";
    },
    [capture, say, stampLoggedVia]
  );

  const run = useCallback(
    async <R>(spec: WriteSpec<A, R>): Promise<WriteResult> => {
      if (ledger.blocked(spec.key)) return "nothing";
      // Stamped up front: everything below — the round trip, its failure, the queue
      // write — happens after the moment the user acted.
      const tappedAt = new Date();
      // Held in a local rather than read off `tap`'s return so the ledger sees exactly
      // one settlement and the caller sees exactly one answer.
      let outcome: WriteResult = "nothing";
      await ledger.tap({
        key: spec.key,
        write: async () => {
          outcome = await attempt(spec, tappedAt);
        },
        settle: () =>
          outcome === "nothing" ? { kind: "rollback" } : { kind: "keep" },
        onError: () => {
          outcome = "nothing";
          say({ message: spec.failureMessage, tone: "error", undo: null });
          return { kind: "rollback" };
        },
      });
      return outcome;
    },
    [attempt, ledger, say]
  );

  return {
    affordance,
    pending: ledger.pending,
    blocked: ledger.blocked,
    run,
  };
}
