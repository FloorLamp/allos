"use client";

import { useTransition } from "react";
import { IconDatabaseImport, IconRefresh } from "@tabler/icons-react";
import Button from "@/components/Button";
import { useToast } from "@/components/Toast";
import { INTEGRATION_BACKFILL_STARTED_EVENT } from "@/components/integrations/IntegrationBackfillProgress";
import type { IntegrationId } from "@/lib/types";
import { syncNow } from "@/app/(app)/integrations/sync-actions";
import {
  backfillStravaRideDetails,
  recheckStravaEmptySessions,
} from "@/app/(app)/integrations/strava/actions";

type IntegrationActionButtonProps =
  | { kind: "sync"; sourceId: IntegrationId }
  | { kind: "backfill" | "recheck"; count: number };

const copy = {
  sync: ["Sync now", "Syncing…"],
  backfill: ["Backfill session details", "Backfilling…"],
  recheck: ["Re-check sessions with no details", "Re-checking…"],
} as const;

export default function IntegrationActionButton(
  props: IntegrationActionButtonProps
) {
  const [pending, start] = useTransition();
  const toast = useToast();

  if (props.kind === "recheck" && props.count === 0) return null;

  function run() {
    start(async () => {
      const result =
        props.kind === "sync"
          ? await syncNow(props.sourceId)
          : props.kind === "backfill"
            ? await backfillStravaRideDetails()
            : await recheckStravaEmptySessions();
      if (props.kind === "backfill" && result.status === "done") {
        window.dispatchEvent(new Event(INTEGRATION_BACKFILL_STARTED_EVENT));
      }
      toast(result.message, {
        tone: result.status === "error" ? "error" : "success",
      });
    });
  }

  const testId =
    props.kind === "sync"
      ? `sync-now-${props.sourceId}`
      : props.kind === "backfill"
        ? "strava-backfill-details"
        : "strava-recheck-empty";
  const count = props.kind === "sync" ? 0 : props.count;
  const Icon = props.kind === "backfill" ? IconDatabaseImport : IconRefresh;
  const badgeClass =
    "rounded-full bg-slate-100 px-1.5 text-xs text-slate-600 dark:bg-ink-800 dark:text-slate-300";

  return (
    <Button onClick={run} disabled={pending} data-testid={testId}>
      <Icon
        className={`h-4 w-4 ${props.kind === "sync" && pending ? "animate-spin motion-reduce:animate-none" : ""}`}
        stroke={1.75}
      />
      {copy[props.kind][pending ? 1 : 0]}
      {count > 0 && <span className={badgeClass}>{count}</span>}
    </Button>
  );
}
