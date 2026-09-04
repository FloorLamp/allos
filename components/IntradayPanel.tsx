// The Timeline day view's intraday panel (issue #1068): the card, the header, and
// the day chart itself — twice.
//
// TWO VARIANTS, ONE CONTENT COMPONENT (#1512 F). A fixed viewBox scaled to
// `width: 100%` renders its type at `fontSize × (container ÷ viewBox)`, so one
// geometry cannot serve a 358 px phone and a wide monitor: the single 720-unit box
// painted ~3.5 px labels on a phone (#1518) and ~17 px ones on a desktop.
// `IntradayChart` is rendered twice with different GEOMETRY — the model, the
// layers, the labels and every decision are identical, so this is a variant prop
// over one content component, not a `hidden md:*` content fork. What duplicates in
// the payload is two path strings; the alternative (picking a variant on the
// client) would trade first paint for it, which is the one thing this surface
// cannot spend.
import IntradayChart from "@/components/IntradayChart";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import DaylightChip, { type DaylightUv } from "@/components/DaylightChip";
import CyclePhaseChip from "@/components/CyclePhaseChip";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import { intradayFreshness, type IntradayModel } from "@/lib/intraday";
import { INTRADAY_PANEL_ANCHOR } from "@/lib/hrefs";
import type { SleepWaitingState } from "@/lib/sleep-waiting";
import type { HomeLocation } from "@/lib/home-location";
import type { CyclePhase, CyclePeriod } from "@/lib/cycle";

export default function IntradayPanel({
  model,
  formatPrefs,
  profileId,
  home,
  timezone,
  daylightOutdoor,
  uv,
  cyclePhase,
  cyclePeriod,
  weather,
  waiting,
  waitingDetail,
  selectedWindow = null,
}: {
  model: IntradayModel;
  formatPrefs: DisplayFormatPrefs;
  /** The profile whose day this is — the Timeline can render a VIEWED subject's
   *  day, not only the acting profile's, and #1515's per-minute window has to ask
   *  for the right one. Re-validated against the session server-side. */
  profileId: number;
  /** A window stated in the URL (#4950), passed to both chart variants so the mark is
   *  the same one whichever is visible at this width. */
  selectedWindow?: { from: number; to: number | null } | null;
  /**
   * THE DAY'S CONTEXT (#4918 ruling 3) — DaylightChip's and CyclePhaseChip's own
   * inputs, plus the weather line, all formerly the standalone `history-day-context`
   * strip below the day bar. Each chip stays quiet by default (`DaylightChip` draws
   * nothing without a home location, `CyclePhaseChip` nothing off a cycle), so
   * passing them in unconditionally costs nothing on a day with none of it.
   */
  home: HomeLocation | null;
  timezone: string;
  daylightOutdoor: number;
  uv: DaylightUv | null;
  cyclePhase: CyclePhase | null;
  cyclePeriod: CyclePeriod | null;
  /** The #1726 notable-conditions summary, or null on a day nothing was notable. */
  weather: string | null;
  /**
   * TODAY'S SLEEP IS STILL ON ITS WAY (#4918 ruling 7). The state is #2097's, whole
   * — the same decision the dashboard row and the /sleep hero read, never a second
   * one derived here — and the panel's job is only to say it where the absence is
   * visible. The chart draws sessions that EXIST, so an unarrived night drew
   * nothing and said nothing, under a freshness line ("Synced 41 min ago") that
   * reads as "everything is in". The two sentences say different things: the watch
   * is talking, and the night is not in yet. Absent on a past day — the waiting
   * window is clock-relative and means nothing there.
   */
  waiting?: SleepWaitingState;
  /** #2097's own secondary line ("Usually in by ~07:04"), or null when there is
   *  nothing honest to add. The formatters are the login's, so the caller resolves
   *  it and this component never re-words it. */
  waitingDetail?: string | null;
}) {
  const freshness = intradayFreshness(model);
  return (
    // `scroll-mt-4` for the same reason every other anchored section on the app
    // carries it: landing on an id puts the element's top edge under the sticky
    // chrome, and a chart whose header is hidden reads as a chart with no title.
    <div
      id={INTRADAY_PANEL_ANCHOR}
      className="card mb-3 scroll-mt-4 overflow-hidden"
      data-testid="intraday-panel"
      data-intraday-date={model.date}
    >
      {/* THE TITLE ROW SAYS WHAT IS TRUE OF *THIS* DAY (#4918 ruling 4). A permanent
          instruction sentence — "Midnight to midnight · drag to zoom · tap a mark to
          jump to its entry" — held the widest line in the card's header on every
          visit forever, while the one line that changes (the lag sentence, #4767
          item 5) sat on a row of its own beneath it. The instruction is the same
          three facts every day, so it becomes the glyph's tooltip and the freshness
          line takes the slot it vacated. */}
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
          The day at a glance
          <InfoTooltipIcon
            label="Midnight to midnight · drag to zoom · tap a mark to jump to its entry"
            data-testid="intraday-help"
          />
        </h3>
        {/* The lag sentence (#4767 item 5), on today only. See `intradayFreshness`:
            the axis runs to midnight whatever the watch has sent, so the distance
            between the last sample and now is stated rather than drawn. */}
        {freshness && (
          <p
            className="text-xs text-slate-500 dark:text-slate-400"
            data-testid="intraday-freshness"
          >
            {freshness}
          </p>
        )}
      </div>
      {waiting && (
        <p
          className="mb-1 text-xs text-slate-500 dark:text-slate-400"
          data-testid="intraday-context"
        >
          <span
            data-testid="sleep-waiting-headline"
            data-kind={waiting.kind}
            className="text-slate-600 dark:text-slate-300"
          >
            {waiting.headline}
          </span>
          {waitingDetail ? ` · ${waitingDetail}` : null}
        </p>
      )}
      {/* THE REST OF THE DAY'S CONTEXT (#4918 ruling 3) — daylight, UV, cycle phase,
          weather. Formerly the standalone `history-day-context` strip; each chip is
          quiet by default, so this costs nothing on a day none of it applies. */}
      <DaylightChip
        home={home}
        date={model.date}
        timezone={timezone}
        outdoorMinutes={daylightOutdoor}
        uv={uv}
      />
      <CyclePhaseChip phase={cyclePhase} period={cyclePeriod} />
      {weather ? (
        <div
          className="mt-1 text-xs text-slate-500 dark:text-slate-400"
          data-testid="history-day-weather"
        >
          {weather}
        </div>
      ) : null}
      <IntradayChart
        model={model}
        formatPrefs={formatPrefs}
        profileId={profileId}
        variant="compact"
        className="sm:hidden"
        selectedWindow={selectedWindow}
      />
      <IntradayChart
        model={model}
        formatPrefs={formatPrefs}
        profileId={profileId}
        variant="wide"
        className="hidden sm:block"
        selectedWindow={selectedWindow}
      />
    </div>
  );
}
