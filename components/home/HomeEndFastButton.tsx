"use client";

import { useState } from "react";
import { useToast } from "@/components/Toast";
import InlineError from "@/components/InlineError";
import { endFastAction } from "@/app/(app)/nutrition/fast-actions";

// HOME'S FAST ROW ENDS A FAST AND DOES NOTHING ELSE (#5435 §3.2).
//
// The Fast row states what is running — "Fast · elapsed · since clock" — and offers the
// one tap that closes it. Its START door is the quick-log sheet's row (#3208,
// re-affirmed 2026-09-10), and every other fasting affordance (backdating, discard,
// correction, history) stays on the Nutrition card, which is the surface those questions
// belong to.
//
// SO THIS IS NOT A SECOND `FastingCard`. It posts the SAME `endFastAction` that card
// posts, with no backdated instant — the action re-checks the transition under the write
// lock and answers with a typed refusal, so a page open since yesterday lands on an
// honest message rather than a double-end. It adds no state of its own and decides
// nothing: whether the row renders at all is the composer's answer (`lib/home-list.ts`),
// read off one open-episode lifecycle (#5142).
//
// ENDING IS NEVER REFUSED for a fast that is open, which is why there is no state prop:
// a restriction that arrives MID-FAST still leaves the way out (lib/adult-only-writes.ts
// — the same stranding argument the cycle domain makes for ending an open period).
export default function HomeEndFastButton() {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await endFastAction(new FormData());
      if (result.ok) toast(result.message);
      else setError(result.error);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-ghost btn-sm"
        disabled={pending}
        data-testid="home-end-fast"
        onClick={() => void run()}
      >
        End fast
      </button>
      {error ? <InlineError>{error}</InlineError> : null}
    </>
  );
}
