"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { StreamLifecycleOffer } from "@/lib/queries/stream-lifecycle";
import {
  STREAM_OFFBOARD_KEEP,
  STREAM_OFFBOARD_TURN_OFF,
  STREAM_ONBOARD_ACCEPT,
  STREAM_ONBOARD_DECLINE,
} from "@/lib/integrations/stream-lifecycle";
import type { FormResult } from "@/lib/types";

// ONE on/offboarding offer row (issue #2162).
//
// A client component because every button can legitimately REFUSE: the watch may have
// come back since the page rendered, the offer may already have been answered on
// another device, or a lapse may have ended into a new episode — and each answers with
// a typed outcome the row renders instead of assuming success (the inline-action rule).
//
// TWO BUTTONS, NEVER A TOGGLE. A toggle would imply a state that already exists; these
// are a question with two answers, and the answer that is NOT given leaves everything
// exactly as it was. Both carry the offer's dedupeKey and nothing else, so the write is
// bound to the offer the user actually saw.
export default function StreamLifecycleOfferRow({
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
  const acceptLabel = onboarding
    ? STREAM_ONBOARD_ACCEPT
    : STREAM_OFFBOARD_TURN_OFF;
  const declineLabel = onboarding
    ? STREAM_ONBOARD_DECLINE
    : STREAM_OFFBOARD_KEEP;

  return (
    <li
      data-testid={`stream-offer-${offer.kind}-${offer.provider}`}
      data-stream={offer.streamId}
      className="rounded-xl border border-black/10 bg-slate-50/60 p-3 dark:border-white/10 dark:bg-ink-850/40"
    >
      <p className="font-medium text-slate-800 dark:text-slate-100">
        {offer.title}
      </p>
      <p className="mt-0.5 wrap-break-word text-sm text-slate-600 dark:text-slate-300">
        {offer.body}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(acceptAction)}
          data-testid={`stream-offer-accept-${offer.kind}`}
          title={
            onboarding
              ? `Turn on the bedtime reminder for ${offer.providerName} ${offer.streamLabel} data`
              : "Turn the bedtime reminder off"
          }
          className="btn btn-sm"
        >
          {acceptLabel}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(declineAction)}
          data-testid={`stream-offer-decline-${offer.kind}`}
          title={
            onboarding
              ? "Don't turn it on, and stop offering it for this device"
              : "Leave it on — it resumes by itself when data arrives"
          }
          className="btn-ghost btn-sm"
        >
          {declineLabel}
        </button>
        {offer.href && (
          <Link
            href={offer.href}
            className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            {offer.providerName} sync history →
          </Link>
        )}
      </div>
      {error && (
        <p
          data-testid="stream-offer-outcome"
          role="status"
          className="mt-2 text-xs text-amber-700 dark:text-amber-300"
        >
          {error}
        </p>
      )}
    </li>
  );
}
