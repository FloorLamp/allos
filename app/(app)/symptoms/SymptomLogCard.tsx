import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { SYMPTOMS } from "@/lib/symptoms";
import {
  getSymptomSeveritiesOnDate,
  getCustomSymptomNames,
  getPediatricFormContext,
} from "@/lib/queries";
import { currentEpisodeForProfile } from "@/lib/illness-episode";
import { episodeHeadline } from "@/lib/illness-episode-format";
import { episodeHref } from "@/lib/hrefs";
import SymptomLogBar from "./SymptomLogBar";
import SymptomMedQuickAdd from "./SymptomMedQuickAdd";

// Dashboard symptom card (issue #799) — rendered ONLY while an illness-type situation is
// active (the page gates its `available`), so it appears exactly when it's useful. Gathers
// today + yesterday severities server-side and hands them to the one-tap bar (with the
// today/yesterday toggle for the #748 backfill lesson). Because the card is illness-gated,
// the bar's "mark as illness" bridge is off here — that direction lives on the Timeline.
export default function SymptomLogCard({ profileId }: { profileId: number }) {
  const date = today(profileId);
  const yesterday = shiftDateStr(date, -1);
  // While an episode is open, the card doubles as its summary header (#801): the
  // headline ("Illness · day 4 · fever trending down · …") and a link to the full
  // story, both over the SAME assembly the timeline/share surfaces use.
  const episode = currentEpisodeForProfile(profileId);
  const episodeLink =
    episode && episode.id != null ? episodeHref(episode.id) : "/timeline";
  return (
    <div className="card">
      <WidgetHeader
        title="Symptoms"
        href={episodeLink}
        linkLabel={episode ? "Episode" : "Timeline"}
      />
      {episode ? (
        <p
          className="mb-3 text-xs font-medium text-slate-600 dark:text-slate-300"
          data-testid="symptom-episode-header"
        >
          {episodeHeadline(episode)}
        </p>
      ) : (
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Tap a severity to log how you feel today.
        </p>
      )}
      <SymptomLogBar
        date={date}
        altDate={yesterday}
        initial={getSymptomSeveritiesOnDate(profileId, date)}
        initialAlt={getSymptomSeveritiesOnDate(profileId, yesterday)}
        symptoms={SYMPTOMS}
        customNames={getCustomSymptomNames(profileId)}
        suggestActivateIllness={false}
        showTemperature
      />
      {/* Door C (#843): reach for an OTC med right where you're logging symptoms. */}
      <SymptomMedQuickAdd pediatric={getPediatricFormContext(profileId)} />
    </div>
  );
}
