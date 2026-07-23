import { MEDICAL_DISCLAIMER } from "@/lib/disclaimers";
import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getImmunizations,
  getImmunityTiters,
  getImmunizationOverrides,
  getImmunizationOverride,
  getProviderNames,
} from "@/lib/queries";
import ProviderDatalist from "@/components/ProviderDatalist";
import { getUserSex, profileAgeMonths } from "@/lib/settings";
import {
  assessSchedule,
  type VaccineAssessment,
} from "@/lib/immunization-status";
import {
  vaccineByCode,
  vaccineDisplayName,
  vaccineDescription,
  scheduleSummary,
  expandToComponents,
} from "@/lib/immunization-catalog";
import { PageHeader, EmptyState } from "@/components/ui";
import { statusBadge } from "../status-ui";
import OverrideControls from "./OverrideControls";
import VaccineDoseHistory from "../VaccineDoseHistory";

export const dynamic = "force-dynamic";

// Per-vaccine detail view: full dose history, recommended schedule,
// relevant titers, the computed status, and the override controls. Profile-scoped
// like every other read on this route.
export default async function VaccineDetailPage(props: {
  params: Promise<{ vaccine: string }>;
}) {
  const params = await props.params;
  const { profile } = await requireSession();
  // Next already URL-decodes route params; decoding again throws a URIError on a
  // malformed segment (e.g. "/immunizations/%25"). Use it as-is — an unknown code
  // then degrades to the EmptyState below rather than a 500.
  const code = params.vaccine;
  const entry = vaccineByCode(code);

  if (!entry) {
    return (
      <div>
        <Link
          href="/records/history/immunizations"
          className="mb-4 inline-flex items-center gap-1 text-sm text-brand-700 hover:underline dark:text-brand-400"
        >
          <IconArrowLeft className="h-4 w-4" /> Back to immunizations
        </Link>
        <PageHeader title={vaccineDisplayName(code)} />
        <EmptyState message="Unknown vaccine. This detail view covers the tracked catalog vaccines." />
      </div>
    );
  }

  const now = today(profile.id);
  const sex = getUserSex(profile.id);
  // Canonical age-in-months policy (issue #310): birthdate wins, else stored
  // whole-year age × 12 — shared so this page agrees with the schedule/Upcoming.
  const ageMonths = profileAgeMonths(profile.id, now);

  const records = getImmunizations(profile.id);
  const titers = getImmunityTiters(profile.id);
  const overrides = getImmunizationOverrides(profile.id);
  const summary = assessSchedule(
    records.map((r) => ({ vaccine: r.vaccine, date: r.date })),
    ageMonths,
    sex,
    now,
    titers.map((t) => ({ marker: t.marker, status: t.status })),
    overrides.map((o) => ({ vaccine: o.vaccine, kind: o.kind }))
  );
  const a: VaccineAssessment =
    summary.assessments.find((x) => x.code === code) ?? summary.assessments[0];

  // Doses that credit this vaccine: its own code plus any combination shot whose
  // components include it (so a Vaxelis dose shows on the DTaP detail, labeled).
  // Full stored rows so the detail list can edit/delete each dose in place.
  const doses = records.filter((r) =>
    expandToComponents(r.vaccine).includes(code)
  );

  // Titer readings that bear on this vaccine's antigen (case-insensitive against
  // the catalog's antibody markers).
  const markerSet = new Set(entry.antibodyMarkers.map((m) => m.toLowerCase()));
  const relevantTiters = titers.filter((t) =>
    markerSet.has(t.marker.toLowerCase())
  );

  const override = getImmunizationOverride(profile.id, code);
  const badge = statusBadge(a);
  const desc = vaccineDescription(code);

  return (
    <div>
      {/* Provider picker options for the inline dose-edit form. */}
      <ProviderDatalist names={getProviderNames()} />
      <Link
        href="/records/history/immunizations"
        className="mb-4 inline-flex items-center gap-1 text-sm text-brand-700 hover:underline dark:text-brand-400"
      >
        <IconArrowLeft className="h-4 w-4" /> Back to immunizations
      </Link>

      <PageHeader
        title={entry.name}
        subtitle={desc ?? undefined}
        action={<span className={`badge ${badge.cls}`}>{badge.text}</span>}
      />

      {/* Status summary. */}
      <div className="card mb-6 flex flex-wrap items-center gap-x-8 gap-y-3">
        <div>
          <div className="label">Status</div>
          <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {a.detail}
          </div>
        </div>
        <div>
          <div className="label">Doses</div>
          <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {a.dosesReceived}
            {a.dosesRequired != null ? ` / ${a.dosesRequired}` : ""}
          </div>
        </div>
        <div>
          <div className="label">Last dose</div>
          <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {a.lastDate ?? "—"}
          </div>
        </div>
        {a.nextLabel && (
          <div>
            <div className="label">Next</div>
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {a.nextLabel}
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/* Recommended schedule. */}
          <div className="card">
            <h2 className="mb-2 font-semibold text-slate-800 dark:text-slate-100">
              Recommended schedule
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {scheduleSummary(entry)}
            </p>
            {entry.schedule.kind === "series" && (
              <ol className="mt-3 space-y-1 text-sm text-slate-600 dark:text-slate-300">
                {entry.schedule.doses.map((d, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                      {i + 1}
                    </span>
                    <span>{d.label}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* Dose history for this vaccine. */}
          <div className="card overflow-hidden p-0">
            <h2 className="px-5 pt-5 font-semibold text-slate-800 dark:text-slate-100">
              Dose history{" "}
              <span className="text-sm font-normal text-slate-400">
                ({doses.length})
              </span>
            </h2>
            {doses.length === 0 ? (
              <p className="px-5 py-4 text-sm text-slate-500 dark:text-slate-400">
                No recorded doses for this vaccine.
              </p>
            ) : (
              <VaccineDoseHistory code={code} doses={doses} defaultDate={now} />
            )}
          </div>

          {/* Relevant titers. */}
          {entry.antibodyMarkers.length > 0 && (
            <div className="card">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Immunity titers
              </h2>
              {relevantTiters.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  No antibody/titer results on file for this vaccine (
                  {entry.antibodyMarkers.join(", ")}). They appear automatically
                  when a matching lab result is added under{" "}
                  <Link href="/results/biomarkers" className="underline">
                    Biomarkers
                  </Link>
                  .
                </p>
              ) : (
                <div className="divide-y divide-black/5 dark:divide-white/5">
                  {relevantTiters.map((t) => (
                    <div
                      key={t.marker}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                          {t.marker}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {t.value ?? "—"} {t.unit ?? ""}
                          {t.date ? ` · ${t.date}` : ""}
                        </div>
                      </div>
                      <span
                        className={`badge shrink-0 ${
                          t.status === "immune"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                            : t.status === "non_immune"
                              ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                              : "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
                        }`}
                      >
                        {t.status === "immune"
                          ? "Immune"
                          : t.status === "non_immune"
                            ? "Non-immune"
                            : "Indeterminate"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <OverrideControls vaccine={code} current={override} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            {MEDICAL_DISCLAIMER} Overrides affect only how this profile&rsquo;s
            schedule is scored here.
          </p>
        </div>
      </div>
    </div>
  );
}
