import WidgetHeader from "@/components/dashboard/WidgetHeader";
import QuickLogPrnControl from "@/components/dashboard/QuickLogPrnControl";
import type { PrnMedForQuickLog } from "@/lib/queries";
import {
  administrationDayLabel,
  formatGivenAtClock,
} from "@/lib/administration-format";

// Dashboard quick-log widget for PRN (as-needed) medications (#797). The one-tap
// retro-entry home: each active PRN med gets a "Log" button (now) plus retro offsets
// (30m/1h ago, or a specific time). The per-day count + last time is computed here
// (server, with the profile tz) and passed down so the client control stays a thin
// formatter over one server computation. Rendered only when the profile has active
// PRN meds — the empty state is the data-aware onboarding CTA (page.tsx).
export default function QuickLogPrnWidget({
  meds,
  tz,
}: {
  meds: PrnMedForQuickLog[];
  tz: string;
}) {
  return (
    <div className="card" data-testid="quick-log-prn">
      <WidgetHeader
        title="Log a PRN dose"
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
          />
        ))}
      </div>
    </div>
  );
}
