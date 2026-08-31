"use client";

import DestinationLink from "@/components/DestinationLink";
import type { StreamLifecycleOffer } from "@/lib/queries/stream-lifecycle";
import StreamLifecycleOfferControls from "./StreamLifecycleOfferControls";
import type { FormResult } from "@/lib/types";

// ONE on/offboarding offer row (issue #2162) — the integrations surface's shape: the
// offer's question, its two answers, and the consequence of each spelled underneath.
// The answers themselves are the SHARED StreamLifecycleOfferControls (#4076), which
// the dashboard row hosts in its trailing slot, so the pair cannot drift apart.
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
  const onboarding = offer.kind === "onboard";
  return (
    <li
      data-testid={`stream-offer-${offer.kind}-${offer.sourceId}`}
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
        <StreamLifecycleOfferControls
          offer={offer}
          acceptAction={acceptAction}
          declineAction={declineAction}
        />
        {offer.href && (
          <DestinationLink href={offer.href} className="text-sm text-link">
            {offer.sourceName} sync history
          </DestinationLink>
        )}
      </div>
      <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
        {onboarding
          ? `Accepting covers ${offer.sourceName} ${offer.streamLabel} data; declining stops offering it for this device.`
          : "Turning them off stops the bedtime reminder; keeping them ready resumes it by itself when data arrives."}
      </p>
    </li>
  );
}
