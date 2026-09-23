"use client";

// The lag sentence (#4767 item 5), counting up between syncs (#5146). Home's glance
// card and the day view's panel both mount this, and the chart's now-line reads the
// same `useIntradayNowMinute`, so the sentence and the line share one clock.
import { useLiveProfileClocks } from "@/components/DayContext";
import { useTimezone } from "@/components/TimezoneProvider";
import { useClock } from "@/components/useRelativeLabel";
import { zonedDateParts } from "@/lib/date";
import {
  intradayFreshness,
  localStampMinute,
  type IntradayModel,
} from "@/lib/intraday";

// Today's "now" on the day axis, in the profile's own zone. The model's server stamp
// paints first; a past day's null stays null, so only today moves.
export function useIntradayNowMinute(
  model: Pick<IntradayModel, "date" | "nowMinute">,
  profileId: number
): number | null {
  const clock = useClock();
  const appZone = useTimezone();
  const zone = useLiveProfileClocks().get(profileId)?.timeZone ?? appZone;
  if (model.nowMinute == null || clock == null) return model.nowMinute;
  const { date, hhmm } = zonedDateParts(zone, new Date(clock));
  return localStampMinute(model.date, `${date}T${hhmm}`);
}

export default function IntradayFreshness({
  model,
  profileId,
  className,
}: {
  model: IntradayModel;
  profileId: number;
  className: string;
}) {
  const freshness = intradayFreshness(
    model,
    useIntradayNowMinute(model, profileId)
  );
  if (!freshness) return null;
  return (
    <p className={className} data-testid="intraday-freshness">
      {freshness}
    </p>
  );
}
