"use client";

import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { doseConfirmMessage } from "@/lib/dose-outcome-text";
import type { DoseConfirmResult } from "@/lib/dose-outcome-text";

// The dose-confirm form for surfaces whose feedback channel is a toast (#2106): the
// household card's per-member "Confirm" and the dashboard attention hero's "Mark
// taken". Both are registered under the `dose-status` one-tap affordance, whose
// declared feedback is `outcome-toast` — the tap is ANSWERED from markDoseTaken's
// typed outcome and never confirmed unconditionally (the #280 rule, the same
// rendering the quick-entry dose list and the Telegram tap already do).
//
// The server parent passes the action (each surface keeps its own gate: the
// household confirm re-checks write access on the CARD's profile, the hero on the
// acting one) plus the hidden id fields; this component only renders the answer:
// a refusal — item paused, dose retired, dose standing as skipped — toasts in the
// error tone and the row stays, because it is still due; a success toasts the
// outcome's own wording ("Dose logged" / "Already logged as taken").
export default function DoseConfirmButton({
  action,
  fields,
  className,
  testid,
  children,
}: {
  action: (formData: FormData) => Promise<DoseConfirmResult>;
  // Hidden form fields posted with the action — ids only, never objects.
  fields: Record<string, string | number>;
  className?: string;
  testid?: string;
  children: React.ReactNode;
}) {
  const toast = useToast();

  async function confirm(fd: FormData) {
    let result: DoseConfirmResult;
    try {
      result = await action(fd);
    } catch {
      toast("Couldn't log that dose. Try again.", { tone: "error" });
      return;
    }
    if (!result.ok) {
      toast(result.error, { tone: "error" });
      return;
    }
    const { text, tone } = doseConfirmMessage(result.outcome);
    toast(text, { tone });
  }

  return (
    <form action={confirm} className="shrink-0">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton pendingLabel="…" data-testid={testid} className={className}>
        {children}
      </SubmitButton>
    </form>
  );
}
