import Link from "next/link";
import { notFound } from "next/navigation";
import {
  IconArrowLeft,
  IconBuildingHospital,
  IconCalendarClock,
  IconFileText,
  IconTimeline,
} from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import {
  getEncounter,
  linkedRowsForEncounter,
  suggestionsForEncounter,
  episodesForEncounter,
  episodeSuggestionForEncounter,
  visitContextForEncounter,
  appointmentForEncounter,
} from "@/lib/queries";
import {
  assembleIllnessEpisode,
  episodeForProfileDate,
  episodeForProfileId,
} from "@/lib/illness-episode";
import { episodeCollapsedStatus } from "@/lib/illness-episode-format";
import { episodeHref, timelineDayHref } from "@/lib/hrefs";
import FromThisVisit from "@/components/visit-links/FromThisVisit";
import VisitEpisodes, {
  type VisitEpisodeTrailItem,
} from "@/components/visit-links/VisitEpisodes";
import { formatRecordDate, sourceLabel } from "@/lib/record-format";
import { classLabel, encounterTypeDisplay } from "@/lib/encounter-kind";
import type { VisitContext } from "@/lib/visit-context";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import NotesText from "@/components/NotesText";
import ProviderName from "@/components/ProviderName";
import OpenInMaps from "@/components/OpenInMaps";
import type { Encounter } from "@/lib/types";

export const dynamic = "force-dynamic";

// Visit detail: the full record for a single encounter — dates, type/class, chief
// complaint, diagnoses, attending clinician + facility, the free-text visit notes,
// and the enriched context (#1350): the illness-episode care trail + the encounter-
// side "link an episode" affordance, the provenance chain (source document ·
// scheduling origin · timeline day), and same-provider / same-kind visit context.
// Reached from the Visits list and from a Timeline visit entry (both deeplink to
// /encounters/[id]). Profile-scoped: the query filters BOTH id AND profile_id, so
// guessing another profile's id 404s.
//
// All CCD-derived text (reason / diagnoses / notes) renders as plain React children
// — escaped by default, never dangerouslySetInnerHTML — so nothing in an imported
// record can inject markup.

function dateLabel(e: Encounter, fmt: DisplayFormatPrefs): string {
  const start = formatRecordDate(e.date, "", fmt);
  if (e.end_date && e.end_date !== e.date)
    return `${start} – ${formatRecordDate(e.end_date, "", fmt)}`;
  return start;
}

function diagnosisList(diagnoses: string | null): string[] {
  if (!diagnoses) return [];
  return diagnoses
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th" … (visit-context ordinals).
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// The visit-context clauses (#1350) as plain strings — "3rd visit with Dr. Patel ·
// last one Mar 2026" and "2nd visit of this type this year". Empty when the visit has
// no continuity to show (a first visit stays silent — the #489 absent-pillar rule).
function visitContextClauses(
  ctx: VisitContext | null,
  fmt: DisplayFormatPrefs
): string[] {
  if (!ctx) return [];
  const out: string[] = [];
  if (ctx.provider) {
    const last = ctx.provider.priorDate
      ? ` · last one ${formatRecordDate(ctx.provider.priorDate, "", fmt)}`
      : "";
    out.push(
      `${ordinal(ctx.provider.ordinal)} visit with ${ctx.provider.name}${last}`
    );
  }
  if (ctx.kindYear) {
    out.push(`${ordinal(ctx.kindYear.ordinal)} visit of this type this year`);
  }
  return out;
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr]">
      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd className="min-w-0 text-sm text-slate-800 dark:text-slate-100">
        {children}
      </dd>
    </div>
  );
}

