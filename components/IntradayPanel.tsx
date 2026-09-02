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
import type { DisplayFormatPrefs } from "@/lib/format-date";
import { intradayFreshness, type IntradayModel } from "@/lib/intraday";
import { INTRADAY_PANEL_ANCHOR } from "@/lib/hrefs";

export default function IntradayPanel({
  model,
  formatPrefs,
  profileId,
}: {
  model: IntradayModel;
  formatPrefs: DisplayFormatPrefs;
  /** The profile whose day this is — the Timeline can render a VIEWED subject's
   *  day, not only the acting profile's, and #1515's per-minute window has to ask
   *  for the right one. Re-validated against the session server-side. */
  profileId: number;
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
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          The day at a glance
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Midnight to midnight · drag to zoom · tap a mark to jump to its entry
        </p>
      </div>
      {/* The lag sentence (#4767 item 5), on today only. See `intradayFreshness`:
          the axis runs to midnight whatever the watch has sent, so the distance
          between the last sample and now is stated rather than drawn. */}
      {freshness && (
        <p
          className="mb-1 text-xs text-slate-500 dark:text-slate-400"
          data-testid="intraday-freshness"
        >
          {freshness}
        </p>
      )}
      <IntradayChart
        model={model}
        formatPrefs={formatPrefs}
        profileId={profileId}
        variant="compact"
        className="sm:hidden"
      />
      <IntradayChart
        model={model}
        formatPrefs={formatPrefs}
        profileId={profileId}
        variant="wide"
        className="hidden sm:block"
      />
    </div>
  );
}
