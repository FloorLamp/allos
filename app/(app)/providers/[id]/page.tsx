import Link from "next/link";
import { notFound } from "next/navigation";
import {
  IconArrowLeft,
  IconBuildingHospital,
  IconStethoscope,
} from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getProvider,
  getProviders,
  getProviderRelationship,
  getProviderVisits,
  getProviderLabs,
  getProviderMedications,
  getProviderImmunizations,
  getProviderProcedures,
  getProviderCarePlan,
  getProviderAppointments,
  getProviderMergeImpact,
  type ProviderActivityItem,
} from "@/lib/queries";
import { formatMergeImpact, providerDisambigLabel } from "@/lib/provider-merge";
import { formatRecordDate } from "@/lib/record-format";
import { PageHeader } from "@/components/ui";
import ProviderIdentityCard from "../ProviderIdentityCard";
import ProviderMergePanel from "../ProviderMergePanel";

export const dynamic = "force-dynamic";

// Provider detail (issue #275). The header identity card is GLOBAL shared state
// (admin-only edit); everything below it is scoped to the ACTIVE profile — a member
// never learns which other profiles see this provider. All the activity reads
// filter profile_id (lib/queries/providers), and the page labels that scope.

// One expandable activity section: a count chip that opens a per-profile listing.
function ActivitySection({
  label,
  items,
}: {
  label: string;
  items: ProviderActivityItem[];
}) {
  if (items.length === 0) return null;
  return (
    <details className="rounded-lg border border-black/5 bg-white/60 dark:border-white/10 dark:bg-black/10">
      <summary
        className="flex cursor-pointer items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-slate-700 dark:text-slate-200"
        data-testid={`activity-summary-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <span>{label}</span>
        <span className="badge bg-brand-100 tabular-nums text-brand-700 dark:bg-brand-950 dark:text-brand-300">
          {items.length}
        </span>
      </summary>
      <ul className="divide-y divide-black/5 border-t border-black/5 dark:divide-white/10 dark:border-white/10">
        {items.map((it) => (
          <li key={`${label}-${it.id}`}>
            <Link
              href={it.href}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition hover:bg-slate-50 dark:hover:bg-ink-800"
            >
              <span className="min-w-0">
                <span className="block truncate text-slate-800 dark:text-slate-100">
                  {it.label}
                </span>
                {it.sublabel ? (
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                    {it.sublabel}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                {it.date ? formatRecordDate(it.date, "") : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

function RelationshipStat({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div className="rounded-lg border border-black/5 bg-white/60 px-4 py-3 dark:border-white/10 dark:bg-black/10">
      <div className="section-label">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
        {value ? formatRecordDate(value, "—") : "—"}
      </div>
    </div>
  );
}

export default async function ProviderDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { profile, login } = await requireSession();
  const id = Number(params.id);
  const provider = id ? getProvider(id) : undefined;
  if (!provider) notFound();

  const isAdmin = login.role === "admin";
  const relationship = getProviderRelationship(
    profile.id,
    id,
    today(profile.id)
  );

  const sections: { label: string; items: ProviderActivityItem[] }[] = [
    { label: "Visits", items: getProviderVisits(profile.id, id) },
    { label: "Labs", items: getProviderLabs(profile.id, id) },
    { label: "Medications", items: getProviderMedications(profile.id, id) },
    {
      label: "Immunizations",
      items: getProviderImmunizations(profile.id, id),
    },
    { label: "Procedures", items: getProviderProcedures(profile.id, id) },
    { label: "Care plan", items: getProviderCarePlan(profile.id, id) },
    { label: "Appointments", items: getProviderAppointments(profile.id, id) },
  ];
  const totalActivity = sections.reduce((n, s) => n + s.items.length, 0);

  // Merge candidates (admin only): every OTHER provider, with a count-only impact
  // summary of what absorbing THAT provider would move (global, across profiles).
  // Each carries a composite disambiguation label (#532) so two same-named rows —
  // the case merge targets — never render as byte-identical option/confirm text.
  const allProviders = isAdmin ? getProviders() : [];
  const candidates = isAdmin
    ? allProviders
        .filter((p) => p.id !== id)
        .map((p) => ({
          id: p.id,
          name: p.name,
          label: providerDisambigLabel(p, allProviders),
          type: p.type,
          impact: formatMergeImpact(getProviderMergeImpact(p.id)),
        }))
    : [];
  const survivorLabel = providerDisambigLabel(provider, allProviders);

  const TypeIcon =
    provider.type === "individual" ? IconStethoscope : IconBuildingHospital;

  return (
    <div className="max-w-3xl" data-testid="provider-detail">
      <Link
        href="/providers"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
      >
        <IconArrowLeft className="h-4 w-4" stroke={1.75} />
        Back to providers
      </Link>

      <PageHeader
        title={provider.name}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <TypeIcon className="h-4 w-4" stroke={1.75} />
            {provider.type === "individual" ? "Individual" : "Organization"}
          </span>
        }
      />

      {/* Global identity card — admin-only edit. */}
      <ProviderIdentityCard provider={provider} canEdit={isAdmin} />

      {/* Relationship strip (per-profile). */}
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <RelationshipStat label="First seen" value={relationship.firstSeen} />
        <RelationshipStat
          label="Most recent visit"
          value={relationship.lastVisit}
        />
        <RelationshipStat
          label="Next appointment"
          value={relationship.nextAppointment}
        />
      </div>

      {/* Per-profile activity. */}
      <div className="mt-6">
        <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
          Activity
        </h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          Showing {profile.name}’s records with this provider.
        </p>
        {totalActivity === 0 ? (
          <p
            className="rounded-lg border border-dashed border-black/10 px-4 py-6 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400"
            data-testid="provider-no-activity"
          >
            {profile.name} has no records linked to this provider yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {sections.map((s) => (
              <ActivitySection key={s.label} label={s.label} items={s.items} />
            ))}
          </div>
        )}
      </div>

      {/* Merge duplicates — admin only, global operation. */}
      {isAdmin ? (
        <ProviderMergePanel
          survivor={{
            id: provider.id,
            name: provider.name,
            label: survivorLabel,
          }}
          candidates={candidates}
        />
      ) : null}

      <p className="mt-6 px-1 text-xs text-slate-500 dark:text-slate-400">
        Providers are a shared registry across everyone on this instance. The
        identity above is global; the activity is only {profile.name}’s.
      </p>
    </div>
  );
}
