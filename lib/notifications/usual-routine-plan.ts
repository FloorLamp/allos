// WHERE THE COMPOSED ONE-TAP RIDES (issue #2460) — the SLOT SEND-PLAN decision.
//
// The bundle decorates whichever of the window's sends fires, and never both:
//
//   1. the window's DOSE REMINDER when that sends — it is the message already carrying
//      the stack's one-taps, and the bundle is the upgrade of its `All` row;
//   2. otherwise the window's FOOD NUDGE — a habitual window with no pending doses
//      still gets the bundle, which degrades to the food half;
//   3. otherwise nowhere.
//
// ── WHY IT IS NOT A BUILDER'S DECISION ───────────────────────────────────────
//
// "Never both" is CROSS-MESSAGE knowledge. `buildFoodNudge` has five callers and none
// of them knows anything about the dose reminder; the same is true in reverse. A
// builder that asked "is the other message firing?" would be reaching across a seam it
// has no business knowing about, and every one of those five callers would inherit the
// question. So the tick's per-profile slot block — the one place that already knows
// what is going out — computes the candidate ONCE and hands the already-decided
// attachment to whichever message it lands on. Builders accept an attachment; they
// never ask.
//
// ── ONE TOKEN INSTANCE PER SLOT, ASSERTED RATHER THAN ASSUMED ────────────────
//
// The plan is a one-shot claim. The first host that actually sends takes the bundle
// and every later claim answers null, so "never both" cannot be broken by getting the
// call order wrong — the second call simply has nothing to give. `claimedBy` records
// which host took it, so a test can pin the priority rather than the plumbing.
//
// ── AND THE OFFER ROW IS MINTED ON THE CLAIM, NOT BEFORE ─────────────────────
//
// The candidate is DERIVED once (the read), but its `notify_offers` row is written
// only when a host actually takes it. A slot where neither message sends therefore
// leaves nothing behind at all.

import type { FoodSlot } from "../food-slot";
import {
  attachUsualRoutine,
  mintUsualRoutineAttachment,
  usualDispatchProblem,
  type UsualRoutineAttachment,
} from "./usual-routine-attach";
import { getUsualRoutineOffer } from "../queries/usual-routine";
import { parseUsualRoutineCallback } from "./callback-data";
import { createLogger } from "../log";
import type { NotificationMessage } from "./types";

const log = createLogger("notify");

// The two hosts the bundle can ride, in priority order.
export type UsualHost = "dose" | "food";

export interface UsualRoutineSlotPlan {
  readonly window: FoodSlot;
  // The already-decided attachment for a host that IS sending, or null when the
  // bundle is gone (nothing stands, the token would not fit) or already claimed.
  claim(host: UsualHost): UsualRoutineAttachment | null;
  // Which host took it, for the assertion before dispatch and for tests.
  readonly claimedBy: UsualHost | null;
}

// Plan the window's composed one-tap, or null when there is nothing to plan.
//
// `foodTelegram` is the CONSENT GATE, passed in rather than read here: the bundle
// always contains food writes (it exists only while the food half stands), and
// food-buttons-in-chat is an expressed opt-in. Food-Telegram off means no button on
// either host, which is correct — the dose confirms it also carries are already one
// tap away on the same message, so the gate costs the reader nothing they had.
export function planUsualRoutine(
  profileId: number,
  window: FoodSlot,
  date: string,
  foodTelegram: boolean
): UsualRoutineSlotPlan | null {
  if (!foodTelegram) return null;
  // The derivation, ONCE. Cheap to miss: the food half is the gate, so a profile with
  // no habitual set for this window returns before touching intake at all.
  if (!getUsualRoutineOffer(profileId, window, date)) return null;
  let claimedBy: UsualHost | null = null;
  return {
    window,
    get claimedBy() {
      return claimedBy;
    },
    claim(host: UsualHost): UsualRoutineAttachment | null {
      if (claimedBy) return null;
      // Minted here, against state fresh at the moment the host actually sends.
      const attachment = mintUsualRoutineAttachment(profileId, window, date);
      if (!attachment) return null;
      claimedBy = host;
      return attachment;
    },
  };
}

// The dose reminder is a MERGED send (#1154): one message can cover several slots. It
// takes AT MOST ONE bundle — the first covered window that has one — because two
// "Your usual …" buttons on one keyboard are two bundles a reader has to tell apart,
// and the pre-dispatch assertion says one token per message for exactly that reason.
// Any other window's plan stays unclaimed and falls through to ITS food nudge, which
// is the priority rule doing its job rather than an exception to it.
export function attachUsualForSlots(
  message: NotificationMessage,
  slots: readonly string[],
  plans: ReadonlyMap<FoodSlot, UsualRoutineSlotPlan>
): NotificationMessage {
  for (const slot of slots) {
    const plan = plans.get(slot as FoodSlot);
    const attachment = plan?.claim("dose");
    if (attachment)
      return dispatchableUsual(attachUsualRoutine(message, attachment));
  }
  return message;
}

// THE ASSERTION BEFORE DISPATCH (#2460). One composed one-tap per message, on a
// keyboard that has a family to inherit. A violation drops the DECORATION and sends the
// message: a dose reminder is safety tier and must go out even when its decoration is
// wrong, and an unowned keyboard would sit in the chat forever.
export function dispatchableUsual(
  message: NotificationMessage
): NotificationMessage {
  const problem = usualDispatchProblem(message);
  if (!problem) return message;
  log.error("refusing to dispatch a composed one-tap", { problem });
  return {
    ...message,
    actions: (message.actions ?? []).filter(
      (a) => a.data == null || parseUsualRoutineCallback(a.data) == null
    ),
  };
}
