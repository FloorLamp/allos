import { MEDICATIONS_HREF, type AppRoute } from "@/lib/hrefs";
import type { OnboardingChecklistSuggestion } from "@/lib/onboarding";

export interface OnboardingChecklistTask {
  label: string;
  href: AppRoute;
}

// The suggested next steps, one per #1284 suggestion key. Data, not markup, since
// #4076: the dashboard renders them in a row's facts column like every other fact,
// so the table is the only part that was ever this component's own.
export const CHECKLIST_TASKS: Record<
  OnboardingChecklistSuggestion,
  OnboardingChecklistTask
> = {
  "medical-records": {
    label: "Import a health record",
    href: "/data?section=import",
  },
  medications: { label: "Check your medications", href: MEDICATIONS_HREF },
  fitness: {
    label: "Connect an app or device",
    href: "/data?section=import#integrations",
  },
  "metrics-labs": { label: "Import medical data", href: "/data?section=import" },
  "preventive-care": {
    label: "Add your next appointment",
    href: "/records/history/visits",
  },
  caregiving: { label: "Review profiles and access", href: "/household" },
  explore: { label: "Add emergency details", href: "/profile#emergency" },
  notifications: {
    label: "Set up notifications",
    href: "/settings/notifications",
  },
};
