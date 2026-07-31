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
import type { IntradayModel } from "@/lib/intraday";

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
  return (
    <div
      className="card mb-3 overflow-hidden"
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
