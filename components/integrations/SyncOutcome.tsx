import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react";
import type { IntegrationSyncEvent } from "@/lib/types";
import {
  formatSyncOutcome,
  outcomeTone,
  type SyncVocabulary,
} from "@/lib/integrations/provider-state";
import {
  originChoiceLabel,
  parseSyncEventDetails,
} from "@/lib/integrations/sync-details";
import { STATUS_TEXT_TONE } from "./StatusBadge";

// The ONE rendering of "what did this run do" (#1772). Every surface that shows a
// sync outcome — the grid card, the setup-page status header, its history table, and
// Review — renders this component over the pure formatSyncOutcome, so the three
// accountings that used to coexist (formatSplitLabel, the legacy flat `written`
// fallback, and the setup pages' unformatted `last_sync_summary` key:value echo) are
// now one.
export function SyncOutcomeLine({
  ev,
  vocabulary = "records",
  className = "text-sm",
}: {
  ev: IntegrationSyncEvent;
  vocabulary?: SyncVocabulary;
  className?: string;
}) {
  const { primary, muted } = formatSyncOutcome(ev, vocabulary);
  const tone = outcomeTone(ev);
  const Icon = tone === "good" ? IconCircleCheck : IconAlertTriangle;
  const skipped = ev.skipped ?? 0;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <Icon
        className={`h-4 w-4 shrink-0 ${STATUS_TEXT_TONE[tone]}`}
        stroke={1.75}
      />
      <span
        className={
          !ev.ok
            ? "font-medium text-rose-700 dark:text-rose-300"
            : muted
              ? "text-slate-500 dark:text-slate-400"
              : "text-slate-700 dark:text-slate-200"
        }
      >
        {primary}
      </span>
      {/* A truncated run SUCCEEDED as far as it got, but a page cap / rate limit left
          data upstream (#1614) — so it must not read as a clean green success. */}
      {tone === "caution" && ev.ok !== 0 && (
        <span
          className="font-medium text-amber-600 dark:text-amber-400"
          data-testid={`sync-partial-${ev.id}`}
        >
          · partial
        </span>
      )}
      {/* ev.ok is a NUMBER (0/1) — a bare `ev.ok &&` would render a literal "0" on
          failure lines, so coerce it. */}
      {ev.ok !== 0 && skipped > 0 && (
        <span className="text-amber-600 dark:text-amber-400">
          · {skipped} skipped
        </span>
      )}
    </span>
  );
}

// The structured, non-secret diagnostics a run can carry (exporter-shape warnings,
// Health Connect origin reconciliation, the truncation explanation). Shared so the
// setup page's status header, its history table, and Review can't drift.
export function SyncDetailsNotes({ ev }: { ev: IntegrationSyncEvent }) {
  const details = parseSyncEventDetails(ev.details ?? null);
  if (!details) return null;
  return (
    <div
      className="mt-1 space-y-0.5 text-xs text-amber-700 dark:text-amber-300"
      data-testid={`sync-details-${ev.id}`}
    >
      {details.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      {details.origins.map((choice) => (
        <p key={`${choice.date}:${choice.metric}`}>
          {originChoiceLabel(choice)}
        </p>
      ))}
    </div>
  );
}
