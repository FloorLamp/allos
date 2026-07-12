import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import SettingsTabs from "../SettingsTabs";
import {
  queryAuditEvents,
  auditFilterOptions,
  type AuditFilters,
} from "@/lib/audit-query";
import { AUDIT_PAGE_SIZE, clampPage, pageCount } from "@/lib/audit-actions";

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
function pageHref(sp: SearchParams, page: number): string {
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
  const { profile } = await requireAdmin();

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
    <div>
      <PageHeader
        title="Settings"
        subtitle="Audit log — who accessed or modified which profile's data. Auth events, PHI access (medical files, share links), and admin/family changes. Identifiers only, never medical content. Retained 90 days."
      />
      <SettingsTabs isAdmin />

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

      {rows.length === 0 ? (
        <div
          className="rounded-xl border border-dashed border-black/10 bg-white p-10 text-center text-sm text-slate-400 dark:border-white/10 dark:bg-ink-900 dark:text-slate-500"
          data-testid="audit-empty"
        >
          No audit events match these filters.
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="audit-table">
              <thead>
                <tr className="border-b border-black/5 text-left text-xs uppercase tracking-wide text-slate-400 dark:border-white/10 dark:text-slate-500">
                  <th className="td whitespace-nowrap">Time (UTC)</th>
                  <th className="td">Login</th>
                  <th className="td">Action</th>
                  <th className="td">Profile</th>
                  <th className="td">Target</th>
                  <th className="td">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b border-black/5 align-top dark:border-white/10"
                    data-testid="audit-row"
                  >
                    <td className="td whitespace-nowrap text-slate-500 dark:text-slate-400">
                      {e.ts}
                    </td>
                    <td className="td">
                      {e.username ??
                        (e.login_id != null ? `#${e.login_id}` : "—")}
                    </td>
                    <td className="td font-mono text-xs">{e.action}</td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {e.profile_name ??
                        (e.active_profile_id != null
                          ? `#${e.active_profile_id}`
                          : "—")}
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {e.target ?? "—"}
                    </td>
                    <td className="td break-words text-slate-500 dark:text-slate-400">
                      {e.detail ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pager: server-side LIMIT/OFFSET, so we never ship the whole table. */}
      <div className="mt-3 flex items-center justify-between text-xs text-slate-400 dark:text-slate-500">
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
    </div>
  );
}
