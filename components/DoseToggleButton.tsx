"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { toggleTaken } from "@/app/(app)/medicine/actions";
import { localDate, shouldQueueOffline } from "@/lib/offline/queue";

// Dose check-off button used by both MedicationCard and EditableSupplementRow
// (issue #28). Online it calls the toggleTaken Server Action exactly as the old
// plain <form> did. Offline it QUEUES a "mark taken" confirm — an idempotent
// set-to-taken the replay route applies once — and shows optimistic checked state.
//
// Only MARKING taken is queueable: the offline queue models logged doses (a dose
// confirm), not un-logging, so an offline tap on an already-taken dose is refused
// with a hint rather than silently dropped. className/ariaLabel are functions of the
// (possibly optimistic) taken state so the caller keeps full control of styling.
export default function DoseToggleButton({
  doseId,
  supplementId,
  taken,
  className,
  ariaLabel,
  children,
}: {
  doseId: number;
  supplementId: number;
  taken: boolean;
  className: (taken: boolean) => string;
  ariaLabel: (taken: boolean) => string;
  children: React.ReactNode;
}) {
  // null = follow the server-provided `taken`; a boolean = optimistic override held
  // after an offline queue (there's no revalidate to refresh it).
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const isTaken = optimistic ?? taken;
  const router = useRouter();
  const toast = useToast();
  const { enqueue } = useOfflineQueue();

  async function queueTaken() {
    setOptimistic(true);
    await enqueue("dose", localDate(), { doseId });
    toast("Dose saved offline — will sync when you reconnect.");
  }

  async function onClick() {
    if (busy) return;
    const online =
      typeof navigator === "undefined" || navigator.onLine !== false;

    if (!online) {
      if (isTaken) {
        toast("You're offline — reconnect to change a logged dose.", {
          tone: "error",
        });
        return;
      }
      await queueTaken();
      return;
    }

    setBusy(true);
    const fd = new FormData();
    fd.set("dose_id", String(doseId));
    fd.set("supplement_id", String(supplementId));
    try {
      await toggleTaken(fd);
      setOptimistic(null);
      router.refresh();
    } catch (err) {
      // Connection dropped mid-submit: queue a confirm when we were marking taken;
      // otherwise surface a retry.
      const stillOnline = navigator.onLine !== false;
      if (!isTaken && shouldQueueOffline(stillOnline, err)) {
        await queueTaken();
      } else {
        toast("Couldn't update this dose. Please try again.", {
          tone: "error",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={className(isTaken)}
      aria-label={ariaLabel(isTaken)}
    >
      {children}
    </button>
  );
}
