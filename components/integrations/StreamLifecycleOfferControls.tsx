"use client";

import { useState, useTransition } from "react";
import Button from "@/components/Button";
import type { StreamLifecycleOffer } from "@/lib/queries/stream-lifecycle";
import {
  STREAM_OFFBOARD_KEEP,
  STREAM_OFFBOARD_TURN_OFF,
  STREAM_ONBOARD_ACCEPT,
  STREAM_ONBOARD_DECLINE,
} from "@/lib/integrations/stream-lifecycle";
import type { FormResult } from "@/lib/types";

// ONE offer's two answers (issue #2162), shared by the two surfaces that ask it: the
// integrations row and — since #4076 — the dashboard row's trailing control slot.
// Extracted so the pair cannot drift apart between them.
//
// A client component because every button can legitimately REFUSE: the watch may have
// come back since the page rendered, the offer may already have been answered on
// another device, or a lapse may have ended into a new episode — and each answers with
// a typed outcome the caller renders instead of assuming success (the inline-action
// rule).
//
// TWO BUTTONS, NEVER A TOGGLE. A toggle would imply a state that already exists; these
// are a question with two answers, and the answer that is NOT given leaves everything
// exactly as it was. Both carry the offer's dedupeKey and nothing else, so the write is
// bound to the offer the user actually saw.
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
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: (formData: FormData) => Promise<FormResult>) {
    setError(null);
    const fd = new FormData();
    fd.set("dedupe_key", offer.key);
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) setError(res.error);
    });
  }

  const onboarding = offer.kind === "onboard";
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Button
        disabled={pending}
        onClick={() => run(acceptAction)}
        data-testid={`stream-offer-accept-${offer.kind}`}
      >
        {onboarding ? STREAM_ONBOARD_ACCEPT : STREAM_OFFBOARD_TURN_OFF}
      </Button>
      <Button
        disabled={pending}
        onClick={() => run(declineAction)}
        data-testid={`stream-offer-decline-${offer.kind}`}
      >
        {onboarding ? STREAM_ONBOARD_DECLINE : STREAM_OFFBOARD_KEEP}
      </Button>
      {error && (
        <span
          data-testid="stream-offer-outcome"
          role="status"
          className="text-xs text-amber-700 dark:text-amber-300"
        >
          {error}
        </span>
      )}
    </span>
  );
}
