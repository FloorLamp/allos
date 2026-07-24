import Link from "next/link";
import { notFound } from "next/navigation";
import {
  IconArrowLeft,
  IconBuildingHospital,
  IconStethoscope,
} from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
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
  getProviderImaging,
  getProviderVision,
  getProviderDental,
  getProviderSkin,
  getProviderMergeImpact,
  getAffiliatesFor,
  getSuggestedAffiliations,
  type ProviderActivityItem,
} from "@/lib/queries";
import { formatMergeImpact, providerDisambigLabel } from "@/lib/provider-merge";
import { formatRecordDate } from "@/lib/record-format";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import ProviderIdentityCard from "../ProviderIdentityCard";
import ProviderMergePanel from "../ProviderMergePanel";
import ProviderAffiliations from "../ProviderAffiliations";

export const dynamic = "force-dynamic";

// Provider detail (issue #275). The header identity card is GLOBAL shared state
// (admin-only edit); everything below it is scoped to the ACTIVE profile — a member
// never learns which other profiles see this provider. All the activity reads
// filter profile_id (lib/queries/providers), and the page labels that scope.

// One expandable activity section: a count chip that opens a per-profile listing.
function ActivitySection({
  label,
  items,
  fmt,
}: {
  label: string;
  items: ProviderActivityItem[];
  fmt: DisplayFormatPrefs;
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
                {it.date ? formatRecordDate(it.date, "", fmt) : ""}
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
  fmt,
}: {
  label: string;
  value: string | null;
  fmt: DisplayFormatPrefs;
}) {
  return (
    <div className="rounded-lg border border-black/5 bg-white/60 px-4 py-3 dark:border-white/10 dark:bg-black/10">
      <div className="section-label">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
        {value ? formatRecordDate(value, "—", fmt) : "—"}
      </div>
    </div>
  );
}

export default async function ProviderDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { profile, login } = await requireSession();
  const fmt = getDisplayFormatPrefs(login.id);
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
    { label: "Imaging", items: getProviderImaging(profile.id, id) },
    { label: "Vision", items: getProviderVision(profile.id, id) },
    { label: "Dental", items: getProviderDental(profile.id, id) },
    { label: "Skin", items: getProviderSkin(profile.id, id) },
  ];
  const totalActivity = sections.reduce((n, s) => n + s.items.length, 0);

  // Merge candidates (admin only): every OTHER provider, with a count-only impact
  // summary of what absorbing THAT provider would move (global, across profiles).
  // Each carries a composite disambiguation label (#532) so two same-named rows —
  // the case merge targets — never render as byte-identical option/confirm text.
  // Affiliations (issue #1055): the linked counterparts, the derived suggestions
  // involving this provider, and the opposite-type names for the manual picker (the
  // registry is global; suggestions are the acting profile's co-occurrence).
  const affiliates = getAffiliatesFor(id, provider.type);
  const counterpartType =
    provider.type === "individual" ? "organization" : "individual";
  const affiliateIds = new Set(affiliates.map((a) => a.id));
  const affiliationSuggestions = getSuggestedAffiliations(profile.id).filter(
    (s) => s.individualId === id || s.organizationId === id
  );
  const counterpartProviders = getProviders().filter(
    (p) =>
      p.type === counterpartType &&
      p.archived === 0 &&
      p.id !== id &&
      !affiliateIds.has(p.id)
  );

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
    <PageContainer width="reading" data-testid="provider-detail">
      <Link
        href="/records/care/providers"
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

      {/* Affiliations — linked edges (read-only for members) + admin suggest/link. */}
      <ProviderAffiliations
        providerId={id}
        providerType={provider.type}
        affiliates={affiliates}
        suggestions={affiliationSuggestions}
        counterpartProviders={counterpartProviders}
        canEdit={isAdmin}
      />

      {/* Relationship strip (per-profile). */}
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <RelationshipStat
          label="First seen"
          value={relationship.firstSeen}
          fmt={fmt}
        />
        <RelationshipStat
          label="Most recent visit"
          value={relationship.lastVisit}
          fmt={fmt}
        />
        <RelationshipStat
          label="Next appointment"
          value={relationship.nextAppointment}
          fmt={fmt}
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
              <ActivitySection
                key={s.label}
                label={s.label}
                items={s.items}
                fmt={fmt}
              />
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
    </PageContainer>
  );
}
