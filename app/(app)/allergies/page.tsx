import Link from "next/link";
import { requireSession } from "@/lib/auth";
import {
  getAllergies,
  getAllergiesView,
  getCrossReactivityNotes,
} from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import AllergyForm from "./AllergyForm";
import AllergyList from "./AllergyList";
import { addAllergy } from "./actions";

export const dynamic = "force-dynamic";

// Allergies: documented allergies (CCD Allergies section + manual) merged
// with lab-derived allergen-specific IgE sensitizations (read-time; RAST /
// ImmunoCAP). The merged view leads; the stored rows are managed below.
export default async function AllergiesPage() {
  const { profile } = await requireSession();
  const view = getAllergiesView(profile.id);
  const stored = getAllergies(profile.id);
  const crossReactivity = getCrossReactivityNotes(profile.id);

  return (
    <div>
      <PageHeader
        title="Allergies"
        subtitle="Documented allergies plus allergen-specific IgE sensitizations detected from your labs. A key emergency-card field."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <div className="card">
            <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              Known allergies &amp; sensitizations
            </h2>
            {view.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No known allergies recorded. Positive allergen-specific IgE lab
                results (e.g. “Peanut IgE”) will also appear here — add them
                under{" "}
                <Link href="/biomarkers" className="underline">
                  Biomarkers
                </Link>
                .
              </p>
            ) : (
              <ul className="divide-y divide-black/5 dark:divide-white/5">
                {view.map((a) => (
                  <li
                    key={a.key}
                    className="flex items-start justify-between gap-4 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-800 dark:text-slate-100">
                          {a.substance}
                        </span>
                        {a.origin !== "documented" && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                            {a.origin === "both" ? "labs confirm" : "from labs"}
                          </span>
                        )}
                      </div>
                      {(a.severity || a.reaction) && (
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {[a.severity, a.reaction].filter(Boolean).join(" · ")}
                        </div>
                      )}
                      {a.evidence && (
                        <div className="text-xs text-slate-400">
                          {a.evidence.marker}
                          {a.evidence.value ? ` · ${a.evidence.value}` : ""}
                          {a.evidence.rastClass != null
                            ? ` · class ${a.evidence.rastClass}`
                            : ""}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {crossReactivity.length > 0 && (
            <div className="card" data-testid="cross-reactivity">
              <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
                Cross-reactivity
              </h2>
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Allergens on record that are commonly associated with reactions
                to related substances. Informational reference only — a
                documented cross-reactivity does not mean you will react.
              </p>
              <ul className="space-y-3">
                {crossReactivity.map((c) => (
                  <li key={c.familyId} data-testid="cross-reactivity-item">
                    <div className="text-sm text-slate-800 dark:text-slate-100">
                      <span className="font-medium">
                        {c.triggers.join(", ")}
                      </span>{" "}
                      commonly cross-reacts with{" "}
                      <span className="text-slate-600 dark:text-slate-300">
                        {c.related.join(", ")}
                      </span>
                      .
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {c.label} · {c.citation}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              Recorded allergies{" "}
              <span className="text-sm font-normal text-slate-400">
                ({stored.length})
              </span>
            </h2>
            <AllergyList items={stored} />
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <AllergyForm action={addAllergy} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Informational only, not medical advice. Allergen-specific IgE
            (RAST/ImmunoCAP) results are surfaced as sensitizations when above
            range or class ≥ 1; total serum IgE is excluded.
          </p>
        </div>
      </div>
    </div>
  );
}
