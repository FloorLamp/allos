import {
  linkAllFromVisitAction,
  dismissAllFromVisitAction,
  linkRecordVisitAction,
  declineRecordVisitAction,
  unlinkRecordVisitAction,
} from "@/app/(app)/visit-links/actions";
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
    <div className="mt-4 space-y-4" data-testid="from-this-visit">
      {hasLinked ? (
        <section className="rounded-xl border border-black/5 bg-white/60 p-4 shadow-sm sm:p-6 dark:border-white/10 dark:bg-black/10">
          <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
            From this visit
          </h2>
          <ul className="space-y-2" data-testid="visit-linked-rows">
            {linkedRows.map((r) => (
              <li
                key={`${r.domain}-${r.id}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="min-w-0 text-slate-800 dark:text-slate-100">
                  <span className="section-label mr-2">
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
          className="rounded-xl border border-brand-200 bg-brand-50/60 p-4 shadow-sm sm:p-6 dark:border-brand-900 dark:bg-brand-950/30"
          data-testid="from-this-visit-suggestions"
        >
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            From this visit?
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {suggestions.suggestions.length} record
            {suggestions.suggestions.length === 1 ? "" : "s"} dated the same day
            look like they belong to this visit.
          </p>
          <ul className="mt-3 space-y-2">
            {suggestions.suggestions.map((s) => (
              <li
                key={`${s.record.domain}-${s.record.id}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="min-w-0 text-slate-800 dark:text-slate-100">
                  <span className="section-label mr-2">
                    {DOMAIN_LABEL[
                      s.record.domain as Exclude<VisitLinkDomain, "episode">
                    ] ?? "Record"}
                  </span>
                  {s.record.label}
                  {s.confidence === "strong" ? (
                    <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      same provider
                    </span>
                  ) : null}
                </span>
                <div className="flex shrink-0 items-center gap-3">
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
                    <button
                      type="submit"
                      className="text-xs font-semibold text-brand-700 transition hover:underline dark:text-brand-300"
                    >
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
                    <button
                      type="submit"
                      className="text-xs font-medium text-slate-400 transition hover:text-rose-600 dark:hover:text-rose-400"
                    >
                      Dismiss
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center gap-3">
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
