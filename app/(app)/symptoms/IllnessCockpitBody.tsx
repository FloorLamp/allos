import { today } from "@/lib/db";
import { shiftDateStr, parseUtcSql } from "@/lib/date";
import { getTimezone, getUnitPrefs } from "@/lib/settings";
import { SYMPTOMS } from "@/lib/symptoms";
import {
  getSymptomSeveritiesOnDate,
  getSymptomNotesOnDate,
  getSymptomLogOrder,
  getCustomSymptomNames,
  getPrnMedicationsForQuickLog,
  getPediatricFormContext,
  getEpisodeMedReconciliation,
  type PrnMedForQuickLog,
} from "@/lib/queries";
import { redoseWindowStatus } from "@/lib/prn-redose";
import { redoseCardLabel } from "@/lib/redose-format";
import {
  administrationDayLabel,
  formatGivenAtClock,
} from "@/lib/administration-format";
import type { AssembledEpisode } from "@/lib/illness-episode-format";
import { episodeHref } from "@/lib/hrefs";
import Link from "next/link";
import SymptomLogBar from "./SymptomLogBar";
import SymptomMedQuickAdd from "./SymptomMedQuickAdd";
import QuickLogPrnControl from "@/components/dashboard/QuickLogPrnControl";
import CockpitEndEpisode from "@/components/dashboard/CockpitEndEpisode";
import StaleEpisodeNudge from "@/components/illness/StaleEpisodeNudge";
import { staleEpisodeNudgeFor } from "@/lib/stale-episode-data";
import { schoolReturnStatusFor } from "@/lib/school-return-data";
import { formatSchoolReturnLine } from "@/lib/school-return";

// The full illness-cockpit BODY for one patient (issue #858) — the expanded content the
// hero shell (IllnessHero) reveals under the named header. It is the SAME machinery the
// dashboard Symptoms card gathered (the one-tap SymptomLogBar with symptoms + temp) plus
// the PRN dose log (the SAME redose computation the QuickLogPrn widget uses — one
// question, one computation) and the end-episode action. Rendered server-side (it needs
// profile-scoped reads) and passed into the client shell as a node, so ONE component
// serves the acting profile's cockpit and every household member's accordion cockpit.
//
// `crossProfile` is true for a household member (not the acting profile): the bar + PRN
// control + end button then carry the target `profileId` so their writes gate on THAT
// profile (requireProfileWriteAccess) without switching. On the acting profile's own
// cockpit it is false and every write takes the plain active-profile path.
export default function IllnessCockpitBody({
  profileId,
  loginId,
  episode,
  crossProfile,
}: {
  profileId: number;
  loginId: number;
  episode: AssembledEpisode;
  crossProfile: boolean;
}) {
  const date = today(profileId);
  const yesterday = shiftDateStr(date, -1);
  const temperatureUnit = getUnitPrefs(loginId).temperatureUnit;
  const tz = getTimezone(profileId);
  // The write target the bar/control/end button post — only for a household member's
  // cockpit; the acting profile's own cockpit omits it (active-profile write path).
  const target = crossProfile ? profileId : undefined;

  // Item 2: the school-return countdown (when a fever has been logged this episode) +
  // Item 1: the suggest-only stale nudge (this open episode gone quiet) — both format
  // over the ONE gathers (#221), shown on the cockpit alongside the episode page.
  const schoolReturn = schoolReturnStatusFor(profileId, episode);
  const staleNudge = staleEpisodeNudgeFor(profileId);
  const showStaleNudge =
    staleNudge != null && staleNudge.episodeId === episode.id
      ? staleNudge
      : null;

  // Episode-end medication reconciliation (issue #880): the episode-associated meds the
  // "Feeling better" / stale-end checklist offers to close, shared with the episode page
  // via the ONE gather.
  const medReconciliation =
    episode.id != null
      ? getEpisodeMedReconciliation(profileId, episode.id)
      : [];

  const prnMeds = getPrnMedicationsForQuickLog(profileId);
  const now = new Date();
  // The redose status line (#798) via the SHARED pure window math + formatter — the
  // exact computation QuickLogPrnWidget uses, so the hero and the med card never disagree.
  const redoseLineFor = (m: PrnMedForQuickLog): string | null => {
    if (
      m.minIntervalHours == null ||
      m.maxDailyCount == null ||
      !m.lastGivenAt
    ) {
      return null;
    }
    return redoseCardLabel(
      redoseWindowStatus({
        minIntervalHours: m.minIntervalHours,
        maxDailyCount: m.maxDailyCount,
        latestGivenAt: parseUtcSql(m.lastGivenAt),
        countToday: m.count,
        now,
      })
    );
  };

  return (
    <div
      className="mt-3 flex flex-col gap-4"
      data-testid="illness-cockpit-body"
    >
      <SymptomLogBar
        date={date}
        altDate={yesterday}
        initial={getSymptomSeveritiesOnDate(profileId, date)}
        initialAlt={getSymptomSeveritiesOnDate(profileId, yesterday)}
        initialNotes={getSymptomNotesOnDate(profileId, date)}
        initialAltNotes={getSymptomNotesOnDate(profileId, yesterday)}
        symptoms={SYMPTOMS}
        customNames={getCustomSymptomNames(profileId)}
        rankedKeys={getSymptomLogOrder(profileId)}
        suggestActivateIllness={false}
        showTemperature
        temperatureUnit={temperatureUnit}
        profileId={target}
      />

      {schoolReturn && (
        <p
          data-testid="school-return-line"
          className="rounded-lg border border-black/10 bg-white/60 p-2.5 text-xs text-slate-600 dark:border-white/10 dark:bg-ink-900/40 dark:text-slate-300"
        >
          {formatSchoolReturnLine(schoolReturn, temperatureUnit)}
        </p>
      )}

      {showStaleNudge && (
        <StaleEpisodeNudge
          episodeId={showStaleNudge.episodeId}
          profileId={target}
          lastActivityDate={showStaleNudge.lastActivityDate}
          quietDays={showStaleNudge.quietDays}
          medReconciliation={medReconciliation}
        />
      )}

      {prnMeds.length > 0 && (
        <div data-testid="cockpit-prn">
          <div className="mb-2 section-label">PRN doses</div>
          <div className="flex flex-col gap-2">
            {prnMeds.map((m) => (
              <QuickLogPrnControl
                key={m.id}
                itemId={m.id}
                name={m.name}
                dayLabel={administrationDayLabel(
                  m.count,
                  formatGivenAtClock(tz, m.lastGivenAt)
                )}
                redoseLine={redoseLineFor(m)}
                profileId={target}
              />
            ))}
          </div>
        </div>
      )}

      {/* Door C (#843): reach for an OTC med right where you're logging symptoms — kept
          on the acting profile's own cockpit (the med quick-add writes the active
          profile; it's omitted from a household member's cross-profile cockpit). */}
      {!crossProfile && (
        <SymptomMedQuickAdd pediatric={getPediatricFormContext(profileId)} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {episode.id != null && (
          <CockpitEndEpisode
            episodeId={episode.id}
            profileId={target}
            meds={medReconciliation}
          />
        )}
        {episode.id != null && (
          <Link
            href={episodeHref(episode.id)}
            className="badge border border-black/10 text-slate-600 hover:bg-slate-50 dark:border-white/15 dark:text-slate-300 dark:hover:bg-ink-850"
          >
            Full episode
          </Link>
        )}
      </div>
    </div>
  );
}
