import Link from "next/link";
import { IconX } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { buildDigestSeries } from "@/lib/trends-series";
import { summarizeTrends, type TrendItem } from "@/lib/trends-digest";
import { getFindingSuppressions } from "@/lib/queries";
import { activeByKey, digestDedupeKey } from "@/lib/findings";
import type { DateRange } from "@/lib/timeline-format";
import { dismissDigest } from "./actions";
import DigestOverflow from "./DigestOverflow";
import { PRACTICE_DIGEST_PREFIX } from "@/lib/trends-practices";
import { practiceTrendWindow } from "@/lib/trends-practices";
import { cadenceWindows } from "@/lib/queries/cadence-ledger";
import { getTrendsDigestGather } from "@/lib/queries/trends-digest";
import {
  buildLoggingCadenceDigestSeries,
  buildNutritionDigestSeries,
  buildPracticeDigestSeriesFromInputs,
  digestGatherBounds,
  supplementalDigestInputs,
} from "@/lib/trends-digest-series";
import { clinicalResultDetailHref, type AppRoute } from "@/lib/hrefs";
import TrendDigestChip from "@/components/TrendDigestChip";

// How many ranked movers render inline before the "show all N" disclosure (#1455).
const LEAD_CHIPS = 3;

// "What's trending" digest for the Trends Overview. Feeds
// every candidate series (metrics + biomarkers, windowed to the shared range) to
// the pure summarizeTrends, which admits only crossings, dispersion-significant
// shifts, and in-window behavior changes, then ranks them. Renders the top few as
// compact chips. Nothing renders when the window contains no news.
//
// #1455 B: the digest shows the TOP THREE inline and puts the rest behind a
// "Show all N" disclosure. The list is already ranked, so the leading three are
// the ones worth the phone screen; the full set stays one tap away, and the
// charts below move up by the ~4 chip-rows this used to spend.
//
// DATA-FIRST OVERVIEW: this is a compact inline status row, not a card. The shared
// range controls directly above already say which period is active, so a heading
// band repeating "over this window" only delayed the charts.
export default async function TrendingDigest({ range }: { range: DateRange }) {
  const { login, profile } = await requireSession();
  const todayStr = today(profile.id);
  // Metrics + biomarkers, plus wellness-practice CADENCE (#1632): a practice whose
  // days-per-week really changed is a candidate like any other. Its series carries no
  // reference range on purpose, so the chip stays neutral — a coaching-tier signal
  // does not get a crossing colour (see buildPracticeDigestSeries).
  const standardSeries = buildDigestSeries(profile.id, login.id, range);
  const practiceWindow = practiceTrendWindow(range, todayStr);
  const weeks = cadenceWindows(profile.id, {
    weeks: practiceWindow.weeks,
    includeCurrent: false,
    asOf: practiceWindow.asOf,
  });
  const bounds = digestGatherBounds(range, weeks, todayStr);
  const digestRows = getTrendsDigestGather(profile.id, bounds);
  // ONE profile-scoped statement replaces the former practice-target/history
  // gather and supplies all supplemental stored facts (#3397). The builders below
  // are pure, and composing them does not fan the digest out across ledgers.
  const gathered = supplementalDigestInputs(digestRows, weeks, range);
  const weightPoints =
    standardSeries.find((candidate) => candidate.key === "metric:weight")
      ?.points ?? [];
  const series = [
    ...standardSeries,
    ...buildPracticeDigestSeriesFromInputs(gathered.practiceTargets),
    ...buildNutritionDigestSeries(gathered),
    ...buildLoggingCadenceDigestSeries({
      windows: weeks,
      foodDates: gathered.foodDates,
      doseDates: gathered.doseDates,
      weighingDates: weightPoints.map((point) => point.date),
    }),
  ];
  // Drop chips the user has dismissed (findings bus, #39) — a dismissal keyed by
  // series + direction sticks while that same-direction trend persists.
  const items = activeByKey(
    summarizeTrends(series, { limit: 6 }),
    (it) => digestDedupeKey(it),
    getFindingSuppressions(profile.id),
    todayStr
  );
  if (items.length === 0) return null;

  const hrefFor = (item: TrendItem): AppRoute | null => {
    if (item.key.startsWith("result:"))
      return clinicalResultDetailHref(item.key.slice("result:".length));
    // A practice chip taps through to the page that owns the habit (#1620).
    if (item.key.startsWith(PRACTICE_DIGEST_PREFIX)) return "/wellness";
    return null;
  };

  const renderChip = (item: TrendItem) => {
    const href = hrefFor(item);
    const inner = <TrendDigestChip item={item} />;
    return (
      <span key={item.key} className="inline-flex items-center gap-1">
        {href ? (
          <Link href={href} className="hover:opacity-80">
            {inner}
          </Link>
        ) : (
          inner
        )}
        {/* Dismiss this chip (findings bus, #39). */}
        <form
          action={async (fd) => {
            "use server";
            await dismissDigest(fd);
          }}
        >
          <input
            type="hidden"
            name="dedupe_key"
            value={digestDedupeKey(item)}
          />
          <button
            type="submit"
            data-testid="digest-dismiss"
            aria-label={`Dismiss ${item.label} trend`}
            title="Dismiss"
            className="flex h-5 w-5 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-ink-750 dark:hover:text-slate-300"
          >
            <IconX className="h-3.5 w-3.5" stroke={2} />
          </button>
        </form>
      </span>
    );
  };

  // Lead with the top-ranked few; the rest ride the disclosure (#1455 B).
  const lead = items.slice(0, LEAD_CHIPS);
  const overflow = items.slice(LEAD_CHIPS);

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5"
      data-testid="trending-digest"
    >
      <h2 className="section-label shrink-0">Trending</h2>
      <div className="flex flex-wrap items-center gap-1.5">
        {lead.map(renderChip)}
        {overflow.length > 0 && (
          <DigestOverflow total={items.length}>
            {overflow.map(renderChip)}
          </DigestOverflow>
        )}
      </div>
    </div>
  );
}
