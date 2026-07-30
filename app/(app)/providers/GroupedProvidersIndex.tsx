"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  IconStethoscope,
  IconBuildingHospital,
  IconSearch,
  IconPhone,
  IconArchive,
  IconChevronDown,
} from "@tabler/icons-react";
import type { DirectoryProvider, GroupedDirectory } from "@/lib/queries";
import { providersEmptyMessage } from "@/lib/providers";

// The grouped, activity-aware provider directory (issue #1055): organizations as
// cards with their affiliated individuals nested, unaffiliated individuals in their
// own section, archived providers behind a disclosure. Falls back to the flat list
// (today's #275 behavior) when there are no affiliation edges yet OR the user is
// searching. Recency-first everywhere so a stale one-visit provider doesn't outrank
// the pediatrician. The list is global; the activity counts are the acting profile's.
export default function GroupedProvidersIndex({
  directory,
  profileName,
}: {
  directory: GroupedDirectory;
  profileName: string;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();

  const flatFiltered = useMemo(() => {
    if (!needle) return directory.flat;
    return directory.flat.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.npi ?? "").includes(needle) ||
        (p.specialty ?? "").toLowerCase().includes(needle)
    );
  }, [directory.flat, needle]);

  // Grouping only makes sense on the full (unsearched) view with edges present.
  const showGrouped = !needle && directory.hasEdges;
  const activeOrgs = directory.orgs.filter(
    (group) =>
      group.org.activity > 0 ||
      group.members.some((member) => member.activity > 0)
  );
  const otherOrgs = directory.orgs.filter(
    (group) =>
      group.org.activity === 0 &&
      group.members.every((member) => member.activity === 0)
  );
  const activeIndividuals = directory.unaffiliated.filter(
    (provider) => provider.activity > 0
  );
  const otherIndividuals = directory.unaffiliated.filter(
    (provider) => provider.activity === 0
  );
  const otherCount =
    otherOrgs.reduce((count, group) => count + group.members.length + 1, 0) +
    otherIndividuals.length;

  return (
    <div>
      <div className="mb-4">
        <div className="relative">
          <IconSearch
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            stroke={1.75}
          />
          <input
            className="input pl-9"
            placeholder="Search providers…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="provider-search"
          />
        </div>
      </div>

      {showGrouped ? (
        <div className="space-y-6" data-testid="provider-directory-grouped">
          {activeOrgs.map((group) => (
            <OrganizationGroup key={group.org.id} group={group} />
          ))}

          {activeIndividuals.length > 0 ? (
            <div>
              <div className="section-label mb-2">Other individuals</div>
              <ul className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/5 dark:divide-white/10 dark:border-white/10">
                {activeIndividuals.map((p) => (
                  <li key={p.id}>
                    <ProviderRow p={p} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {otherCount > 0 ? (
            <details
              className="group rounded-xl border border-black/5 dark:border-white/10"
              data-testid="provider-other-disclosure"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-slate-600 [&::-webkit-details-marker]:hidden dark:text-slate-300">
                <span className="flex-1">
                  Other directory entries ({otherCount})
                </span>
                <IconChevronDown className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-4 border-t border-black/5 p-3 dark:border-white/10">
                {otherOrgs.map((group) => (
                  <OrganizationGroup key={group.org.id} group={group} />
                ))}
                {otherIndividuals.length > 0 ? (
                  <ul className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/5 dark:divide-white/10 dark:border-white/10">
                    {otherIndividuals.map((provider) => (
                      <li key={provider.id}>
                        <ProviderRow p={provider} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      ) : (
        <FlatList providers={flatFiltered} hasQuery={needle.length > 0} />
      )}

      {directory.archivedCount > 0 ? (
        <details
          className="mt-6 rounded-xl border border-black/5 dark:border-white/10"
          data-testid="provider-archived-disclosure"
        >
          <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium text-slate-600 dark:text-slate-300">
            <IconArchive className="h-4 w-4 text-slate-400" stroke={1.75} />
            Archived ({directory.archivedCount})
          </summary>
          <ul className="divide-y divide-black/5 border-t border-black/5 dark:divide-white/10 dark:border-white/10">
            {directory.archived.map((p) => (
              <li key={p.id}>
                <ProviderRow p={p} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="mt-4 px-1 text-xs text-slate-500 dark:text-slate-400">
        Showing providers linked to {profileName}’s records first. The provider
        directory is shared across everyone on this instance.
      </p>
    </div>
  );
}

function OrganizationGroup({
  group,
}: {
  group: GroupedDirectory["orgs"][number];
}) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-black/5 bg-white/60 dark:border-white/10 dark:bg-black/10"
      data-testid="provider-org-card"
    >
      <ProviderRow p={group.org} heading />
      {group.members.length > 0 ? (
        <ul className="divide-y divide-black/5 border-t border-black/5 pl-4 dark:divide-white/10 dark:border-white/10">
          {group.members.map((member) => (
            <li key={member.id}>
              <ProviderRow p={member} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FlatList({
  providers,
  hasQuery,
}: {
  providers: DirectoryProvider[];
  hasQuery: boolean;
}) {
  if (providers.length === 0) {
    return (
      <p
        data-testid="provider-empty"
        className="rounded-xl border border-dashed border-black/10 p-10 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400"
      >
        {providersEmptyMessage(hasQuery)}
      </p>
    );
  }
  return (
    <ul
      className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/5 dark:divide-white/10 dark:border-white/10"
      data-testid="provider-list"
    >
      {providers.map((p) => (
        <li key={p.id}>
          <ProviderRow p={p} />
        </li>
      ))}
    </ul>
  );
}

function ProviderRow({
  p,
  heading = false,
}: {
  p: DirectoryProvider;
  heading?: boolean;
}) {
  const Icon = p.type === "individual" ? IconStethoscope : IconBuildingHospital;
  return (
    <div
      className={`flex items-center justify-between gap-3 px-4 py-3 ${
        heading ? "bg-slate-50/60 dark:bg-white/5" : ""
      }`}
      data-testid="provider-row"
    >
      <Link
        href={p.href}
        className="flex min-w-0 flex-1 items-center gap-2.5 hover:underline"
      >
        <Icon className="h-5 w-5 shrink-0 text-slate-400" stroke={1.75} />
        <span className="min-w-0">
          <span
            className={`block truncate ${
              heading
                ? "font-semibold text-slate-800 dark:text-slate-100"
                : "font-medium text-slate-800 dark:text-slate-100"
            }`}
          >
            {p.name}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
            {p.specialty ? (
              <span
                className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                data-testid="provider-specialty-chip"
              >
                {p.specialty}
              </span>
            ) : null}
            {p.npi ? <span className="tabular-nums">NPI {p.npi}</span> : null}
          </span>
        </span>
      </Link>
      <span className="flex shrink-0 items-center gap-3">
        {p.phone ? (
          <a
            href={`tel:${p.phone.replace(/[^\d+]/g, "")}`}
            className="text-slate-400 hover:text-brand-700 dark:hover:text-brand-300"
            aria-label={`Call ${p.name}`}
            data-testid="provider-tel"
            onClick={(e) => e.stopPropagation()}
          >
            <IconPhone className="h-4 w-4" stroke={1.75} />
          </a>
        ) : null}
        <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
          {p.activity > 0
            ? `${p.activity} ${p.activity === 1 ? "record" : "records"}`
            : "—"}
        </span>
      </span>
    </div>
  );
}
