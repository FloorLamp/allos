import WidgetHeader from "@/components/dashboard/WidgetHeader";
import QuickLogPrnControl from "@/components/dashboard/QuickLogPrnControl";
import type { PrnMedForQuickLog } from "@/lib/queries";
import {
  administrationDayLabel,
  formatGivenAtClock,
} from "@/lib/administration-format";
import { redoseWindowStatus } from "@/lib/prn-redose";
import { redoseCardLabel } from "@/lib/redose-format";
import { parseUtcSql } from "@/lib/date";

// Dashboard quick-log widget for PRN (as-needed) medications (#797). The one-tap
// retro-entry home: each active PRN med gets a "Log" button (now) plus retro offsets
// (30m/1h ago, or a specific time). The per-day count + last time is computed here
// (server, with the profile tz) and passed down so the client control stays a thin
// formatter over one server computation. Rendered only when the profile has active
// PRN meds — the empty state is the data-aware onboarding CTA (page.tsx).
export default function QuickLogPrnWidget({
  meds,
  tz,
  profileId,
}: {
  meds: PrnMedForQuickLog[];
  tz: string;
  // The cross-profile write target (issue #879) — when this widget hosts a household
  // member's episode page, each PRN log posts it so the action gates on THAT profile
  // (requireProfileWriteAccess). Absent on the dashboard/active-profile mounts.
  profileId?: number;
}) {
  const now = new Date();
  // The redose status line (#798), when the med has confirmed interval/max and
  // something's been logged. Same redoseCardLabel the medications card uses (one
  // computation, so the widget and card never disagree). Marker-agnostic — the card
  // always shows current window state regardless of the one-shot notification marker.
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
    <div className="card" data-testid="quick-log-prn">
      <WidgetHeader
        title="Log a dose"
        href="/medications"
        linkLabel="Medications"
      />
      <div className="flex flex-col gap-2">
        {meds.map((m) => (
          <QuickLogPrnControl
            key={m.id}
            itemId={m.id}
            name={m.name}
            dayLabel={administrationDayLabel(
              m.count,
              formatGivenAtClock(tz, m.lastGivenAt)
            )}
            redoseLine={redoseLineFor(m)}
            linkToDetail
            profileId={profileId}
          />
        ))}
      </div>
    </div>
  );
}
