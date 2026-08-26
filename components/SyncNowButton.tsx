"use client";

import { syncNow } from "@/app/(app)/integrations/sync-actions";
import IntegrationActionButton from "@/components/integrations/IntegrationActionButton";
import type { IntegrationId } from "@/lib/types";

export default function SyncNowButton(props: { sourceId: IntegrationId }) {
  const { sourceId } = props;
  return (
    <IntegrationActionButton
      binding={{
        action: () => syncNow(sourceId),
        copy: ["Sync now", "Syncing…"],
        control: { icon: "sync", testId: `sync-now-${sourceId}` },
      }}
    />
  );
}
