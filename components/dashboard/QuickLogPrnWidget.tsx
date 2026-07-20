import WidgetHeader from "@/components/dashboard/WidgetHeader";
import QuickLogPrnControl from "@/components/dashboard/QuickLogPrnControl";
import type { PrnMedForQuickLog } from "@/lib/queries";
import type { ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";
import {
  administrationDayLabel,
  administrationLastDoseLabel,
  formatGivenAtClockWithRelativeAge,
} from "@/lib/administration-format";
import { redoseWindowStatus } from "@/lib/prn-redose";
import { now as clockNow } from "@/lib/clock";
import { redoseActionIsPrimary, redoseCardLabel } from "@/lib/redose-format";
import { parseUtcSql } from "@/lib/date";
import type { TimeFormat } from "@/lib/format-date";

// Dashboard quick-log widget for PRN (as-needed) medications (#797). The one-tap
// retro-entry home: each active PRN med gets a "Taken now" button plus retro offsets
// (30m/1h ago, or a specific time). The per-day count + last time is computed here
// (server, with the profile tz) and passed down so the client control stays a thin
// formatter over one server computation. Rendered only when the profile has active
// PRN meds — the empty state is the data-aware onboarding CTA (page.tsx).
export default function QuickLogPrnWidget({
  meds,
  tz,
  profileId,
  timeFormat,
}: {
  meds: PrnMedForQuickLog[];
  tz: string;
  // The cross-profile write target (issue #879) — when this widget hosts a household
  // member's episode page, each PRN log posts it so the action gates on THAT profile
  // (requireProfileWriteAccess). Absent on the dashboard/active-profile mounts.
  profileId?: number;
  timeFormat?: TimeFormat;
}) {
  return (
    <div className="card">
      <QuickLogPrnContent
        meds={meds}
        tz={tz}
        profileId={profileId}
        timeFormat={timeFormat}
      />
    </div>
  );
}

// The dashboard owns the standalone card above. Other pages can compose the
// same dose controls inside a grouped card without a one-off styling flag.
export function QuickLogPrnContent({
  meds,
  tz,
  title = "Log a dose",
  profileId,
  headingVariant = "card",
  compact = false,
  rowVariant = "inset",
  headerAction,
  intro,
  emptyMessage,
  titleHref,
  showPageLink = true,
  timeFormat,
  nowIso,
}: {
  meds: PrnMedForQuickLog[];
  tz: string;
  title?: string;
  profileId?: number;
  headingVariant?: "card" | "section";
  compact?: boolean;
  rowVariant?: "inset" | "embedded";
  headerAction?: ReactNode;
  intro?: ReactNode;
  emptyMessage?: string;
  titleHref?: AppRoute;
  showPageLink?: boolean;
  timeFormat?: TimeFormat;
  // The redose-window "now", as an ISO instant from the nearest SERVER boundary.
  // REQUIRED whenever this content is mounted under a "use client" parent (the
  // illness cockpit/episode logger): in the browser, lib/clock's env override
  // doesn't exist, so a locally-computed now diverges from the clock-stamped
  // given_at under ALLOS_TEST_NOW (the frozen e2e clock). Server mounts may omit
  // it (the local clockNow() below is the same server clock).
  nowIso?: string;
}) {
  // The frozen-clock seam (#1005): given_at is stamped through lib/clock, so the
  // elapsed-window "now" must come from the same source (a production no-op). A
  // client-mounted content receives the server's now via nowIso (see prop note).
  const now = nowIso ? new Date(nowIso) : clockNow();
  // The redose status line (#798), when the med has confirmed interval/max and
  // something's been logged. Same redoseCardLabel the medications card uses (one
  // computation, so the widget and card never disagree). Marker-agnostic — the card
  // always shows current window state regardless of the one-shot notification marker.
  // Family-widened window math (#1027): the clock/count/max span the ingredient
  // family (an OTC ibuprofen dose holds the Rx item's "Redose OK"), with the
  // "across N items" tail marking a cross-item counter.
  const redoseStatusFor = (m: PrnMedForQuickLog) => {
    if (
      m.minIntervalHours == null ||
      m.maxDailyCount == null ||
      !m.familyLastGivenAt
    ) {
      return null;
    }
    return redoseWindowStatus({
      minIntervalHours: m.minIntervalHours,
      maxDailyCount: Math.min(
        m.maxDailyCount,
        m.familyMaxDailyCount ?? m.maxDailyCount
      ),
      latestGivenAt: parseUtcSql(m.familyLastGivenAt),
      countToday: m.familyCount,
      now,
    });
  };
  const visibleMeds = compact ? meds.slice(0, 3) : meds;
  const remainingMeds = compact ? meds.slice(3) : [];
  const medControl = (m: PrnMedForQuickLog) => {
    const lastClock = formatGivenAtClockWithRelativeAge(
      tz,
      m.lastGivenAt,
      timeFormat,
      now
    );
    const redoseStatus = redoseStatusFor(m);
    const redoseLine = redoseCardLabel(redoseStatus, m.familyMemberCount);
    return (
      <QuickLogPrnControl
        key={m.id}
        itemId={m.id}
        name={m.name}
        doseAmount={m.amount}
        product={m.product}
        dayLabel={
          redoseLine
            ? administrationLastDoseLabel(m.count, lastClock)
            : administrationDayLabel(m.count, lastClock)
        }
        redoseLine={redoseLine}
        redosePrimary={redoseActionIsPrimary(redoseStatus)}
        linkToDetail
        profileId={profileId}
        rowVariant={rowVariant}
      />
    );
  };

  return (
    <div data-testid="quick-log-prn">
      <WidgetHeader
        title={title}
        href="/medications"
        variant={headingVariant}
        action={headerAction}
        titleHref={titleHref}
        showPageLink={showPageLink}
      />
      {intro}
      {meds.length === 0 && emptyMessage ? (
        <p
          data-testid="quick-log-prn-empty"
          className="mb-3 text-xs text-slate-500 dark:text-slate-400"
        >
          {emptyMessage}
        </p>
      ) : null}
      <div
        className={
          rowVariant === "embedded" ? "flex flex-col" : "flex flex-col gap-2"
        }
      >
        {visibleMeds.map(medControl)}
        {remainingMeds.length > 0 && (
          <details data-testid="quick-log-prn-more">
            <summary className="cursor-pointer py-1 text-sm font-medium text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100">
              More medications ({remainingMeds.length})
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {remainingMeds.map(medControl)}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
