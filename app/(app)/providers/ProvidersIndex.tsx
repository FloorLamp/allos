"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  IconStethoscope,
  IconBuildingHospital,
  IconSearch,
} from "@tabler/icons-react";
import type { ProviderIndexRow } from "@/lib/queries";

type TypeFilter = "all" | "individual" | "organization";

// The /providers index (issue #275): search + type filter + per-profile activity
// count per provider. The list is global (all providers on the instance); the
// activity number is the ACTIVE profile's (0 for a provider only others have seen).
export default function ProvidersIndex({
  providers,
  profileName,
}: {
  providers: ProviderIndexRow[];
  profileName: string;
}) {
  const [q, setQ] = useState("");
  const [type, setType] = useState<TypeFilter>("all");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return providers.filter((p) => {
      if (type !== "all" && p.type !== type) return false;
      if (!needle) return true;
      return (
        p.name.toLowerCase().includes(needle) || (p.npi ?? "").includes(needle)
      );
    });
  }, [providers, q, type]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
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
        <select
          className="input max-w-[10rem]"
          value={type}
          onChange={(e) => setType(e.target.value as TypeFilter)}
          data-testid="provider-type-filter"
        >
          <option value="all">All kinds</option>
          <option value="individual">Individuals</option>
          <option value="organization">Organizations</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-black/10 p-10 text-center text-sm text-slate-400 dark:border-white/10 dark:text-slate-500">
          No providers match. They’re added automatically when you import a
          health record’s care team.
        </p>
      ) : (
        <ul
          className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/5 dark:divide-white/10 dark:border-white/10"
          data-testid="provider-list"
        >
          {filtered.map((p) => {
            const Icon =
              p.type === "individual" ? IconStethoscope : IconBuildingHospital;
            return (
              <li key={p.id}>
                <Link
                  href={`/providers/${p.id}`}
                  className="flex items-center justify-between gap-3 bg-white/60 px-4 py-3 transition hover:bg-slate-50 dark:bg-black/10 dark:hover:bg-ink-800"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Icon
                      className="h-5 w-5 shrink-0 text-slate-400"
                      stroke={1.75}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-slate-800 dark:text-slate-100">
                        {p.name}
                      </span>
                      {p.npi ? (
                        <span className="block truncate text-xs tabular-nums text-slate-400 dark:text-slate-500">
                          NPI {p.npi}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                    {p.activity > 0
                      ? `${p.activity} ${p.activity === 1 ? "record" : "records"}`
                      : "—"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-4 px-1 text-xs text-slate-400 dark:text-slate-500">
        Record counts are {profileName}’s. Providers are shared across everyone
        on this instance.
      </p>
    </div>
  );
}
