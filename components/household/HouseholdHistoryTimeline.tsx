"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import { EmptyState } from "@/components/ui";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import { encounterHref, episodeHref } from "@/lib/hrefs";
import { fmtTemp } from "@/lib/units";
import type { TemperatureUnit } from "@/lib/settings";
import type { HouseholdHistoryItem } from "@/lib/household-history";

// The merged household visit + illness-episode timeline with a per-person toggle
// (issue #1009 Ask 1). A pure FORMATTER over the pre-built, date-ordered stream the
// server gathered (gatherHouseholdHistory) — the "All" view and each per-person view
// are the same list filtered by profileId, so both can't disagree (one computation).
// Person tags ride ON each row (#531/#534): the Avatar's deterministic per-id color +
// the disambiguated name distinguish two same-named people without a spatial cue.

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(dt.getTime())
    ? d
    : dt.toLocaleDateString(undefined, {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export default function HouseholdHistoryTimeline({
  items,
  profiles,
  temperatureUnit,
}: {
  items: HouseholdHistoryItem[];
  profiles: AvatarProfile[];
  temperatureUnit: TemperatureUnit;
}) {
  const [person, setPerson] = useState<number | "all">("all");

  const nameById = useMemo(
    () => disambiguateProfileNames(profiles),
    [profiles]
  );
  const profileById = useMemo(
    () => new Map(profiles.map((p) => [p.id, p])),
    [profiles]
  );
  const nameFor = (id: number) => nameById.get(id) ?? "Someone";

  const shown =
    person === "all" ? items : items.filter((i) => i.profileId === person);

  return (
    <div className="space-y-4">
      {/* Per-person toggle: All + one chip per accessible profile. */}
      <div
        className="flex flex-wrap gap-2"
        data-testid="household-history-filter"
      >
        <FilterChip
          active={person === "all"}
          onClick={() => setPerson("all")}
          testid="household-history-filter-all"
        >
          Everyone
        </FilterChip>
        {profiles.map((p) => (
          <FilterChip
            key={p.id}
            active={person === p.id}
            onClick={() => setPerson(p.id)}
            testid={`household-history-filter-${p.id}`}
          >
            <Avatar profile={p} size="sm" />
            {nameFor(p.id)}
          </FilterChip>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyState
          message={
            person === "all"
              ? "No visits or illness episodes yet across the household. As you log visits and illnesses, they appear here."
              : `No visits or illness episodes yet for ${nameFor(person)}.`
          }
        />
      ) : (
        <ul
          className="flex flex-col gap-2"
          data-testid="household-history-list"
        >
          {shown.map((item) => {
            const p = profileById.get(item.profileId);
            const tag = (
              <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                {p && <Avatar profile={p} size="sm" />}
                {nameFor(item.profileId)}
              </span>
            );
            if (item.kind === "visit") {
              return (
                <li key={`v-${item.encounterId}`}>
                  <Link
                    href={encounterHref(item.encounterId)}
                    className="card block transition hover:shadow-md"
                    data-testid="household-history-row"
                    data-kind="visit"
                    data-profile-id={item.profileId}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
                        {tag}
                        <span className="text-slate-400">·</span>
                        Visit
                      </span>
                      <span className="text-sm text-slate-500 dark:text-slate-400">
                        {fmtDate(item.date)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                      {item.type && <span>{item.type}</span>}
                      {item.reason && <span>{item.reason}</span>}
                      {item.providerName && <span>{item.providerName}</span>}
                    </div>
                  </Link>
                </li>
              );
            }
            const range = `${fmtDate(item.firstDay)} – ${
              item.ongoing ? "ongoing" : fmtDate(item.lastActiveDay)
            }`;
            return (
              <li key={`e-${item.episodeId}`}>
                <Link
                  href={episodeHref(item.episodeId)}
                  className="card block transition hover:shadow-md"
                  data-testid="household-history-row"
                  data-kind="episode"
                  data-profile-id={item.profileId}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
                      {tag}
                      <span className="text-slate-400">·</span>
                      {item.situation}
                    </span>
                    <span className="text-sm text-slate-500 dark:text-slate-400">
                      {range}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                    {item.dayCount != null && <span>{item.dayCount}-day</span>}
                    {item.maxTempF != null && (
                      <span>
                        peak {fmtTemp(item.maxTempF, temperatureUnit)}
                      </span>
                    )}
                    {item.symptomLabels.length > 0 && (
                      <span>
                        {item.symptomLabels.slice(0, 4).join(", ")}
                        {item.symptomLabels.length > 4 ? "…" : ""}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  testid,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      data-active={active}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition ${
        active
          ? "border-sky-500 bg-sky-50 font-medium text-sky-700 dark:border-sky-400 dark:bg-sky-950 dark:text-sky-300"
          : "border-black/10 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
      }`}
    >
      {children}
    </button>
  );
}
