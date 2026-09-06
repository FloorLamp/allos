"use client";

import OfferControls from "@/components/OfferControls";
import type { StreamLifecycleOffer } from "@/lib/queries/stream-lifecycle";
import {
  STREAM_OFFBOARD_KEEP,
  STREAM_OFFBOARD_TURN_OFF,
  STREAM_ONBOARD_ACCEPT,
  STREAM_ONBOARD_DECLINE,
} from "@/lib/integrations/stream-lifecycle";
import type { FormResult } from "@/lib/types";

// The stream lifecycle offers' two answers (issue #2162), on the shared offer control
// (#4840): this wrapper only chooses the pair of labels by the offer's kind, so the
// integrations row and the dashboard row's trailing slot (#4076) cannot wire "Keep
// them ready" to different words.
export default function StreamLifecycleOfferControls({
  offer,
  acceptAction,
  declineAction,
}: {
  offer: StreamLifecycleOffer;
  /** Onboarding: "Yes, remind me". Offboarding: "Turn them off". */
  acceptAction: (formData: FormData) => Promise<FormResult>;
  /** Onboarding: "No thanks". Offboarding: "Keep them ready". */
  declineAction: (formData: FormData) => Promise<FormResult>;
}) {
  const onboarding = offer.kind === "onboard";
  return (
    <OfferControls
      dedupeKey={offer.key}
      accept={{
        label: onboarding ? STREAM_ONBOARD_ACCEPT : STREAM_OFFBOARD_TURN_OFF,
        testId: `stream-offer-accept-${offer.kind}`,
      }}
      decline={{
        label: onboarding ? STREAM_ONBOARD_DECLINE : STREAM_OFFBOARD_KEEP,
        testId: `stream-offer-decline-${offer.kind}`,
      }}
      acceptAction={acceptAction}
      declineAction={declineAction}
      outcomeTestId="stream-offer-outcome"
    />
  );
}
