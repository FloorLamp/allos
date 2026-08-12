import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { readNotifyEvents } from "@/lib/notify-log";
import {
  filterNotifyRuns,
  groupNotifyRuns,
  NOTIFY_RUN_PAGE_SIZE,
  type NotifyLevel,
  type NotifyLogFilters,
} from "@/lib/notify-log-format";
import { clampPage, pageCount, pageOffset } from "@/lib/pagination";
import type { AppRoute } from "@/lib/hrefs";
import SettingsGroupLayout from "../SettingsGroupLayout";
import NotifyRunTable from "./NotifyRunTable";
import { clearNotifyEvents } from "./actions";

export const dynamic = "force-dynamic";

// Settings → Logs & audit → Notify tick (issue #2209). The operator record of what
// the notification tick DECIDED — including everything it decided not to do, which
// is the half that previously existed nowhere.
//
// WHY THIS IS NOT THE ERRORS PAGE. `readErrorEvents()` reads the whole file into
// memory and slices the tail — correct for 73 rare events, wrong for a 5 MB tick log
// where every render would parse ~15k lines to show 25 rows. The pattern copied here
// is the AUDIT page's: declared filters through searchParams, a page-size constant,
// clampPage/pageCount, and AppRoute-typed page hrefs. The read itself is bounded to
// the newest window (lib/notify-log.ts), and the page says so when it did not reach
// the start of the file rather than implying completeness.
//
// WHY THE ROW IS A RUN. Nobody asks "show me line 4,912"; the question is "what did
// the 07:00 tick decide for this profile, and why didn't it send X?" — so the unit is
// (run, profile), one row per profile per run, expandable to its decisions, sends and
// declines together. That is the integration_sync_events / Data → Review shape, not
// the flat AI-log tail.
//
// NO SSE. The AI log streams because you watch it during a session you triggered. The
// tick fires on its own cadence and the question is retrospective, so an SSR snapshot
// with a manual refresh reads better — the same reasoning ErrorLogTable already wrote
// down for itself.

type SearchParams = {
  profile?: string;
  level?: string;
  declines?: string;
  page?: string;
};

function intOrNull(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function levelOrNull(v: string | undefined): NotifyLevel | null {
  return v === "info" || v === "warn" || v === "error" ? v : null;
}

// Build the querystring for a target page, preserving the active filters — the
// pager must not silently widen what the reader is looking at.
function pageHref(sp: SearchParams, page: number): AppRoute {
  const q = new URLSearchParams();
  if (sp.profile) q.set("profile", sp.profile);
  if (sp.level) q.set("level", sp.level);
  if (sp.declines) q.set("declines", sp.declines);
  q.set("page", String(page));
  return `/settings/notify-log?${q.toString()}`;
}

export default async function NotifyLogPage(props: {
  searchParams: Promise<SearchParams>;
}) {
  // Tick lines carry profile names, item names and finding text across every
  // profile, so this is admin-only — a member is redirected out by requireAdmin(),
  // the same boundary as the Errors and AI-log viewers.
  const { login, profile } = await requireAdmin();

  const searchParams = await props.searchParams;
  const filters: NotifyLogFilters = {
    profileId: intOrNull(searchParams.profile),
    level: levelOrNull(searchParams.level),
    declinesOnly: searchParams.declines === "1",
  };

  const { events, truncated } = readNotifyEvents();
  const allRuns = filterNotifyRuns(groupNotifyRuns(events), filters);
  const page = clampPage(Number(searchParams.page) || 1);
  const pages = pageCount(allRuns.length, NOTIFY_RUN_PAGE_SIZE);
  const offset = pageOffset(page, NOTIFY_RUN_PAGE_SIZE);
  const runs = allRuns.slice(offset, offset + NOTIFY_RUN_PAGE_SIZE);

  // Map profile ids → display names so a run row names its subject. Same read both
  // sibling viewers do.
  const profileNames = Object.fromEntries(
    (
      db.prepare("SELECT id, name FROM profiles ORDER BY id").all() as {
        id: number;
        name: string;
      }[]
    ).map((p) => [p.id, p.name])
  );
  const profileOptions = Object.entries(profileNames).map(([id, name]) => ({
    id: Number(id),
    name,
  }));

  const filtered =
    filters.profileId != null || filters.level != null || filters.declinesOnly;

  return (
    <SettingsGroupLayout group="logs" login={login} profile={profile}>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        What the notification tick decided, one row per profile per run — sends
        and declines together. A run that decided nothing still appears; that is
        the point of the page.
      </p>

      {/* Filters (plain GET form, so it works without JS and is bookmarkable). */}
      <form
        method="GET"
        className="mb-4 flex flex-wrap items-end gap-2"
        data-testid="notify-log-filters"
      >
        <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
          Profile
          <select
            name="profile"
            defaultValue={searchParams.profile ?? ""}
            className="input"
          >
            <option value="">All</option>
            {profileOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
          Level
          <select
            name="level"
            defaultValue={searchParams.level ?? ""}
            className="input"
          >
            <option value="">All</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-xs text-slate-500 dark:text-slate-400">
          <input
            type="checkbox"
            name="declines"
            value="1"
            defaultChecked={filters.declinesOnly}
            data-testid="notify-log-declines-only"
          />
          Declines only
        </label>
        <button type="submit" className="btn">
          Filter
        </button>
        {filtered && (
          <Link href="/settings/notify-log" className="btn-ghost">
            Clear filters
          </Link>
        )}
      </form>

      <NotifyRunTable
        runs={runs}
        profileNames={profileNames}
        totalRuns={allRuns.length}
        filtered={filtered}
        truncated={truncated}
        clearAction={clearNotifyEvents}
      />

      {/* Pager over RUNS: the row is a run, so the pager counts rows. */}
      <div className="mt-3 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span data-testid="notify-log-total">{allRuns.length} runs</span>
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
