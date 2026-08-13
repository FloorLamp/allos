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
  getProviderActivityCounts,
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
import { PageHeader, EmptyState } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import ProviderIdentityCard from "../ProviderIdentityCard";
import ProviderMergePanel from "../ProviderMergePanel";
import ProviderAffiliations from "../ProviderAffiliations";
import { NavTabsStrip } from "@/components/NavTabs";

export const dynamic = "force-dynamic";

// Provider detail (issue #275). The header identity card is GLOBAL shared state
// (admin-only edit); everything below it is scoped to the ACTIVE profile — a member
// never learns which other profiles see this provider. All the activity reads
// filter profile_id (lib/queries/providers), and the page labels that scope.

// The selected provider-activity tab's compact per-profile listing.
function ActivityList({
  id,
  items,
  fmt,
}: {
  id: string;
  items: ProviderActivityItem[];
  fmt: DisplayFormatPrefs;
}) {
  return (
    <ul
      role="tabpanel"
      data-testid={`provider-activity-panel-${id}`}
      className="divide-y divide-black/5 overflow-hidden rounded-b-xl border-x border-b border-black/5 dark:divide-white/10 dark:border-white/10"
    >
      {items.map((it) => (
        <li key={`${id}-${it.id}`}>
          <Link
            href={it.href}
            className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition hover:bg-slate-50 dark:hover:bg-ink-800"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium text-slate-800 dark:text-slate-100">
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
  );
}

function RelationshipStat({
  label,
  value,
  fmt,
  className = "",
}: {
  label: string;
  value: string | null;
  fmt: DisplayFormatPrefs;
  className?: string;
}) {
  return (
    <div className={`py-3 sm:px-4 ${className}`}>
      <div className="section-label">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
        {value ? formatRecordDate(value, "—", fmt) : "—"}
      </div>
    </div>
  );
}

export default async function ProviderDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;
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

  const activityCounts = getProviderActivityCounts(profile.id, id);
  const activityDefinitions: Array<{
    id: string;
    label: string;
    count: number;
    load: () => ProviderActivityItem[];
  }> = [
    {
      id: "visits",
      label: "Visits",
      count: activityCounts.visits,
      load: () => getProviderVisits(profile.id, id),
    },
    {
      id: "labs",
      label: "Labs",
      count: activityCounts.labs,
      load: () => getProviderLabs(profile.id, id),
    },
    {
      id: "medications",
      label: "Medications",
      count: activityCounts.medications,
      load: () => getProviderMedications(profile.id, id),
    },
    {
      id: "immunizations",
      label: "Immunizations",
      count: activityCounts.immunizations,
      load: () => getProviderImmunizations(profile.id, id),
    },
    {
      id: "procedures",
      label: "Procedures",
      count: activityCounts.procedures,
      load: () => getProviderProcedures(profile.id, id),
    },
    {
      id: "care-plan",
      label: "Care plan",
      count: activityCounts.carePlan,
      load: () => getProviderCarePlan(profile.id, id),
    },
    {
      id: "appointments",
      label: "Appointments",
      count: activityCounts.appointments,
      load: () => getProviderAppointments(profile.id, id),
    },
    {
      id: "imaging",
      label: "Imaging",
      count: activityCounts.imaging,
      load: () => getProviderImaging(profile.id, id),
    },
    {
      id: "vision",
      label: "Vision",
      count: activityCounts.vision,
      load: () => getProviderVision(profile.id, id),
    },
    {
      id: "dental",
      label: "Dental",
      count: activityCounts.dental,
      load: () => getProviderDental(profile.id, id),
    },
    {
      id: "skin",
      label: "Skin",
      count: activityCounts.skin,
      load: () => getProviderSkin(profile.id, id),
    },
  ];
  const availableActivity = activityDefinitions.filter(
    (item) => item.count > 0
  );
  const requestedActivity = Array.isArray(searchParams.activity)
    ? searchParams.activity[0]
    : searchParams.activity;
  const activeActivity =
    availableActivity.find((item) => item.id === requestedActivity) ??
    availableActivity[0];
  const activityItems = activeActivity?.load() ?? [];
  const totalActivity = availableActivity.reduce(
    (total, item) => total + item.count,
    0
  );

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
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="provider-detail"
    >
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
      <div className="mt-6 grid divide-y divide-black/5 border-y border-black/5 sm:grid-cols-3 sm:divide-x sm:divide-y-0 dark:divide-white/5 dark:border-white/5">
        <RelationshipStat
          label="First seen"
          value={relationship.firstSeen}
          fmt={fmt}
          className="sm:pl-0"
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
          className="sm:pr-0"
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
          <EmptyState
            compact
            testId="provider-no-activity"
            message={`${profile.name} has no records linked to this provider yet.`}
          />
        ) : (
          <div data-testid="provider-activity-tabs">
            <NavTabsStrip
              tabs={availableActivity.map((item) => ({
                id: item.id,
                label: `${item.label} (${item.count})`,
              }))}
              paramKey="activity"
              activeId={activeActivity?.id}
              prominentOnMobile
              mobileLayout="scroll"
              flush
            />
            {activeActivity ? (
              <ActivityList
                id={activeActivity.id}
                items={activityItems}
                fmt={fmt}
              />
            ) : null}
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
