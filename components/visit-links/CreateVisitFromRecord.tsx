import {
  createVisitFromRecordAction,
  declineCreateVisitAction,
} from "@/app/(app)/visit-links/actions";
import type { CreateVisitOffer } from "@/lib/queries";

// "Create a visit from this record?" (#1099). Some records imply a visit happened (an
// optical Rx ⇒ an eye exam, a completed dental procedure ⇒ a dental visit, an imaging
// study ⇒ a radiology visit) but no encounter row exists. This block offers a one-tap
// affordance to create a skeleton encounter from the record — NEVER a silent
// auto-create. Read-time derived: it only renders for records dated D with NO
// encounter that day (an existing same-day encounter defers to #1050's link/picker),
// so a late-arriving encounter self-heals the prompt away.
//
// Server component: create/decline are plain server-action <form>s (no client JS),
// each settling as a POST the e2e helpers await. `profileId` rides each form as the
// cross-profile write target.

const DOMAIN_HINT: Record<CreateVisitOffer["domain"], string> = {
  optical: "This prescription implies an eye exam.",
  dental: "This dental record implies a visit.",
  imaging: "This imaging study implies a radiology visit.",
};

export default function CreateVisitFromRecord({
  profileId,
  offers,
}: {
  profileId: number;
  offers: CreateVisitOffer[];
}) {
  if (offers.length === 0) return null;

  return (
    <section
      className="rounded-xl border border-brand-200 bg-brand-50/60 p-4 shadow-sm sm:p-6 dark:border-brand-900 dark:bg-brand-950/30"
      data-testid="create-visit-from-record"
    >
      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
        Create a visit from this record?
      </h2>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {offers.length} record{offers.length === 1 ? "" : "s"} look like a visit
        happened, but there&rsquo;s no visit on that day yet.
      </p>
      <ul className="mt-3 space-y-2">
        {offers.map((o) => (
          <li
            key={`${o.domain}-${o.id}`}
            className="flex items-center justify-between gap-3 text-sm"
            data-testid="create-visit-offer"
          >
            <span className="min-w-0 text-slate-800 dark:text-slate-100">
              {o.label || DOMAIN_HINT[o.domain]}
              <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                {o.date}
              </span>
            </span>
            <div className="flex shrink-0 items-center gap-3">
              <form action={createVisitFromRecordAction}>
                <input type="hidden" name="profileId" value={profileId} />
                <input type="hidden" name="domain" value={o.domain} />
                <input type="hidden" name="recordId" value={o.id} />
                <button
                  type="submit"
                  data-testid="create-visit-accept"
                  className="text-xs font-semibold text-brand-700 transition hover:underline dark:text-brand-300"
                >
                  Create visit
                </button>
              </form>
              <form action={declineCreateVisitAction}>
                <input type="hidden" name="profileId" value={profileId} />
                <input type="hidden" name="domain" value={o.domain} />
                <input type="hidden" name="recordId" value={o.id} />
                <button
                  type="submit"
                  data-testid="create-visit-decline"
                  className="text-xs font-medium text-slate-400 transition hover:text-rose-600 dark:hover:text-rose-400"
                >
                  Not now
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
