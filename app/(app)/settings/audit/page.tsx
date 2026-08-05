import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { formatTimestamp } from "@/lib/format-date";
import SettingsGroupLayout from "../SettingsGroupLayout";
import {
  queryAuditEvents,
  auditFilterOptions,
  type AuditFilters,
} from "@/lib/audit-query";
import { AUDIT_PAGE_SIZE, clampPage, pageCount } from "@/lib/audit-actions";
import type { AppRoute } from "@/lib/hrefs";
import LogTable from "@/components/LogTable";

export const dynamic = "force-dynamic";

type SearchParams = {
  login?: string;
  action?: string;
  profile?: string;
  page?: string;
};

// Turn a possibly-empty/garbage query value into a positive integer id, or null.
function intOrNull(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Build the querystring for a target page, preserving the active filters.
function pageHref(sp: SearchParams, page: number): AppRoute {
  const q = new URLSearchParams();
  if (sp.login) q.set("login", sp.login);
  if (sp.action) q.set("action", sp.action);
  if (sp.profile) q.set("profile", sp.profile);
  q.set("page", String(page));
  return `/settings/audit?${q.toString()}`;
}

export default async function AuditLogPage(props: {
  searchParams: Promise<SearchParams>;
}) {
  const searchParams = await props.searchParams;
  // The audit log spans every profile (who accessed/modified whose data), so it's
  // admin-only — a member is redirected out by requireAdmin().
  const { login, profile } = await requireAdmin();
  // The admin ops tables (Audit / Errors / AI logs) render ONE timestamp shape
  // through the shared formatter, read as UTC (issue #1448). This column used to
  // print SQLite's raw `2026-07-24 22:14:15` verbatim while its sibling tables
  // called toLocaleString() — three admin screens, two conventions.
  const formatPrefs = getDisplayFormatPrefs(login.id);

  const filters: AuditFilters = {
    loginId: intOrNull(searchParams.login),
    profileId: intOrNull(searchParams.profile),
    actionPrefix: searchParams.action || null,
  };
  const page = clampPage(Number(searchParams.page) || 1);

  const { rows, total } = queryAuditEvents(filters, page, AUDIT_PAGE_SIZE);
  const { logins, profiles, actionDomains } = auditFilterOptions();
  const pages = pageCount(total, AUDIT_PAGE_SIZE);

  return (
    <SettingsGroupLayout group="logs" login={login} profile={profile}>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Who accessed or modified which profile&rsquo;s data — identifiers only,
        never medical content.
      </p>

      {/* Filters (plain GET form so it works without JS and is bookmarkable). */}
      <form
        method="GET"
        className="mb-4 flex flex-wrap items-end gap-2"
        data-testid="audit-filters"
      >
        <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
          Login
          <select
            name="login"
            defaultValue={searchParams.login ?? ""}
            className="input"
          >
            <option value="">All</option>
            {logins.map((l) => (
              <option key={l.id} value={l.id}>
                {l.username}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
          Action
          <select
            name="action"
            defaultValue={searchParams.action ?? ""}
            className="input"
          >
            <option value="">All</option>
            {actionDomains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
          Profile
          <select
            name="profile"
            defaultValue={searchParams.profile ?? ""}
            className="input"
          >
            <option value="">All</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn">
          Filter
        </button>
        {(searchParams.login ||
          searchParams.action ||
          searchParams.profile) && (
          <Link href="/settings/audit" className="btn-ghost">
            Clear
          </Link>
        )}
      </form>

      <LogTable
        columns={[
          { label: "Time (UTC)", className: "whitespace-nowrap" },
          { label: "Login" },
          { label: "Action" },
          { label: "Profile" },
          { label: "Target" },
          { label: "Detail" },
        ]}
        isEmpty={rows.length === 0}
        emptyMessage="No audit events match these filters."
        emptyTestId="audit-empty"
        tableTestId="audit-table"
      >
        {rows.map((e) => (
          <tr
            key={e.id}
            className="border-b border-black/5 align-top dark:border-white/10"
            data-testid="audit-row"
          >
            <td className="td whitespace-nowrap text-slate-500 dark:text-slate-400">
              {formatTimestamp(e.ts, formatPrefs, { zone: "utc" })}
            </td>
            <td className="td">
              {e.username ?? (e.login_id != null ? `#${e.login_id}` : "—")}
            </td>
            <td className="td font-mono text-xs">{e.action}</td>
            <td className="td text-slate-500 dark:text-slate-400">
              {e.profile_name ??
                (e.active_profile_id != null ? `#${e.active_profile_id}` : "—")}
            </td>
            <td className="td text-slate-500 dark:text-slate-400">
              {e.target ?? "—"}
            </td>
            <td className="td break-words text-slate-500 dark:text-slate-400">
              {e.detail ?? ""}
            </td>
          </tr>
        ))}
      </LogTable>

      {/* Pager: server-side LIMIT/OFFSET, so we never ship the whole table. */}
      <div className="mt-3 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span data-testid="audit-total">{total} events</span>
        <div className="flex items-center gap-3">
          {page > 1 ? (
            <Link href={pageHref(searchParams, page - 1)} className="btn-ghost">
              Previous
            </Link>
          ) : (
            <span className="opacity-40">Previous</span>
          )}
          <span>
            Page {Math.min(page, pages)} of {pages}
          </span>
          {page < pages ? (
            <Link href={pageHref(searchParams, page + 1)} className="btn-ghost">
              Next
            </Link>
          ) : (
            <span className="opacity-40">Next</span>
          )}
        </div>
      </div>
    </SettingsGroupLayout>
  );
}
