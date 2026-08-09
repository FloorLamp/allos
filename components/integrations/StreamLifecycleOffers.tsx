import { IconDeviceWatch } from "@tabler/icons-react";
import { getStreamLifecycleOffers } from "@/lib/queries/stream-lifecycle";
import {
  acceptStreamReminder,
  declineStreamReminder,
  dismissStreamReminderOffer,
  keepStreamReminder,
} from "@/app/(app)/stream-lifecycle-actions";
import StreamLifecycleOfferRow from "./StreamLifecycleOfferRow";

// The continuous-stream on/offboarding offers (issue #2162), as a card.
//
// ── Where this renders, and why none of it is a send ─────────────────────────
//
// The same component on two CLASS-2 surfaces (docs/internals/findings.md §1 — rendered
// aggregates, which cost nothing until the user opens a page):
//
//   • the integrations surface (Data → Import, under "Connect a device or service") —
//     the post-connect moment, where the user already is when a new wearable starts
//     delivering;
//   • the dashboard, once, above the customizable grid — dismissible, and gone for
//     good once answered.
//
// One component for both, per the shared-content rule: the offer must not be able to
// say two different things, and the accept must not be able to behave two different
// ways. Nothing here reaches a notification, a digest section, or an attention list —
// `getStreamLifecycleOffers` is its own entry point precisely so it CANNOT
// (`getIntegrationAttention` feeds the morning digest; this does not join it).
//
// Silence is the normal state: with no live offer the component renders nothing at
// all, which is what every profile sees on almost every day.

export default async function StreamLifecycleOffers({
  profileId,
  canWrite,
  className,
}: {
  profileId: number;
  /**
   * The acting session's access on this profile. Every affordance here CHANGES a
   * profile-owned setting or writes a dismissal, so a read-only caregiver is shown
   * nothing rather than two buttons whose write core would refuse them. Not a
   * substitute for the actions' own `requireWriteAccess` — that is the gate; this is
   * the UX on top of it.
   */
  canWrite: boolean;
  className?: string;
}) {
  if (!canWrite) return null;
  const offers = getStreamLifecycleOffers(profileId);
  if (offers.length === 0) return null;

  return (
    <div
      className={`card ${className ?? "mb-6"}`}
      data-testid="stream-lifecycle-offers"
    >
      <div className="mb-3 flex items-center gap-2">
        <IconDeviceWatch
          className="h-5 w-5 text-slate-500 dark:text-slate-400"
          stroke={1.75}
          aria-hidden="true"
        />
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Bedtime watch reminder
        </h2>
      </div>
      <ul className="space-y-3">
        {offers.map((offer) => (
          <StreamLifecycleOfferRow
            key={offer.key}
            offer={offer}
            // The accept/decline PAIR is chosen by the offer's kind, once, here — so a
            // row can never wire "Keep them ready" to the action that turns the
            // reminder off.
            acceptAction={
              offer.kind === "onboard"
                ? acceptStreamReminder
                : declineStreamReminder
            }
            declineAction={
              offer.kind === "onboard"
                ? dismissStreamReminderOffer
                : keepStreamReminder
            }
          />
        ))}
      </ul>
    </div>
  );
}
