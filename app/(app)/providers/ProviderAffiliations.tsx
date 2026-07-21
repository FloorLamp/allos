"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconLink, IconX, IconPlus } from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import type { ProviderType } from "@/lib/types";
import type {
  AffiliatedProviderRef,
  AffiliationSuggestionView,
} from "@/lib/queries";
import {
  linkAffiliationAction,
  acceptAffiliationAction,
  declineAffiliationAction,
  unlinkAffiliationAction,
} from "./actions";

// The affiliation strip on a provider's detail page (issue #1055): the linked
// individual↔organization edges ("Practices at:" for an individual, "People:" for an
// organization), the derived suggestions (accept/decline), and — for an admin — a
// manual "Affiliated with…" picker over the opposite provider type. All edges are
// GLOBAL registry state, so the write buttons show only when `canEdit` (admin); a
// member sees the linked edges read-only.
export default function ProviderAffiliations({
  providerId,
  providerType,
  affiliates,
  suggestions,
  counterpartNames,
  canEdit,
}: {
  providerId: number;
  providerType: ProviderType;
  affiliates: AffiliatedProviderRef[];
  suggestions: AffiliationSuggestionView[];
  counterpartNames: string[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const counterpartType: ProviderType =
    providerType === "individual" ? "organization" : "individual";
  const heading = providerType === "individual" ? "Practices at" : "People";
  const distinctNames = Array.from(new Set(counterpartNames));

  async function run(
    action: (fd: FormData) => Promise<{ error?: string }>,
    fd: FormData,
    ok: string
  ) {
    setError(null);
    const res = await action(fd);
    if (res?.error) {
      setError(res.error);
      return;
    }
    toast(ok);
    router.refresh();
  }

  return (
    <div className="mt-6" data-testid="provider-affiliations">
      <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        {heading}
      </h2>

      {affiliates.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No affiliations yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="affiliation-list">
          {affiliates.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-black/5 bg-white/60 px-3 py-2 text-sm dark:border-white/10 dark:bg-black/10"
            >
              <Link
                href={`/providers/${a.id}`}
                className="inline-flex min-w-0 items-center gap-1.5 text-brand-700 hover:underline dark:text-brand-300"
              >
                <IconLink className="h-4 w-4 shrink-0" stroke={1.75} />
                <span className="truncate">{a.name}</span>
                {a.specialty ? (
                  <span className="badge shrink-0 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {a.specialty}
                  </span>
                ) : null}
              </Link>
              {canEdit ? (
                <button
                  type="button"
                  className="btn-ghost shrink-0 p-1"
                  aria-label={`Remove affiliation with ${a.name}`}
                  data-testid="affiliation-unlink"
                  onClick={() => {
                    const fd = new FormData();
                    fd.set("id", String(providerId));
                    fd.set("other_id", String(a.id));
                    run(unlinkAffiliationAction, fd, "Affiliation removed");
                  }}
                >
                  <IconX className="h-4 w-4" stroke={1.75} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit && suggestions.length > 0 ? (
        <div className="mt-3" data-testid="affiliation-suggestions">
          <div className="section-label mb-1">Suggested from your visits</div>
          <ul className="flex flex-col gap-2">
            {suggestions.map((s) => {
              const otherId =
                s.individualId === providerId
                  ? s.organizationId
                  : s.individualId;
              const otherName =
                s.individualId === providerId
                  ? s.organizationName
                  : s.individualName;
              return (
                <li
                  key={`${s.individualId}-${s.organizationId}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-black/10 px-3 py-2 text-sm dark:border-white/10"
                >
                  <span className="min-w-0">
                    <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                      {otherName}
                    </span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {s.sharedVisits}{" "}
                      {s.sharedVisits === 1 ? "shared visit" : "shared visits"}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1.5">
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      data-testid="affiliation-accept"
                      onClick={() => {
                        const fd = new FormData();
                        fd.set("individual_id", String(s.individualId));
                        fd.set("organization_id", String(s.organizationId));
                        run(acceptAffiliationAction, fd, "Affiliation linked");
                      }}
                    >
                      Link
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-xs text-slate-500"
                      data-testid="affiliation-decline"
                      onClick={() => {
                        const fd = new FormData();
                        fd.set("individual_id", String(s.individualId));
                        fd.set("organization_id", String(s.organizationId));
                        run(
                          declineAffiliationAction,
                          fd,
                          "Suggestion dismissed"
                        );
                      }}
                    >
                      Dismiss
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {canEdit ? (
        <form
          className="mt-3 flex items-end gap-2"
          data-testid="affiliation-add-form"
          action={(fd) => {
            fd.set("id", String(providerId));
            fd.set("counterpart_type", counterpartType);
            run(linkAffiliationAction, fd, "Affiliation linked");
          }}
        >
          <div className="min-w-0 flex-1">
            <label className="label" htmlFor="affiliation-name">
              Affiliated with…
            </label>
            <input
              id="affiliation-name"
              name="name"
              list="affiliation-names"
              className="input"
              placeholder={
                counterpartType === "organization"
                  ? "e.g. Sample Care East"
                  : "e.g. Dr. Chen"
              }
            />
            <datalist id="affiliation-names">
              {distinctNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>
          <SubmitButton className="btn inline-flex items-center gap-1.5">
            <IconPlus className="h-4 w-4" stroke={1.75} />
            Link
          </SubmitButton>
        </form>
      ) : null}

      {error ? (
        <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>
      ) : null}
    </div>
  );
}
