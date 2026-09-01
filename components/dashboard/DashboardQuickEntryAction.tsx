"use client";

import Button from "@/components/Button";
import { useQuickEntry } from "@/components/QuickEntryProvider";
import type { QuickEntryForm, QuickEntryPrefill } from "@/lib/quick-log";

// The dashboard row's opener for a quick-entry form (#4076): the row states what the
// offer is, and this is the control it earns. It opens the app's ONE quick-write
// surface rather than mounting a second copy of that form on the dashboard.
export default function DashboardQuickEntryAction({
  form,
  prefill,
  actionLabel = "Log",
}: {
  form: QuickEntryForm;
  prefill?: QuickEntryPrefill;
  actionLabel?: string;
}) {
  const { open } = useQuickEntry();
  return (
    <Button
      data-testid="dashboard-quick-entry-action"
      onClick={() => open(form, prefill)}
    >
      {actionLabel}
    </Button>
  );
}
