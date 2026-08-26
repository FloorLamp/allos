"use client";

import { syncNow } from "@/app/(app)/integrations/sync-actions";
import IntegrationActionButton from "@/components/integrations/IntegrationActionButton";
import type { IntegrationId } from "@/lib/types";

export default function SyncNowButton({
  sourceId,
}: {
  sourceId: IntegrationId;
}) {
  return (
    <IntegrationActionButton
      binding={{
        action: () => syncNow(sourceId),
        label: "Sync now",
        pendingLabel: "Syncing…",
        icon: "sync",
        testId: `sync-now-${sourceId}`,
      }}
    />
  );
}