export default async function EncounterDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { login, profile } = await requireSession();
  const fmt = getDisplayFormatPrefs(login.id);
  const id = Number(params.id);
  const encounter = id ? getEncounter(profile.id, id) : null;
  if (!encounter) notFound();

  const diagnoses = diagnosisList(encounter.diagnoses);

  // The full episode care trail (#1198/#1350): EVERY linked episode, each with the
  // SHARED collapsed status line (#221) so the visit reads within its illness. Plus
  // the encounter-side "link an episode" suggestion (the inverted #1196 engine) — the
  // affordance the page previously lacked, which also makes a fully-unlinked in-range
  // visit discoverable.
  const trail: VisitEpisodeTrailItem[] = episodesForEncounter(
    profile.id,
    encounter.id
  ).map((ep) => {
    const row = episodeForProfileId(profile.id, ep.id);
    const status = row
      ? episodeCollapsedStatus(assembleIllnessEpisode(profile.id, row))
      : null;
    return {
      id: ep.id,
      situation: ep.situation,
      statusLabel: status?.dayLabel ?? ep.situation,
      worsening: status?.worsening ?? false,
    };
  });
  const episodeSuggestion = episodeSuggestionForEncounter(
    profile.id,
    encounter.id
  );
  // Date-derived episode chip (#856): shown ONLY when this visit has no explicit
  // episode link — a soft "this fell during …" hint that the trail supersedes.
  const dateEpisode =
    trail.length === 0
      ? episodeForProfileDate(profile.id, encounter.date)
      : null;

  // Provenance chain (#1350): scheduling origin (the appointment this visit was booked
  // as) + the source document link (below) + the timeline day.
  const appointment = appointmentForEncounter(profile.id, encounter.id);
  const scheduledDate = appointment?.scheduled_at
    ? appointment.scheduled_at.slice(0, 10)
    : null;

  // Same-provider / same-kind-this-year context (#1350).
  const context = visitContextClauses(
    visitContextForEncounter(profile.id, encounter.id),
    fmt
  );

  // From-this-visit rows already linked + the read-time "From this visit?" suggestions
  // (#1050). The linked rows/suggestions target the ACTIVE profile's encounter.
  const linkedRows = linkedRowsForEncounter(profile.id, encounter.id);
  const visitSuggestions = suggestionsForEncounter(profile.id, encounter.id);

  return (
    <PageContainer width="reading" data-testid="encounter-detail">
      <Link
        href="/records/history/visits"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
      >
        <IconArrowLeft className="h-4 w-4" stroke={1.75} />
        Back to visits
      </Link>

      <PageHeader
        title={encounterTypeDisplay(encounter.type, encounter.class_code)}
        subtitle={dateLabel(encounter, fmt)}
      />

      {/* Hero chips (#1340 layout): class + provider inline, then the visit-context
          continuity line. Each collapses when absent (the absent-pillar rule). */}
      {encounter.class_code || encounter.provider_name ? (
        <div
          className="mb-2 flex flex-wrap items-center gap-2 text-sm"
          data-testid="encounter-hero-chips"
        >
          {encounter.class_code ? (
            <span className="badge bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
              {classLabel(encounter.class_code)}
            </span>
          ) : null}
          {encounter.provider_name ? (
            <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
              <IconBuildingHospital
                className="h-4 w-4 shrink-0"
                stroke={1.75}
              />
              {encounter.provider_name}
            </span>
          ) : null}
        </div>
      ) : null}

      {context.length > 0 ? (
        <p
          className="mb-4 text-xs text-slate-500 dark:text-slate-400"
          data-testid="encounter-visit-context"
        >
          {context.join(" · ")}
        </p>
      ) : null}

      {dateEpisode && dateEpisode.id != null ? (
        <Link
          href={episodeHref(dateEpisode.id)}
          className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-300"
          data-testid="encounter-episode-chip"
        >
          During {dateEpisode.situation} episode
        </Link>
      ) : null}

      <div className="rounded-xl border border-black/5 bg-white/60 p-4 shadow-sm sm:p-6 dark:border-white/10 dark:bg-black/10">
        <dl className="divide-y divide-black/5 dark:divide-white/10">
          {encounter.reason ? (
            <DetailRow label="Chief complaint">
              <span data-testid="encounter-reason">{encounter.reason}</span>
            </DetailRow>
          ) : null}

          {diagnoses.length > 0 ? (
            <DetailRow label="Diagnoses">
              <div
                className="flex flex-wrap gap-1.5"
                data-testid="encounter-diagnoses"
              >
                {diagnoses.map((d, i) => (
                  <span
                    key={i}
                    className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                  >
                    {d}
                  </span>
                ))}
              </div>
            </DetailRow>
          ) : null}

          {encounter.provider_name ? (
            <DetailRow label="Provider">
              <ProviderName
                name={encounter.provider_name}
                providerId={encounter.provider_id}
                className=""
              />
            </DetailRow>
          ) : null}

          {encounter.location_name ? (
            <DetailRow label="Facility">
              {encounter.location_provider_id ? (
                <Link
                  href={`/providers/${encounter.location_provider_id}`}
                  className="inline-flex items-center gap-1.5 hover:text-brand-700 hover:underline dark:hover:text-brand-300"
                >
                  <IconBuildingHospital
                    className="h-4 w-4 shrink-0"
                    stroke={1.75}
                  />
                  {encounter.location_name}
                </Link>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <IconBuildingHospital
                    className="h-4 w-4 shrink-0"
                    stroke={1.75}
                  />
                  {encounter.location_name}
                </span>
              )}
              {encounter.location_address ? (
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {encounter.location_address}
                  {" · "}
                  <OpenInMaps
                    address={encounter.location_address}
                    label="Directions"
                    showIcon={false}
                    className="text-brand-700 hover:underline dark:text-brand-300"
                  />
                </div>
              ) : null}
            </DetailRow>
          ) : null}

          {encounter.notes ? (
            <DetailRow label="Notes">
              <NotesText
                as="p"
                notes={encounter.notes}
                className="leading-relaxed"
                data-testid="encounter-notes"
              />
            </DetailRow>
          ) : null}

          {scheduledDate ? (
            <DetailRow label="Scheduling">
              <span
                className="inline-flex items-center gap-1.5"
                data-testid="encounter-scheduling"
              >
                <IconCalendarClock className="h-4 w-4 shrink-0" stroke={1.75} />
                Scheduled {formatRecordDate(scheduledDate, "", fmt)} → attended{" "}
                {formatRecordDate(encounter.date, "", fmt)}
              </span>
            </DetailRow>
          ) : null}

          <DetailRow label="Source">
            <div className="flex flex-col items-start gap-1.5">
              <span
                className="text-slate-500 dark:text-slate-400"
                data-testid="encounter-source"
              >
                {sourceLabel(encounter.source)}
              </span>
              {encounter.document_id ? (
                <Link
                  href={`/import/${encounter.document_id}`}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 transition hover:underline dark:text-brand-300"
                >
                  <IconFileText className="h-3.5 w-3.5" stroke={1.75} />
                  View source document
                </Link>
              ) : null}
              <Link
                href={timelineDayHref(encounter.date)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 transition hover:underline dark:text-brand-300"
                data-testid="encounter-timeline-link"
              >
                <IconTimeline className="h-3.5 w-3.5" stroke={1.75} />
                View this day in Timeline
              </Link>
            </div>
          </DetailRow>
        </dl>
      </div>

      <VisitEpisodes
        profileId={profile.id}
        encounterId={encounter.id}
        trail={trail}
        suggestion={episodeSuggestion}
      />

      <FromThisVisit
        profileId={profile.id}
        encounterId={encounter.id}
        linkedRows={linkedRows}
        suggestions={visitSuggestions}
      />

      <p className="mt-4 px-1 text-xs text-slate-500 dark:text-slate-400">
        Imported visits come from uploaded health records (CCD Encounters
        section).
      </p>
    </PageContainer>
  );
}
