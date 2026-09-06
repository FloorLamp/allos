"use client";

import { useState, useTransition } from "react";
import Button from "@/components/Button";
import type { FormResult } from "@/lib/types";

// ONE offer's two answers — THE offer control (issue #4840, ruling 2), generalised
// from the continuous-stream lifecycle's (#2162, #4076). The stream offers still wear
// it through their own wrapper; every registry family (lib/offers.ts) renders it in
// place through components/OfferInPlace.tsx. One control, so an accept and a decline
// cannot drift apart between surfaces.
//
// A client component because every button can legitimately REFUSE: the setting may
// have been set by hand since the page rendered, the offer may already have been
// answered on another device, a stream may have come back — and each answers with a
// typed outcome the caller renders instead of assuming success (the inline-action
// rule).
//
// TWO BUTTONS, NEVER A TOGGLE. A toggle would imply a state that already exists; these
// are a question with two answers, and the answer that is NOT given leaves everything
// exactly as it was. Both carry the offer's key and nothing else, so the write is
// bound to the offer the user actually saw.
export default function OfferControls({
  dedupeKey,
  accept,
  decline,
  acceptAction,
  declineAction,
  outcomeTestId,
}: {
  /** The suppression-bus key this offer lives under — the action's only token. */
  dedupeKey: string;
  accept: { label: string; testId: string };
  decline: { label: string; testId: string };
  acceptAction: (formData: FormData) => Promise<FormResult>;
  declineAction: (formData: FormData) => Promise<FormResult>;
  outcomeTestId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: (formData: FormData) => Promise<FormResult>) {
    setError(null);
    const fd = new FormData();
    fd.set("dedupe_key", dedupeKey);
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) setError(res.error);
    });
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Button
        disabled={pending}
        onClick={() => run(acceptAction)}
        data-testid={accept.testId}
      >
        {accept.label}
      </Button>
      <Button
        disabled={pending}
        onClick={() => run(declineAction)}
        data-testid={decline.testId}
      >
        {decline.label}
      </Button>
      {error && (
        <span
          data-testid={outcomeTestId}
          role="status"
          className="text-xs text-amber-700 dark:text-amber-300"
        >
          {error}
        </span>
      )}
    </span>
  );
}
