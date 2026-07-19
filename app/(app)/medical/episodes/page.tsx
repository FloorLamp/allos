import Link from "next/link";
import { requireSession, getAccessibleProfiles } from "@/lib/auth";
import { getUnitPrefs, getDisplayFormatPrefs } from "@/lib/settings";
import { fmtTemp } from "@/lib/units";
import { formatRecordDate } from "@/lib/record-format";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import { summarizeEpisodesForProfile } from "@/lib/illness-episode-summary";
import { episodeHref, HOUSEHOLD_HISTORY_HREF } from "@/lib/hrefs";
import PageContainer from "@/components/PageContainer";
import { PageHeader, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

// The episodes index (issue #856 item 9): every past illness for the active profile —
// date range, duration, peak temp, symptom set, and outcome — answering "when did I last
// have a fever and how did it go." Consumes summarizeEpisodesForProfile (the one #801
// assembly per row). Retroactive by construction: a boundary-edited/retro episode row
// simply appears here.

// Pref-aware (#964/#1020): formatRecordDate replaces the old implicit-locale
// toLocaleDateString, which leaked the server's locale.
const fmtDate = (d: string | null, prefs: DisplayFormatPrefs): string =>
  formatRecordDate(d, "—", prefs);

export default async function EpisodesIndexPage() {
  const { login, profile } = await requireSession();
  const temperatureUnit = getUnitPrefs(login.id).temperatureUnit;
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const episodes = summarizeEpisodesForProfile(profile.id);
  // Widen-to-household link (issue #1009 Ask 4) — shown only for a multi-profile login,
  // the same predicate that gates the Household strip/nav.
  const showHousehold = (await getAccessibleProfiles()).length > 1;

  return (
    <PageContainer width="reading">
      <PageHeader
        title="Illness episodes"
        subtitle="Every logged illness — most recent first."
        action={
          showHousehold ? (
            <Link
              href={HOUSEHOLD_HISTORY_HREF}
              className="text-sm font-medium text-sky-700 hover:underline dark:text-sky-300"
              data-testid="household-view-link"
            >
              Household view →
            </Link>
          ) : undefined
        }
      />
      {episodes.length === 0 ? (
        <EmptyState message="No illness episodes yet. When you flag an illness situation and log symptoms, it appears here." />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="episode-index">
          {episodes.map((e) => {
            const range = `${fmtDate(e.firstDay, formatPrefs)} – ${
              e.ongoing ? "ongoing" : fmtDate(e.lastActiveDay, formatPrefs)
            }`;
            const outcome =
              e.outcome ??
              (e.promotedConditionName
                ? `Condition: ${e.promotedConditionName}`
                : e.ongoing
                  ? "Ongoing"
                  : "Self-resolved");
            return (
              <li key={e.id}>
                <Link
                  href={episodeHref(e.id)}
                  className="card block transition hover:shadow-md"
                  data-testid="episode-index-row"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="font-semibold text-slate-800 dark:text-slate-100">
                      {e.situation}
                    </span>
                    <span className="text-sm text-slate-500 dark:text-slate-400">
                      {range}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                    {e.dayCount != null && <span>{e.dayCount}-day</span>}
                    {e.maxTempF != null && (
                      <span>peak {fmtTemp(e.maxTempF, temperatureUnit)}</span>
                    )}
                    {e.distinctSymptomCount > 0 && (
                      <span>
                        {e.symptomLabels.slice(0, 4).join(", ")}
                        {e.symptomLabels.length > 4 ? "…" : ""}
                      </span>
                    )}
                    <span className="ml-auto font-medium text-slate-600 dark:text-slate-300">
                      {outcome}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PageContainer>
  );
}
