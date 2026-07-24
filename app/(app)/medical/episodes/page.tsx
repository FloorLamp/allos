import Link from "next/link";
import { requireScope } from "@/lib/scope";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getUnitPrefs, getDisplayFormatPrefs } from "@/lib/settings";
import { gatherCareTrail } from "@/lib/care-trail-gather";
import {
  buildCareTrail,
  careTrailRows,
  perMemberEpisodeStats,
  normalizeCareTrailKind,
  type CareTrailKind,
} from "@/lib/care-trail";
import { buildSwimlane } from "@/lib/care-trail-swimlane";
import { episodesKindHref } from "@/lib/hrefs";
import type { AvatarProfile } from "@/components/Avatar";
import PageContainer from "@/components/PageContainer";
import { PageHeader, EmptyState } from "@/components/ui";
import CareTrailBand from "@/components/illness/CareTrailBand";
import CareTrailList from "@/components/illness/CareTrailList";
import CareTrailStatsStrip from "@/components/illness/CareTrailStatsStrip";

export const dynamic = "force-dynamic";

// The Illness episodes index (#856), which BECAME the view-set-driven household care-trail
// surface (#1373 Part 2, superseding #879's surface split — its single-ENGINE rule
// survives). The #1096 profile banner (rendered app-wide in the layout) drives WHOSE data
// shows via scope.viewIds; a URL-driven two-state `?kind=` toggle drives WHAT shows:
//   • illness (default): episodes + their LINKED visits (#1198) nested as indented child
//     rows in episode-relative time, and prescribed medication courses nested by the SAME
//     classifyEpisodeMed window classification the reconcile uses (one computation);
//   • illness+visits: adds the UNLINKED routine visits as standalone interleaved rows.
// There is deliberately no visits-only lens — the flat all-visits question belongs to
// records → Visits (the management surface). Single-view is the former index restyled: no
// banner, kind=illness default, one member's episodes.
export default async function EpisodesIndexPage(props: {
  searchParams: Promise<{ kind?: string | string[] }>;
}) {
  const { kind: rawKind } = await props.searchParams;
  const kind: CareTrailKind = normalizeCareTrailKind(
    Array.isArray(rawKind) ? rawKind[0] : rawKind
  );

  const scope = await requireScope();
  const { loginId, actingProfileId, viewIds } = scope;
  const multi = viewIds.length > 1;
  const temperatureUnit = getUnitPrefs(loginId).temperatureUnit;
  const formatPrefs = getDisplayFormatPrefs(loginId);

  // The care-trail gather + nest (auth-blind, profileIds-list-first). viewIds is the ONLY
  // legitimate cross-profile id source (validated ∩ accessible in requireScope).
  const gather = gatherCareTrail(viewIds);
  const build = buildCareTrail(gather.episodes, gather.visits, gather.courses);
  const rows = careTrailRows(build, kind);

  // Disambiguated subject identity (#534) for every in-view member.
  const subjectById = new Map<
    number,
    { name: string; profile: AvatarProfile }
  >();
  for (const id of viewIds) {
    const p = scope.profiles.find((sp) => sp.id === id);
    if (p) subjectById.set(id, { name: p.name, profile: p });
  }

  // The trailing-window swimlane axis (a single axis; per-member day math already resolved
  // in the bars). Window ends at the acting profile's today, spans ~12 months back.
  const windowEnd = today(actingProfileId);
  const windowStart = shiftDateStr(windowEnd, -365);
  const swimlane = buildSwimlane(build, viewIds, windowStart, windowEnd);
  const currentYear = Number(windowEnd.slice(0, 4));
  const stats = multi ? perMemberEpisodeStats(build.episodes, currentYear) : [];

  // Members in view with no episodes at all — a per-member "none yet" line in multi-view
  // (the absent-pillar: don't imply a member is missing).
  const membersWithEpisodes = new Set(build.episodes.map((e) => e.profileId));

  const subtitle = multi
    ? "Everyone's illness episodes and visits — most recent first."
    : "Every logged illness — most recent first.";

  return (
    <PageContainer width="reading">
      <PageHeader title="Illness episodes" subtitle={subtitle} />

      {/* The two-state content toggle (URL-driven; default illness). */}
      <div
        className="mb-4 flex flex-wrap gap-2"
        data-testid="care-trail-kind-toggle"
      >
        <KindTab kind="illness" active={kind === "illness"} label="Illness" />
        <KindTab
          kind="illness+visits"
          active={kind === "illness+visits"}
          label="Illness + visits"
        />
      </div>

      {swimlane.hasData && (
        <div className="mb-5">
          <CareTrailBand
            swimlane={swimlane}
            subjectById={subjectById}
            temperatureLabel="Past 12 months"
          />
        </div>
      )}

      {stats.length > 0 && (
        <div className="mb-5">
          <CareTrailStatsStrip stats={stats} subjectById={subjectById} />
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          message={
            kind === "illness"
              ? "No illness episodes yet. When you flag an illness situation and log symptoms, it appears here."
              : "No illness episodes or visits yet."
          }
        />
      ) : (
        <CareTrailList
          rows={rows}
          subjectById={subjectById}
          actingProfileId={actingProfileId}
          multi={multi}
          temperatureUnit={temperatureUnit}
          formatPrefs={formatPrefs}
        />
      )}

      {multi && (
        <div
          className="mt-6 flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400"
          data-testid="care-trail-empty-members"
        >
          {viewIds
            .filter((id) => !membersWithEpisodes.has(id))
            .map((id) => (
              <span key={id} data-profile-id={id}>
                No episodes: {subjectById.get(id)?.name ?? `Profile ${id}`}
              </span>
            ))}
        </div>
      )}
    </PageContainer>
  );
}

function KindTab({
  kind,
  active,
  label,
}: {
  kind: CareTrailKind;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={episodesKindHref(kind)}
      data-testid={`care-trail-kind-${kind === "illness" ? "illness" : "visits"}`}
      data-active={active}
      aria-pressed={active}
      className={`inline-flex items-center rounded-full border px-3 py-1 text-sm transition ${
        active
          ? "border-sky-500 bg-sky-50 font-medium text-sky-700 dark:border-sky-400 dark:bg-sky-950 dark:text-sky-300"
          : "border-black/10 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
      }`}
    >
      {label}
    </Link>
  );
}
