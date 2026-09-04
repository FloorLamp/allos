"use client";

import Link from "next/link";
import { useIntradayInteraction } from "@/components/IntradayInteraction";
import { historyHref, type HistoryHrefParams } from "@/lib/hrefs";
import { intradayWindowParams, windowFromView } from "@/lib/intraday-window";
import { formatClockMinutes } from "@/lib/format-date";
import type { TimeFormat } from "@/lib/format-date";
import type { HistoryKind } from "@/lib/history-format";

// THE ADD ROW READS THE WINDOW THE CHART IS ALREADY SHOWING (#4950, owner amendment).
//
// There is no chip to arm and no mode to be in: zoomed, the view IS the window; at full
// day a crosshair is a start alone. This is the only reason the row is a client
// component — the labels, the kinds and the hrefs are all still the server's, handed
// down whole.
//
// EACH CHIP CARRIES THE PARAMS THE PAGE'S OWN `chipHref` PRODUCED, not a URL this file
// re-derives. The kind-switching rules — a family chip dropping the kind inside it, a
// chip leaving doses dropping `class`, an item not surviving a kind change — live in one
// place on the server, and this adds two keys to what they decided. `historyHref` is
// still the one speller, so param order stays fixed and the URL stays cacheable.
//
// The window is MINTED ONLY WHEN A CHIP IS TAPPED, which is the amendment's rule: zoom
// stays ephemeral, and the URL learns the window from the link a person followed.
export interface HistoryAddChip {
  kind: HistoryKind;
  label: string;
  params: HistoryHrefParams;
}

export default function HistoryAddRow({
  chips,
  timeFormat,
}: {
  chips: readonly HistoryAddChip[];
  timeFormat: TimeFormat;
}) {
  const { view, cursor } = useIntradayInteraction();
  const window = windowFromView(view, cursor);
  const params = window ? intradayWindowParams(window) : null;
  const clock = (minute: number) => formatClockMinutes(timeFormat, minute);
  // "Add at 19:10–20:40" for a span, "Add at 19:10" for a start alone, "Add" for
  // neither — the row says what it would write into, and says nothing when it has
  // nothing to say.
  const label =
    window == null
      ? "Add"
      : window.to == null
        ? `Add at ${clock(window.from)}`
        : `Add at ${clock(window.from)}–${clock(window.to)}`;

  return (
    /* Geometry unchanged from the server version this replaced: it scrolls rather than
       wraps for the same reason the filter row does. */
    <div className="-mx-2 flex items-center gap-3 overflow-x-auto px-2 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
      {/* "Add", not "Add past" (#4918 ruling 5): on the day view the day bar states the
          day being written to, and on the feed the door is bounded by today anyway. */}
      <span
        className="shrink-0 text-slate-500 dark:text-slate-400"
        data-testid="history-add-label"
      >
        {label}
      </span>
      {chips.map((chip) => (
        <Link
          key={chip.kind}
          /* An EXISTING raw mount, moved verbatim rather than converted: #4978 owns
             `btn-ghost btn-sm` and its two neighbours on this page, and a lane that only
             needs the row to read a window should not be the one to change its paint. */
          className="btn-ghost btn-sm shrink-0"
          href={historyHref({ ...chip.params, ...(params ?? {}) })}
          data-testid={`history-add-${chip.kind}`}
        >
          {chip.label}
        </Link>
      ))}
    </div>
  );
}
