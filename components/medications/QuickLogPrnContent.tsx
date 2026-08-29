import CardSectionHeader from "@/components/CardSectionHeader";
import QuickLogPrnControl from "@/components/medications/QuickLogPrnControl";
import type { PrnMedForQuickLog } from "@/lib/queries";
import type { ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";
import {
  administrationDayLabel,
  administrationLastDoseLabel,
  formatGivenAtClockWithRelativeAge,
} from "@/lib/administration-format";
import { prnQuickLogRedoseStatus } from "@/lib/prn-redose";
import { now as clockNow } from "@/lib/clock";
import { redoseActionIsPrimary, redoseCardLabel } from "@/lib/redose-format";
import type { TimeFormat } from "@/lib/format-date";
import Disclosure from "@/components/Disclosure";

// PRN (as-needed) medication quick-log content (#797). The one-tap
// retro-entry home: each active PRN med gets a "Taken now" button plus an "Earlier
// dose" statement — an absolute time today via the shared WhenControl (#2236).
// The per-day count + last time is computed here
// (server, with the profile tz) and passed down so the client control stays a thin
// formatter over one server computation. Dashboard candidates and illness context
// compose the same dose controls inside their own card/group shells.
export default function QuickLogPrnContent({
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
  // recorded_at under ALLOS_TEST_NOW (the frozen e2e clock). Server mounts may omit
  // it (the local clockNow() below is the same server clock).
  nowIso?: string;
}) {
  // The frozen-clock seam (#1005): recorded_at is stamped through lib/clock, so the
  // elapsed-window "now" must come from the same source (a production no-op). A
  // client-mounted content receives the server's now via nowIso (see prop note).
  const now = nowIso ? new Date(nowIso) : clockNow();
  // The redose status line (#798), when the med has a confirmed interval and
  // something's been logged. Same redoseCardLabel the medications card uses (one
  // computation, so the shared surfaces never disagree). Marker-agnostic — the card
  // always shows current window state regardless of the one-shot notification marker.
  // Family-widened window math (#1027): the clock/count/max span the ingredient
  // family (an OTC ibuprofen dose holds the Rx item's "Redose OK"), with the
  // "across N items" tail marking a cross-item counter.
  // The window math is the shared prnQuickLogRedoseStatus (#221): this content, the
  // medications list and the Telegram `/dose` list all read one gate, so "the
  // interval alone answers when the next dose is OK" can't drift between them.
  const redoseStatusFor = (m: PrnMedForQuickLog) =>
    prnQuickLogRedoseStatus(m, now);
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
        compactActions={compact}
        tz={tz}
      />
    );
  };

  return (
    <div data-testid="quick-log-prn">
      <CardSectionHeader
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
          /* Deliberately NOT remembered (#2652 behavior 3) — see the "tap path"
             exclusion in lib/disclosure-memory.ts. Per-device state is invisible to the
             server, so a remembered-open fold necessarily opens AFTER hydration, and
             this one sits directly above a Log button. */
          <Disclosure
            data-testid="quick-log-prn-more"
            summaryClassName="py-1 text-sm font-medium text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100"
            summary={<>More medications ({remainingMeds.length})</>}
          >
            <div className="mt-2 flex flex-col gap-2">
              {remainingMeds.map(medControl)}
            </div>
          </Disclosure>
        )}
      </div>
    </div>
  );
}
