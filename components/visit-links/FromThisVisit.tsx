import {
  linkAllFromVisitAction,
  dismissAllFromVisitAction,
  linkRecordVisitAction,
  declineRecordVisitAction,
  unlinkRecordVisitAction,
} from "@/app/(app)/visit-link-actions";
import type { VisitLinkedRow } from "@/lib/queries";
import type {
  EncounterFromVisit,
  VisitLinkDomain,
} from "@/lib/visit-link-suggest";

// The encounter detail page's "From this visit" section (rows already linked) + the
// "From this visit?" suggestion block (read-time date/provider matches the user
// accepts) — #1050. Server component: every accept/dismiss/unlink is a plain
// server-action <form>, so it needs no client JS and settles as a POST the e2e
// helpers await. `profileId` rides each form as the cross-profile write target.

const DOMAIN_LABEL: Record<Exclude<VisitLinkDomain, "episode">, string> = {
  medication: "Medication started",
  condition: "Diagnosis",
  procedure: "Procedure",
  imaging: "Imaging",
  immunization: "Immunization",
  optical: "Prescription",
  dental: "Dental",
  // #1526: the last two clinical observations to gain a visit link.
  skin: "Skin lesion",
  allergy: "Allergy",
};

function pairsJson(suggestions: EncounterFromVisit["suggestions"]): string {
  return JSON.stringify(
    suggestions.map((s) => ({ domain: s.record.domain, recordId: s.record.id }))
  );
}

export default function FromThisVisit({
  profileId,
  encounterId,
  linkedRows,
  suggestions,
}: {
  profileId: number;
  encounterId: number;
  linkedRows: VisitLinkedRow[];
  suggestions: EncounterFromVisit;
}) {
  const hasLinked = linkedRows.length > 0;
  const hasSuggestions = suggestions.suggestions.length > 0;
  if (!hasLinked && !hasSuggestions) return null;

  return (
    <div className="mt-6 space-y-6" data-testid="from-this-visit">
      {hasLinked ? (
        <section className="border-t border-black/5 pt-5 dark:border-white/5">
          <h2 className="mb-3 text-base font-semibold text-slate-800 dark:text-slate-100">
            From this visit
          </h2>
          <ul
            className="divide-y divide-black/5 dark:divide-white/5"
            data-testid="visit-linked-rows"
          >
            {linkedRows.map((r) => (
              <li
                key={`${r.domain}-${r.id}`}
                className="flex items-start justify-between gap-4 py-3 text-sm first:pt-0 last:pb-0"
              >
                <span className="min-w-0 text-slate-800 dark:text-slate-100">
                  <span className="section-label mb-1 block">
                    {DOMAIN_LABEL[r.domain]}
                  </span>
                  {r.label}
                </span>
                <form action={unlinkRecordVisitAction}>
                  <input type="hidden" name="profileId" value={profileId} />
                  <input type="hidden" name="domain" value={r.domain} />
                  <input type="hidden" name="recordId" value={r.id} />
                  <button
                    type="submit"
                    className="shrink-0 text-xs font-medium text-slate-400 transition hover:text-rose-600 dark:hover:text-rose-400"
                  >
                    Unlink
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {hasSuggestions ? (
        <section
          className="border-l-2 border-brand-400 pl-4"
          data-testid="from-this-visit-suggestions"
        >
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            From this visit?
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {suggestions.suggestions.length} record
            {suggestions.suggestions.length === 1 ? "" : "s"} dated the same day
            look like they belong to this visit.
          </p>
          <ul className="mt-3 divide-y divide-black/5 dark:divide-white/5">
            {suggestions.suggestions.map((s) => (
              <li
                key={`${s.record.domain}-${s.record.id}`}
                className="flex flex-col items-start justify-between gap-3 py-3 text-sm first:pt-0 sm:flex-row sm:items-center"
              >
                <span className="min-w-0 text-slate-800 dark:text-slate-100">
                  <span className="section-label mb-1 block">
                    {DOMAIN_LABEL[
                      s.record.domain as Exclude<VisitLinkDomain, "episode">
                    ] ?? "Record"}
                  </span>
                  {s.record.label}
                  {s.confidence === "strong" ? (
                    <span className="ml-2 rounded-sm bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      same provider
                    </span>
                  ) : null}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <form action={linkRecordVisitAction}>
                    <input type="hidden" name="profileId" value={profileId} />
                    <input
                      type="hidden"
                      name="domain"
                      value={s.record.domain}
                    />
                    <input type="hidden" name="recordId" value={s.record.id} />
                    <input
                      type="hidden"
                      name="encounterId"
                      value={encounterId}
                    />
                    <button type="submit" className="btn btn-sm">
                      Link
                    </button>
                  </form>
                  <form action={declineRecordVisitAction}>
                    <input type="hidden" name="profileId" value={profileId} />
                    <input
                      type="hidden"
                      name="domain"
                      value={s.record.domain}
                    />
                    <input type="hidden" name="recordId" value={s.record.id} />
                    <input
                      type="hidden"
                      name="encounterId"
                      value={encounterId}
                    />
                    <button type="submit" className="btn-ghost btn-sm">
                      Dismiss
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <form action={linkAllFromVisitAction}>
              <input type="hidden" name="profileId" value={profileId} />
              <input type="hidden" name="encounterId" value={encounterId} />
              <input
                type="hidden"
                name="pairs"
                value={pairsJson(suggestions.suggestions)}
              />
              <button
                type="submit"
                data-testid="link-all-from-visit"
                className="btn btn-sm"
              >
                Link all
              </button>
            </form>
            <form action={dismissAllFromVisitAction}>
              <input type="hidden" name="profileId" value={profileId} />
              <input type="hidden" name="encounterId" value={encounterId} />
              <input
                type="hidden"
                name="pairs"
                value={pairsJson(suggestions.suggestions)}
              />
              <button
                type="submit"
                className="text-xs font-medium text-slate-500 transition hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400"
              >
                Dismiss all
              </button>
            </form>
          </div>
        </section>
      ) : null}
    </div>
  );
}
